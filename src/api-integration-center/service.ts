/**
 * API Integration Center service layer.
 *
 * Rules enforced here:
 *  - every database access goes through a workspace-scoped transaction (RLS);
 *  - no secret is ever returned, logged or written to an audit payload;
 *  - CONNECTED is written only after a real probe from `adapters.ts` succeeded;
 *  - disabled providers and unimplemented adapters can never report CONNECTED.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { withWorkspaceTransaction } from '../../lib/db.js';
import { writeAuditEvent } from '../../lib/audit.js';
import { redactData } from '../../lib/redaction.js';
import {
  getProviderDefinition,
  PROVIDER_DEFINITIONS,
  type ProviderDefinition,
  type ConnectionStatus,
} from './catalog.js';
import {
  decryptCredential,
  encryptCredential,
  credentialStoreAvailable,
} from './crypto.js';
import {
  buildAuthorizationUrl,
  classifyProviderFailure,
  exchangeAuthorizationCode,
  pkceChallenge,
  probeProvider,
  refreshAccessToken,
  type CredentialPayload,
  type ProbeContext,
  type ProbeResult,
} from './adapters.js';
import { discoveryServerPath } from '../discovery.js';

const OAUTH_COOKIE = 'ugc_api_oauth';
const OAUTH_TTL_SECONDS = 10 * 60;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_BASE_COOLDOWN_MS = 30_000;
const CIRCUIT_MAX_COOLDOWN_MS = 15 * 60_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * OAuth providers require an absolute, registered redirect URI. Production
 * deployments must set API_INTEGRATIONS_OAUTH_BASE_URL; local loopback requests
 * may derive it from the validated request origin. User-supplied redirect
 * values are never accepted, preventing open redirects and host injection.
 */
function oauthRedirectUri(defaultPath: string, requestOrigin?: string): string {
  const configured = String(process.env.API_INTEGRATIONS_OAUTH_BASE_URL ?? '').trim();
  const rawBase = configured || String(requestOrigin ?? '').trim();
  if (!rawBase) throw new Error('OAUTH_REDIRECT_BASE_URL_REQUIRED');
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    throw new Error('INVALID_OAUTH_REDIRECT_BASE_URL');
  }
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('INVALID_OAUTH_REDIRECT_BASE_URL');
  if (base.protocol !== 'https:' && !LOOPBACK_HOSTS.has(base.hostname)) throw new Error('INVALID_OAUTH_REDIRECT_BASE_URL');
  const target = new URL(defaultPath, base);
  if (target.origin !== base.origin || target.search || target.hash) throw new Error('INVALID_OAUTH_REDIRECT_BASE_URL');
  return target.toString();
}

interface OAuthCookiePayload {
  state: string;
  verifier?: string | null;
  workspaceId: string;
}

/** Sign the HttpOnly OAuth cookie so the callback can resolve its workspace without a user-supplied query value. */
function signOAuthCookie(payload: OAuthCookiePayload): string {
  const secret = String(process.env.SESSION_JWT_SECRET ?? '');
  if (!secret) throw new Error('OAUTH_COOKIE_MISMATCH');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

/** Validate integrity before trusting any cookie content, including the workspace. */
export function readOAuthCookie(value: string | null): OAuthCookiePayload | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const secret = String(process.env.SESSION_JWT_SECRET ?? '');
  if (!body || !signature || !secret) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.state !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.state)) return null;
    if (typeof parsed.workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(parsed.workspaceId)) return null;
    if (parsed.verifier !== undefined && parsed.verifier !== null && typeof parsed.verifier !== 'string') return null;
    return { state: parsed.state, verifier: parsed.verifier ?? null, workspaceId: parsed.workspaceId };
  } catch {
    return null;
  }
}

type OverrideContext = Partial<ProbeContext> | null;
let testContextOverride: OverrideContext = null;

/** Test-only injection point. Not reachable from any HTTP route. */
export function setProbeContextOverride(value: OverrideContext): void {
  if (process.env.NODE_ENV === 'production') throw new Error('PROBE_OVERRIDE_DISABLED_IN_PRODUCTION');
  testContextOverride = value;
}

function probeContext(extra: ProbeContext = {}): ProbeContext {
  return {
    mcpServerPath: discoveryServerPath(),
    ...(testContextOverride ?? {}),
    ...extra,
  };
}

function statusFromRow(row: any): ConnectionStatus {
  if (!row) return 'NOT_CONFIGURED';
  if (row.enabled === false) return 'DISABLED';
  const status = String(row.status ?? 'NOT_CONFIGURED');
  const allowed: ConnectionStatus[] = ['NOT_CONFIGURED', 'CONFIGURED', 'AUTH_REQUIRED', 'PERMISSION_MISSING', 'CONNECTED', 'TOKEN_EXPIRED', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'PROVIDER_UNAVAILABLE', 'ADAPTER_NOT_IMPLEMENTED', 'DISABLED'];
  return allowed.includes(status as ConnectionStatus) ? status as ConnectionStatus : 'PROVIDER_UNAVAILABLE';
}

function publicConnection(row: any, def: ProviderDefinition, credential: any = null) {
  const source = credential ? 'workspace' : envCredentialSource(def);
  let status = statusFromRow(row);
  if (status === 'CONNECTED' && !credential && source === 'none' && def.authType !== 'none' && def.authType !== 'local') {
    status = 'CONFIGURED';
  }
  if (!def.liveAdapter && status !== 'DISABLED') status = 'ADAPTER_NOT_IMPLEMENTED';
  return {
    provider: def.key,
    status,
    enabled: row?.enabled !== false,
    credentialSource: source,
    credentialHint: credential?.hint ?? null,
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastFailureAt: row?.lastFailureAt ?? null,
    lastErrorCode: row?.lastErrorCode ?? null,
    lastErrorCategory: row?.lastErrorCategory ?? null,
    circuitState: row?.circuitState ?? 'CLOSED',
    cooldownUntil: row?.cooldownUntil ?? null,
    consecutiveFailures: row?.consecutiveFailures ?? 0,
    quota: row?.quota ?? { source: 'not_supplied_by_provider' },
    grantedScopes: Array.isArray(row?.grantedScopes) ? row.grantedScopes.map(String) : [],
    tokenExpiresAt: row?.tokenExpiresAt ?? credential?.expiresAt ?? null,
    connectedAt: row?.connectedAt ?? null,
  };
}

function envCredentialSource(def: ProviderDefinition): 'workspace' | 'environment' | 'none' {
  if (!def.envKeys.length) return 'none';
  const env = process.env;
  return def.envKeys.some((key) => String(env[key] ?? '').trim()) ? 'environment' : 'none';
}

function environmentPayload(def: ProviderDefinition): CredentialPayload {
  const env = process.env;
  const map: Record<string, Record<string, string>> = {
    youtube_google: { clientId: 'YOUTUBE_CLIENT_ID', clientSecret: 'YOUTUBE_CLIENT_SECRET', refreshToken: 'YOUTUBE_REFRESH_TOKEN' },
    youtube_analytics: { clientId: 'YOUTUBE_CLIENT_ID', clientSecret: 'YOUTUBE_CLIENT_SECRET', refreshToken: 'YOUTUBE_REFRESH_TOKEN' },
    tiktok: { clientKey: 'TIKTOK_CLIENT_KEY', clientSecret: 'TIKTOK_CLIENT_SECRET', refreshToken: 'TIKTOK_REFRESH_TOKEN' },
    instagram_meta: { appId: 'INSTAGRAM_APP_ID', appSecret: 'INSTAGRAM_APP_SECRET', accessToken: 'INSTAGRAM_ACCESS_TOKEN', userId: 'INSTAGRAM_USER_ID' },
    ollama_cloud: { apiKey: 'OLLAMA_API_KEY' },
  };
  const mapping = map[def.key] ?? {};
  const payload: CredentialPayload = {};
  for (const [target, source] of Object.entries(mapping)) {
    const value = String(env[source] ?? '').trim();
    if (value) payload[target] = value;
  }
  return payload;
}

async function resolveCredential(workspaceId: string, def: ProviderDefinition): Promise<{ payload: CredentialPayload; source: 'workspace' | 'environment' | 'none'; row: any | null }> {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const row: any = await tx.apiCredential.findUnique({ where: { workspaceId_providerKey: { workspaceId, providerKey: def.key } } });
    if (row) {
      try {
        return { payload: decryptCredential(row, workspaceId, def.key), source: 'workspace' as const, row };
      } catch {
        return { payload: {}, source: 'none' as const, row };
      }
    }
    const payload = environmentPayload(def);
    return { payload, source: Object.keys(payload).length ? 'environment' as const : 'none' as const, row: null };
  });
}

async function writeEvent(workspaceId: string, providerKey: string, type: string, actor: string | null, outcome: string, details: Record<string, unknown> = {}, tx?: any): Promise<void> {
  const safe = redactData(details) as Record<string, unknown>;
  const persist = async (store: any) => {
    await store.apiIntegrationEvent.create({
      data: {
        workspaceId,
        providerKey,
        type,
        actor,
        outcome,
        errorCode: typeof safe.errorCode === 'string' ? safe.errorCode.slice(0, 120) : null,
        errorCategory: typeof safe.errorCategory === 'string' ? safe.errorCategory.slice(0, 120) : null,
        details: safe,
      },
    });
    await writeAuditEvent({ workspaceId, userId: actor, type: `api_integration_${type}`, actor, data: safe, tx: store });
  };
  if (tx) await persist(tx);
  else await withWorkspaceTransaction(workspaceId, persist);
}

export async function ensureApiIntegrationDepartment(workspaceId: string): Promise<{ department: any; agent: any }> {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    let department: any = await tx.department.findUnique({ where: { workspaceId_key: { workspaceId, key: 'api_integration' } } });
    let createdDepartment = false;
    if (!department) {
      createdDepartment = true;
      department = await tx.department.create({
        data: {
          workspaceId,
          key: 'api_integration',
          name: 'API Integration Department',
          description: 'Provider registry, connection health, OAuth lifecycle, credentials, quotas and audit reporting. Reports to CEO/COO.',
          parentKey: 'security',
          allowedTools: ['read_provider_status', 'test_connection', 'read_audit_log'],
          maxConcurrency: 2,
          budgetLimit: 1000,
        },
      });
    }
    const agentName = 'API Integration Lead';
    let agent: any = await tx.agentDefinition.findFirst({ where: { workspaceId, name: agentName } });
    if (!agent) {
      agent = await tx.agentDefinition.create({
        data: { workspaceId, name: agentName, role: 'api_integration', capabilities: ['read_provider_status', 'test_connection', 'read_audit_log'], enabled: true },
      });
    }
    if (createdDepartment) await writeEvent(workspaceId, 'api_integration', 'department_ensured', null, 'ok', { departmentId: department.id }, tx);
    return { department, agent };
  });
}

export async function listProviders(workspaceId: string) {
  await ensureApiIntegrationDepartment(workspaceId);
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const rows: any[] = await tx.apiConnection.findMany({ where: { workspaceId } });
    const credentials: any[] = await tx.apiCredential.findMany({ where: { workspaceId } });
    const byKey = new Map(rows.map((row) => [row.providerKey, row]));
    const credentialByKey = new Map(credentials.map((row) => [row.providerKey, row]));
    const providers = PROVIDER_DEFINITIONS.map((def) => {
      const row = byKey.get(def.key) ?? null;
      const credential = credentialByKey.get(def.key) ?? null;
      return {
        ...def,
        connection: publicConnection(row, def, credential),
        credentialStoreAvailable: credentialStoreAvailable(),
      };
    });
    return {
      providers,
      credentialStoreAvailable: credentialStoreAvailable(),
      statuses: PROVIDER_DEFINITIONS.map((p) => p.key),
      department: 'api_integration',
    };
  });
}

export async function getProviderDetail(workspaceId: string, providerKey: string) {
  const def = getProviderDefinition(providerKey);
  if (!def) return null;
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const row: any = await tx.apiConnection.findUnique({ where: { workspaceId_providerKey: { workspaceId, providerKey } } });
    const credential: any = await tx.apiCredential.findUnique({ where: { workspaceId_providerKey: { workspaceId, providerKey } } });
    const events: any[] = await tx.apiIntegrationEvent.findMany({
      where: { workspaceId, providerKey },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return {
      ...def,
      connection: publicConnection(row, def, credential),
      credentialStoreAvailable: credentialStoreAvailable(),
      history: events.map((event) => ({
        id: event.id,
        type: event.type,
        actor: event.actor,
        outcome: event.outcome,
        errorCode: event.errorCode,
        errorCategory: event.errorCategory,
        createdAt: event.createdAt,
      })),
    };
  });
}

export async function listHistory(workspaceId: string, providerKey: string, limit = 100) {
  const def = getProviderDefinition(providerKey);
  if (!def) return null;
  const take = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const rows: any[] = await tx.apiIntegrationEvent.findMany({ where: { workspaceId, providerKey }, orderBy: { createdAt: 'desc' }, take });
    return { events: rows.map((event) => ({ id: event.id, type: event.type, actor: event.actor, outcome: event.outcome, errorCode: event.errorCode, errorCategory: event.errorCategory, createdAt: event.createdAt, details: event.details ?? null })) };
  });
}

export async function saveCredentials(workspaceId: string, providerKey: string, body: Record<string, unknown>, actor: string) {
  const def = getProviderDefinition(providerKey);
  if (!def) return null;
  if (!credentialStoreAvailable()) throw new Error('CREDENTIAL_STORE_NOT_CONFIGURED');
  if (def.credentialFields.length === 0) throw new Error('PROVIDER_HAS_NO_CREDENTIAL_FIELDS');

  const payload: CredentialPayload = {};
  for (const field of def.credentialFields) {
    const raw = body[field.key];
    if (field.required && (raw === undefined || raw === null || String(raw).trim() === '')) throw new Error(`MISSING_FIELD_${field.key.toUpperCase()}`);
    if (raw !== undefined && raw !== null) payload[field.key] = String(raw).trim();
  }
  const encrypted = encryptCredential(payload, workspaceId, providerKey);
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const existing: any = await tx.apiConnection.findUnique({ where: { workspaceId_providerKey: { workspaceId, providerKey } } });
    const credential: any = await tx.apiCredential.upsert({
      where: { workspaceId_providerKey: { workspaceId, providerKey } },
      create: { workspaceId, providerKey, kind: def.oauth ? 'OAUTH' : def.authType === 'api_key' ? 'API_KEY' : 'TOKEN', ...encrypted, expiresAt: null },
      update: { kind: def.oauth ? 'OAUTH' : def.authType === 'api_key' ? 'API_KEY' : 'TOKEN', ...encrypted, expiresAt: null },
    });
    const stillEnabled = existing?.enabled !== false;
    const status: ConnectionStatus = stillEnabled ? 'CONFIGURED' : 'DISABLED';
    const connection: any = await tx.apiConnection.upsert({
      where: { workspaceId_providerKey: { workspaceId, providerKey } },
      create: { workspaceId, providerKey, status, enabled: stillEnabled, credentialId: credential.id, consecutiveFailures: 0, circuitState: 'CLOSED', cooldownUntil: null, lastErrorCode: null, lastErrorCategory: null, connectedAt: null, grantedScopes: [] },
      update: { status, credentialId: credential.id, consecutiveFailures: 0, circuitState: 'CLOSED', cooldownUntil: null, lastErrorCode: null, lastErrorCategory: null, connectedAt: null, quota: null },
    });
    await writeEvent(workspaceId, providerKey, 'credentials_saved', actor, 'ok', { hint: encrypted.hint, status }, tx);
    return { ...def, connection: publicConnection(connection, def, credential) };
  });
}

function circuitBackoff(failures: number): number {
  return Math.min(CIRCUIT_MAX_COOLDOWN_MS, CIRCUIT_BASE_COOLDOWN_MS * Math.pow(2, Math.max(0, failures - CIRCUIT_FAILURE_THRESHOLD)));
}

export async function testConnection(workspaceId: string, providerKey: string, actor: string, extra: ProbeContext = {}) {
  const def = getProviderDefinition(providerKey);
  if (!def) return null;
  const now = extra.now ?? new Date();
  const current = await withWorkspaceTransaction(workspaceId, async (tx) => {
    const row: any = await tx.apiConnection.findUnique({ where: { workspaceId_providerKey: { workspaceId, providerKey } } });
    return row;
  });

  if (current?.enabled === false) {
    const blocked = probe('DISABLED', { errorCode: 'PROVIDER_DISABLED', errorCategory: 'configuration' });
    await recordProbeOutcome(workspaceId, def, current, blocked, actor, now);
    return { status: 'DISABLED', errorCode: 'PROVIDER_DISABLED', retryable: false, cooldown: false };
  }
  if (current?.circuitState === 'OPEN' && current.cooldownUntil && new Date(current.cooldownUntil).getTime() > now.getTime()) {
    await writeEvent(workspaceId, providerKey, 'test_blocked', actor, 'cooldown', { errorCode: 'PROVIDER_COOLDOWN' });
    return { status: 'PROVIDER_UNAVAILABLE', errorCode: 'PROVIDER_COOLDOWN', retryable: false, cooldown: true };
  }

  const resolved = await resolveCredential(workspaceId, def);
  if (!def.liveAdapter) {
    const blocked = probe('ADAPTER_NOT_IMPLEMENTED', { errorCode: 'ADAPTER_NOT_IMPLEMENTED', errorCategory: 'capability' });
    await recordProbeOutcome(workspaceId, def, current, blocked, actor, now);
    return { status: blocked.status, errorCode: blocked.errorCode, retryable: false, cooldown: false };
  }
  if (!resolved.payload || Object.keys(resolved.payload).length === 0) {
    const blocked = def.authType === 'local' || def.authType === 'none'
      ? probe('PROVIDER_UNAVAILABLE', { errorCode: 'PROVIDER_NOT_CONFIGURED', errorCategory: 'configuration' })
      : probe('AUTH_REQUIRED', { errorCode: 'AUTH_REQUIRED', errorCategory: 'auth' });
    await recordProbeOutcome(workspaceId, def, current, blocked, actor, now);
    return { status: blocked.status, errorCode: blocked.errorCode, retryable: false, cooldown: false };
  }

  const result = await probeProvider(providerKey, resolved.payload, probeContext(extra));
  await recordProbeOutcome(workspaceId, def, current, result, actor, now);

  // Persist refreshed OAuth tokens only after a real token endpoint response.
  if (result.status === 'CONNECTED' && resolved.source === 'workspace' && resolved.row && def.oauth) {
    const updated = encryptCredential(resolved.payload, workspaceId, providerKey);
    await withWorkspaceTransaction(workspaceId, (tx) => tx.apiCredential.update({
      where: { id: resolved.row.id },
      data: { ...updated, expiresAt: resolved.payload.expiresAt ? new Date(String(resolved.payload.expiresAt)) : null },
    }));
  }
  return {
    status: result.status,
    errorCode: result.errorCode,
    errorCategory: result.errorCategory,
    retryable: result.retryable,
    cooldown: false,
    detail: result.detail,
  };
}

function probe(status: ConnectionStatus, options: Partial<Omit<ProbeResult, 'status'>> = {}): ProbeResult {
  return { status, errorCode: null, errorCategory: null, retryable: false, quota: null, grantedScopes: [], tokenExpiresAt: null, detail: null, ...options };
}

async function recordProbeOutcome(workspaceId: string, def: ProviderDefinition, row: any, result: ProbeResult, actor: string, now: Date): Promise<void> {
  const connected = result.status === 'CONNECTED';
  const failures = connected ? 0 : Number(row?.consecutiveFailures ?? 0) + 1;
  const open = !connected && failures >= CIRCUIT_FAILURE_THRESHOLD;
  const cooldownUntil = open ? new Date(now.getTime() + circuitBackoff(failures)) : connected ? null : row?.cooldownUntil ?? null;
  await withWorkspaceTransaction(workspaceId, async (tx) => {
    await tx.apiConnection.upsert({
      where: { workspaceId_providerKey: { workspaceId, providerKey: def.key } },
      create: {
        workspaceId,
        providerKey: def.key,
        status: result.status,
        enabled: row?.enabled !== false,
        consecutiveFailures: failures,
        circuitState: open ? 'OPEN' : connected ? 'CLOSED' : row?.circuitState ?? 'CLOSED',
        cooldownUntil,
        lastSuccessAt: connected ? now : row?.lastSuccessAt ?? null,
        lastFailureAt: connected ? row?.lastFailureAt ?? null : now,
        lastErrorCode: connected ? null : result.errorCode,
        lastErrorCategory: connected ? null : result.errorCategory,
        quota: result.quota ?? row?.quota ?? null,
        grantedScopes: result.grantedScopes ?? [],
        tokenExpiresAt: result.tokenExpiresAt ? new Date(result.tokenExpiresAt) : row?.tokenExpiresAt ?? null,
        connectedAt: connected ? now : row?.connectedAt ?? null,
      },
      update: {
        status: result.status,
        consecutiveFailures: failures,
        circuitState: open ? 'OPEN' : connected ? 'CLOSED' : row?.circuitState ?? 'CLOSED',
        cooldownUntil,
        lastSuccessAt: connected ? now : row?.lastSuccessAt ?? null,
        lastFailureAt: connected ? row?.lastFailureAt ?? null : now,
        lastErrorCode: connected ? null : result.errorCode,
        lastErrorCategory: connected ? null : result.errorCategory,
        quota: result.quota ?? row?.quota ?? null,
        grantedScopes: result.grantedScopes ?? [],
        tokenExpiresAt: result.tokenExpiresAt ? new Date(result.tokenExpiresAt) : row?.tokenExpiresAt ?? null,
        connectedAt: connected ? now : row?.connectedAt ?? null,
      },
    });
    await writeEvent(workspaceId, def.key, connected ? 'test_succeeded' : 'test_failed', actor, connected ? 'connected' : result.status, {
      errorCode: result.errorCode,
      errorCategory: result.errorCategory,
      detail: result.detail,
    }, tx);
  });
}

export async function refreshConnection(workspaceId: string, providerKey: string, actor: string, extra: ProbeContext = {}) {
  const def = getProviderDefinition(providerKey);
  if (!def?.oauth) return null;
  const resolved = await resolveCredential(workspaceId, def);
  if (resolved.source !== 'workspace') throw new Error('NO_STORED_OAUTH_CREDENTIAL');
  const refreshToken = String(resolved.payload.refreshToken ?? '').trim();
  if (!refreshToken) throw new Error('NO_REFRESH_TOKEN');
  const token = await refreshAccessToken(def, {
    refreshToken,
    clientId: String(resolved.payload.clientId ?? resolved.payload.clientKey ?? resolved.payload.appId ?? ''),
    clientSecret: String(resolved.payload.clientSecret ?? resolved.payload.appSecret ?? ''),
  }, probeContext(extra));
  resolved.payload.accessToken = token.accessToken;
  if (token.refreshToken) resolved.payload.refreshToken = token.refreshToken;
  resolved.payload.expiresAt = token.expiresAt;
  const encrypted = encryptCredential(resolved.payload, workspaceId, providerKey);
  await withWorkspaceTransaction(workspaceId, async (tx) => {
    await tx.apiCredential.update({
      where: { id: resolved.row.id },
      data: { ...encrypted, expiresAt: token.expiresAt ? new Date(token.expiresAt) : null },
    });
    await tx.apiConnection.upsert({
      where: { workspaceId_providerKey: { workspaceId, providerKey } },
      create: { workspaceId, providerKey, status: 'CONFIGURED', credentialId: resolved.row.id, tokenExpiresAt: token.expiresAt ? new Date(token.expiresAt) : null, grantedScopes: token.scopes },
      update: { status: 'CONFIGURED', tokenExpiresAt: token.expiresAt ? new Date(token.expiresAt) : null, lastErrorCode: null, lastErrorCategory: null, consecutiveFailures: 0, circuitState: 'CLOSED', cooldownUntil: null, grantedScopes: token.scopes },
    });
    await writeEvent(workspaceId, providerKey, 'token_refreshed', actor, 'ok', { expiresAt: token.expiresAt, scopes: token.scopes }, tx);
  });
  return { status: 'CONFIGURED', tokenExpiresAt: token.expiresAt };
}

export async function setProviderEnabled(workspaceId: string, providerKey: string, enabled: boolean, actor: string) {
  const def = getProviderDefinition(providerKey);
  if (!def) return null;
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const credential: any = await tx.apiCredential.findUnique({ where: { workspaceId_providerKey: { workspaceId, providerKey } } });
    const status: ConnectionStatus = !enabled
      ? 'DISABLED'
      : credential ? 'CONFIGURED' : 'NOT_CONFIGURED';
    const connection: any = await tx.apiConnection.upsert({
      where: { workspaceId_providerKey: { workspaceId, providerKey } },
      create: { workspaceId, providerKey, status, enabled, credentialId: credential?.id ?? null },
      update: { status, enabled, credentialId: credential?.id ?? null },
    });
    await writeEvent(workspaceId, providerKey, enabled ? 'enabled' : 'disabled', actor, enabled ? 'ok' : 'disabled', { status }, tx);
    return { ...def, connection: publicConnection(connection, def, credential) };
  });
}

export async function disconnectProvider(workspaceId: string, providerKey: string, actor: string) {
  const def = getProviderDefinition(providerKey);
  if (!def) return null;
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    await tx.apiCredential.deleteMany({ where: { workspaceId, providerKey } });
    const connection: any = await tx.apiConnection.upsert({
      where: { workspaceId_providerKey: { workspaceId, providerKey } },
      create: { workspaceId, providerKey, status: 'NOT_CONFIGURED', enabled: true, credentialId: null },
      update: { status: 'NOT_CONFIGURED', credentialId: null, connectedAt: null, tokenExpiresAt: null, lastErrorCode: null, lastErrorCategory: null, consecutiveFailures: 0, circuitState: 'CLOSED', cooldownUntil: null, grantedScopes: [] },
    });
    await writeEvent(workspaceId, providerKey, 'disconnected', actor, 'ok', { status: 'NOT_CONFIGURED' }, tx);
    return { ...def, connection: publicConnection(connection, def, null) };
  });
}

export interface OAuthStartResult {
  authorizationUrl: string;
  redirectUri: string;
  state: string;
  expiresAt: string;
  cookie: string;
}

/** Absolute URI the user must register in the provider's developer portal. */
export function oauthRedirectUriFor(providerKey: string, requestOrigin?: string): string | null {
  const def = getProviderDefinition(providerKey);
  if (!def?.oauth) return null;
  return oauthRedirectUri(def.oauth.defaultRedirectPath, requestOrigin);
}

export async function startOAuth(workspaceId: string, providerKey: string, userId: string, requestOrigin?: string): Promise<OAuthStartResult | null> {
  const def = getProviderDefinition(providerKey);
  if (!def?.oauth) return null;
  const resolved = await resolveCredential(workspaceId, def);
  const clientId = String(resolved.payload.clientId ?? resolved.payload.clientKey ?? resolved.payload.appId ?? '').trim();
  if (!clientId) throw new Error('OAUTH_CLIENT_ID_REQUIRED');
  const state = randomBytes(24).toString('base64url');
  const verifier = def.oauth.pkce ? randomBytes(32).toString('base64url') : null;
  const challenge = verifier ? pkceChallenge(verifier) : null;
  const expiresAt = new Date(Date.now() + OAUTH_TTL_SECONDS * 1000);
  const targetRedirect = oauthRedirectUri(def.oauth.defaultRedirectPath, requestOrigin);
  await withWorkspaceTransaction(workspaceId, async (tx) => {
    await tx.oAuthAuthorization.create({
      data: {
        stateHash: createHash('sha256').update(state).digest('hex'),
        workspaceId,
        providerKey,
        userId,
        codeChallenge: challenge,
        redirectUri: targetRedirect,
        scopes: def.oauth!.scopes.join(' '),
        expiresAt,
      },
    });
    await writeEvent(workspaceId, providerKey, 'oauth_started', userId, 'ok', { expiresAt: expiresAt.toISOString(), pkce: Boolean(challenge) }, tx);
  });
  const authorizationUrl = buildAuthorizationUrl(def, { clientId, redirectUri: targetRedirect, state, codeChallenge: challenge });
  const cookieValue = signOAuthCookie({ state, verifier, workspaceId });
  return {
    authorizationUrl,
    redirectUri: targetRedirect,
    state,
    expiresAt: expiresAt.toISOString(),
    cookie: `${OAUTH_COOKIE}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_TTL_SECONDS}`,
  };
}

export function oauthCookieName(): string {
  return OAUTH_COOKIE;
}

export async function completeOAuth(workspaceId: string, providerKey: string, state: string, code: string, cookieValue: string | null, actor: string) {
  const def = getProviderDefinition(providerKey);
  if (!def?.oauth) return null;
  const stateHash = createHash('sha256').update(String(state)).digest('hex');
  const now = new Date();
  let record: any = null;
  await withWorkspaceTransaction(workspaceId, async (tx) => {
    record = await tx.oAuthAuthorization.findUnique({ where: { stateHash } });
    if (!record || record.consumedAt || record.expiresAt <= now || record.workspaceId !== workspaceId || record.providerKey !== providerKey || record.userId !== actor) {
      record = null;
    }
  });
  if (!record) throw new Error('INVALID_OAUTH_STATE');

  const cookie = readOAuthCookie(cookieValue);
  if (!cookie || cookie.state !== state || cookie.workspaceId !== workspaceId) throw new Error('OAUTH_COOKIE_MISMATCH');
  if (record.codeChallenge) {
    if (!cookie.verifier || pkceChallenge(cookie.verifier) !== record.codeChallenge) throw new Error('PKCE_VERIFICATION_FAILED');
  }

  // Consume only after all local validations succeeded. This prevents a
  // session holder without the matching cookie/PKCE verifier from burning a
  // legitimate authorization state before the real callback arrives.
  await withWorkspaceTransaction(workspaceId, async (tx) => {
    const fresh: any = await tx.oAuthAuthorization.findUnique({ where: { id: record.id } });
    if (!fresh || fresh.consumedAt) throw new Error('INVALID_OAUTH_STATE');
    await tx.oAuthAuthorization.update({ where: { id: record.id }, data: { consumedAt: now } });
  });

  const resolved = await resolveCredential(workspaceId, def);
  const token = await exchangeAuthorizationCode(def, {
    code: String(code),
    clientId: String(resolved.payload.clientId ?? resolved.payload.clientKey ?? resolved.payload.appId ?? ''),
    clientSecret: String(resolved.payload.clientSecret ?? resolved.payload.appSecret ?? ''),
    redirectUri: record.redirectUri,
    codeVerifier: cookie.verifier ?? null,
  }, probeContext());

  if (!credentialStoreAvailable()) throw new Error('CREDENTIAL_STORE_NOT_CONFIGURED');
  const payload: CredentialPayload = {
    ...resolved.payload,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? String(resolved.payload.refreshToken ?? ''),
    expiresAt: token.expiresAt,
    scopes: token.scopes,
  };
  const encrypted = encryptCredential(payload, workspaceId, providerKey);
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const credential: any = await tx.apiCredential.upsert({
      where: { workspaceId_providerKey: { workspaceId, providerKey } },
      create: { workspaceId, providerKey, kind: 'OAUTH', ...encrypted, expiresAt: token.expiresAt ? new Date(token.expiresAt) : null },
      update: { kind: 'OAUTH', ...encrypted, expiresAt: token.expiresAt ? new Date(token.expiresAt) : null },
    });
    const connection: any = await tx.apiConnection.upsert({
      where: { workspaceId_providerKey: { workspaceId, providerKey } },
      create: { workspaceId, providerKey, status: 'CONFIGURED', enabled: true, credentialId: credential.id, grantedScopes: token.scopes, tokenExpiresAt: token.expiresAt ? new Date(token.expiresAt) : null },
      update: { status: 'CONFIGURED', credentialId: credential.id, grantedScopes: token.scopes, tokenExpiresAt: token.expiresAt ? new Date(token.expiresAt) : null, connectedAt: null, consecutiveFailures: 0, circuitState: 'CLOSED', cooldownUntil: null },
    });
    await writeEvent(workspaceId, providerKey, 'oauth_completed', actor, 'configured', { expiresAt: token.expiresAt, scopes: token.scopes }, tx);
    return { ...def, connection: publicConnection(connection, def, credential) };
  });
}

export async function getHealthSummary(workspaceId: string) {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const rows: any[] = await tx.apiConnection.findMany({ where: { workspaceId } });
    const byStatus: Record<string, number> = {};
    for (const row of rows) byStatus[statusFromRow(row)] = (byStatus[statusFromRow(row)] ?? 0) + 1;
    const stored = new Set(rows.map((row) => row.providerKey));
    const missing = PROVIDER_DEFINITIONS.filter((def) => !stored.has(def.key)).length;
    if (missing > 0) byStatus.NOT_CONFIGURED = (byStatus.NOT_CONFIGURED ?? 0) + missing;
    const recentFailures: any[] = await tx.apiIntegrationEvent.findMany({
      where: { workspaceId, type: 'test_failed' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    return {
      credentialStoreAvailable: credentialStoreAvailable(),
      providersTotal: PROVIDER_DEFINITIONS.length,
      byStatus,
      openCircuits: rows.filter((row) => row.circuitState === 'OPEN').length,
      lastSuccessAt: rows.reduce<string | null>((latest, row) => {
        const value = row.lastSuccessAt ? new Date(row.lastSuccessAt).toISOString() : null;
        return value && (!latest || value > latest) ? value : latest;
      }, null),
      recentFailures: recentFailures.map((event) => ({ provider: event.providerKey, errorCode: event.errorCode, createdAt: event.createdAt })),
    };
  });
}

/** Exported for deterministic unit tests of error classification. */
export { classifyProviderFailure };

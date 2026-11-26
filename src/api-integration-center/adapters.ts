/**
 * Live provider adapters. Every CONNECTED result requires a real, reproducible
 * call to an official endpoint (or a verified local adapter). No credentials,
 * response bodies or URLs containing tokens are logged here.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getProviderDefinition, type ConnectionStatus, type ProviderDefinition } from './catalog.js';
import { computeBackoffMs } from '../jobs.js';
import { McpStdioClient } from '../mcp-client.js';
import { assertPublicHttpsUrl, type PublishingLookup } from '../publishing-adapters.js';

export type CredentialPayload = Record<string, unknown>;

export interface ProbeContext {
  fetchImpl?: typeof fetch;
  lookup?: PublishingLookup;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  mcpServerPath?: string | null;
  freeModelsFile?: string;
}

export interface ProbeResult {
  status: ConnectionStatus;
  errorCode: string | null;
  errorCategory: string | null;
  retryable: boolean;
  quota: Record<string, unknown> | null;
  grantedScopes: string[];
  tokenExpiresAt: string | null;
  detail: string | null;
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PROBE_ATTEMPTS = 3;

function stringValue(payload: CredentialPayload, key: string): string {
  return String(payload[key] ?? '').trim();
}

function probe(status: ConnectionStatus, options: Partial<Omit<ProbeResult, 'status'>> = {}): ProbeResult {
  return {
    status,
    errorCode: options.errorCode ?? null,
    errorCategory: options.errorCategory ?? null,
    retryable: options.retryable ?? false,
    quota: options.quota ?? null,
    grantedScopes: options.grantedScopes ?? [],
    tokenExpiresAt: options.tokenExpiresAt ?? null,
    detail: options.detail ?? null,
  };
}

/** Deterministic classification of upstream failures; no secret material is kept. */
export function classifyProviderFailure(input: { status?: number; body?: string; code?: string }): ProbeResult {
  const status = typeof input.status === 'number' ? input.status : null;
  const body = String(input.body ?? '').toLowerCase();
  if (status === 401) return probe('TOKEN_EXPIRED', { errorCode: 'TOKEN_EXPIRED', errorCategory: 'auth', retryable: false });
  if (status === 402 || /quota|insufficient quota|billing|credits/.test(body)) {
    return probe('QUOTA_EXHAUSTED', { errorCode: 'QUOTA_EXHAUSTED', errorCategory: 'quota', retryable: false });
  }
  if (status === 403) return probe('PERMISSION_MISSING', { errorCode: 'PERMISSION_MISSING', errorCategory: 'permission', retryable: false });
  if (status === 429 || /rate limit|too many requests/.test(body)) {
    return probe('RATE_LIMITED', { errorCode: 'RATE_LIMITED', errorCategory: 'rate_limit', retryable: true });
  }
  if (status !== null && status >= 500) {
    return probe('PROVIDER_UNAVAILABLE', { errorCode: `UPSTREAM_${status}`, errorCategory: 'transient', retryable: true });
  }
  if (input.code) return probe('PROVIDER_UNAVAILABLE', { errorCode: input.code.slice(0, 120), errorCategory: 'unknown', retryable: false });
  return probe('PROVIDER_UNAVAILABLE', { errorCode: status ? `UPSTREAM_${status}` : 'NETWORK_ERROR', errorCategory: status ? 'unknown' : 'network', retryable: !status });
}

/** Only values actually returned by the provider are stored. */
function quotaFromHeaders(headers: Headers): Record<string, unknown> | null {
  const remaining = headers.get('x-ratelimit-remaining') ?? headers.get('ratelimit-remaining') ?? headers.get('x-quota-remaining');
  const retryAfter = headers.get('retry-after');
  if (!remaining && !retryAfter) return null;
  return {
    source: 'provider_response_headers',
    remaining: remaining !== null && Number.isFinite(Number(remaining)) ? Number(remaining) : null,
    retryAfterSeconds: retryAfter !== null && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) : null,
  };
}

async function fetchJson(url: string, init: RequestInit, ctx: ProbeContext): Promise<{ response: Response; json: any } | ProbeResult> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) return classifyProviderFailure({ status: response.status, body: text.slice(0, 2_000) });
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { return probe('PROVIDER_UNAVAILABLE', { errorCode: 'INVALID_PROVIDER_RESPONSE', errorCategory: 'unknown', retryable: false }); }
    return { response, json };
  } catch (error) {
    const code = (error as Error)?.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'NETWORK_ERROR';
    return probe('PROVIDER_UNAVAILABLE', { errorCode: code, errorCategory: 'network', retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureAccessToken(credential: CredentialPayload, def: ProviderDefinition, ctx: ProbeContext): Promise<string | null> {
  const existing = stringValue(credential, 'accessToken');
  const expiresAt = stringValue(credential, 'expiresAt');
  const expired = !expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= (ctx.now ?? new Date()).getTime() + 30_000;
  if (existing && !expired) return existing;
  const refreshToken = stringValue(credential, 'refreshToken');
  if (!refreshToken || !def.oauth) return null;
  try {
    const refreshed = await refreshAccessToken(def, {
      refreshToken,
      clientId: stringValue(credential, 'clientId') || stringValue(credential, 'clientKey') || stringValue(credential, 'appId'),
      clientSecret: stringValue(credential, 'clientSecret') || stringValue(credential, 'appSecret'),
    }, ctx);
    credential.accessToken = refreshed.accessToken;
    credential.refreshToken = refreshed.refreshToken ?? refreshToken;
    credential.expiresAt = refreshed.expiresAt;
    return refreshed.accessToken;
  } catch {
    return null;
  }
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

async function probeGoogleYouTube(credential: CredentialPayload, def: ProviderDefinition, ctx: ProbeContext): Promise<ProbeResult> {
  const token = await ensureAccessToken(credential, def, ctx);
  if (!token) return probe('AUTH_REQUIRED', { errorCode: 'AUTH_REQUIRED', errorCategory: 'auth', detail: 'No usable OAuth access token.' });
  const result = await fetchJson('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', { headers: bearer(token) }, ctx);
  if ('status' in result) return result;
  if (!Array.isArray(result.json?.items)) return probe('PROVIDER_UNAVAILABLE', { errorCode: 'INVALID_PROVIDER_RESPONSE', errorCategory: 'unknown', retryable: false });
  return probe('CONNECTED', {
    quota: quotaFromHeaders(result.response.headers),
    grantedScopes: Array.isArray(result.json?.scopes) ? result.json.scopes.map(String) : [],
    detail: 'channels.list responded successfully.',
  });
}

async function probeGoogleAnalytics(credential: CredentialPayload, def: ProviderDefinition, ctx: ProbeContext): Promise<ProbeResult> {
  const token = await ensureAccessToken(credential, def, ctx);
  if (!token) return probe('AUTH_REQUIRED', { errorCode: 'AUTH_REQUIRED', errorCategory: 'auth' });
  const now = ctx.now ?? new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${start}&endDate=${end}&metrics=views&dimensions=day`;
  const result = await fetchJson(url, { headers: bearer(token) }, ctx);
  if ('status' in result) return result;
  if (!Array.isArray(result.json?.rows)) return probe('PROVIDER_UNAVAILABLE', { errorCode: 'INVALID_PROVIDER_RESPONSE', errorCategory: 'unknown', retryable: false });
  return probe('CONNECTED', { quota: quotaFromHeaders(result.response.headers), detail: 'reports.query responded successfully.' });
}

async function probeTikTok(credential: CredentialPayload, def: ProviderDefinition, ctx: ProbeContext): Promise<ProbeResult> {
  const token = await ensureAccessToken(credential, def, ctx);
  if (!token) return probe('AUTH_REQUIRED', { errorCode: 'AUTH_REQUIRED', errorCategory: 'auth' });
  const result = await fetchJson('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', { headers: bearer(token) }, ctx);
  if ('status' in result) return result;
  if (!result.json?.data?.user?.open_id) return probe('PROVIDER_UNAVAILABLE', { errorCode: 'INVALID_PROVIDER_RESPONSE', errorCategory: 'unknown', retryable: false });
  return probe('CONNECTED', { quota: quotaFromHeaders(result.response.headers), detail: 'user/info responded successfully.' });
}

async function probeInstagram(credential: CredentialPayload, def: ProviderDefinition, ctx: ProbeContext): Promise<ProbeResult> {
  const token = await ensureAccessToken(credential, def, ctx);
  if (!token) return probe('AUTH_REQUIRED', { errorCode: 'AUTH_REQUIRED', errorCategory: 'auth' });
  const result = await fetchJson('https://graph.facebook.com/v21.0/me?fields=id,name', { headers: bearer(token) }, ctx);
  if ('status' in result) return result;
  if (!result.json?.id) return probe('PROVIDER_UNAVAILABLE', { errorCode: 'INVALID_PROVIDER_RESPONSE', errorCategory: 'unknown', retryable: false });
  return probe('CONNECTED', { quota: quotaFromHeaders(result.response.headers), detail: 'Graph /me responded successfully.' });
}

async function probeOllamaCloud(credential: CredentialPayload, _def: ProviderDefinition, ctx: ProbeContext): Promise<ProbeResult> {
  const env = ctx.env ?? process.env;
  const apiKey = stringValue(credential, 'apiKey') || String(env.OLLAMA_API_KEY ?? '').trim();
  if (!apiKey) return probe('AUTH_REQUIRED', { errorCode: 'AUTH_REQUIRED', errorCategory: 'auth' });
  const base = String(env.OLLAMA_BASE_URL ?? 'https://ollama.com').trim().replace(/\/+$/, '') || 'https://ollama.com';
  const safeBase = await assertPublicHttpsUrl(`${base}/api/tags`, ctx.lookup);
  if (!safeBase) return probe('PROVIDER_UNAVAILABLE', { errorCode: 'INVALID_ENDPOINT', errorCategory: 'configuration', retryable: false });
  const result = await fetchJson(safeBase, { headers: bearer(apiKey) }, ctx);
  if ('status' in result) return result;
  if (!Array.isArray(result.json?.models)) return probe('PROVIDER_UNAVAILABLE', { errorCode: 'INVALID_PROVIDER_RESPONSE', errorCategory: 'unknown', retryable: false });
  return probe('CONNECTED', { quota: quotaFromHeaders(result.response.headers), detail: 'Read-only model listing succeeded.' });
}

async function probeOllamaLocal(_credential: CredentialPayload, _def: ProviderDefinition, ctx: ProbeContext): Promise<ProbeResult> {
  const result = await fetchJson('http://127.0.0.1:11434/api/tags', { headers: { Accept: 'application/json' } }, ctx);
  if ('status' in result) return result;
  if (!Array.isArray(result.json?.models)) return probe('PROVIDER_UNAVAILABLE', { errorCode: 'INVALID_PROVIDER_RESPONSE', errorCategory: 'unknown', retryable: false });
  return probe('CONNECTED', { detail: 'Local Ollama model listing succeeded.', quota: { source: 'local_daemon', cost: 'free' } });
}

function probeOpenCodeFree(_credential: CredentialPayload, _def: ProviderDefinition, ctx: ProbeContext): ProbeResult {
  const file = ctx.freeModelsFile ?? new URL('../../scripts/free-models.json', import.meta.url).pathname;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const models = Array.isArray(parsed?.models) ? parsed.models.map(String).filter((model: string) => model.length > 0) : [];
    if (models.length === 0) return probe('PROVIDER_UNAVAILABLE', { errorCode: 'FREE_MODEL_ALLOWLIST_EMPTY', errorCategory: 'configuration', retryable: false });
    return probe('CONNECTED', {
      detail: `Verified ${models.length} locally listed free models.`,
      quota: { source: 'verified_allowlist', verifiedAt: String(parsed.verifiedAt ?? ''), models: models.length },
    });
  } catch {
    return probe('PROVIDER_UNAVAILABLE', { errorCode: 'FREE_MODEL_ALLOWLIST_UNAVAILABLE', errorCategory: 'configuration', retryable: false });
  }
}

async function probeApiAnythingMcp(_credential: CredentialPayload, _def: ProviderDefinition, ctx: ProbeContext): Promise<ProbeResult> {
  const serverPath = ctx.mcpServerPath ?? null;
  if (!serverPath) return probe('NOT_CONFIGURED', { errorCode: 'DISCOVERY_MCP_SERVER_NOT_CONFIGURED', errorCategory: 'configuration' });
  const env = ctx.env ?? process.env;
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS']) {
    if (env[key]) childEnv[key] = env[key];
  }
  let client: McpStdioClient | null = null;
  try {
    client = await McpStdioClient.connect({
      command: process.execPath,
      args: [serverPath],
      env: childEnv,
      clientName: 'ugc-api-integration-center',
      clientVersion: '1.0.0',
      connectTimeoutMs: 10_000,
    });
    const tools = await client.listTools();
    return probe('CONNECTED', {
      detail: `MCP tools/list succeeded (${tools.length} tools).`,
      quota: { source: 'local_mcp', cost: 'free' },
    });
  } catch {
    return probe('PROVIDER_UNAVAILABLE', { errorCode: 'MCP_UNAVAILABLE', errorCategory: 'transient', retryable: true });
  } finally {
    client?.close();
  }
}

const PROBES: Record<string, (credential: CredentialPayload, def: ProviderDefinition, ctx: ProbeContext) => Promise<ProbeResult> | ProbeResult> = {
  youtube_google: probeGoogleYouTube,
  youtube_analytics: probeGoogleAnalytics,
  tiktok: probeTikTok,
  instagram_meta: probeInstagram,
  ollama_cloud: probeOllamaCloud,
  ollama_local: probeOllamaLocal,
  opencode_free: probeOpenCodeFree,
  api_anything_mcp: probeApiAnythingMcp,
};

/** One full provider test with bounded retry/backoff for transient failures. */
export async function probeProvider(key: string, credential: CredentialPayload, ctx: ProbeContext = {}): Promise<ProbeResult> {
  const def = getProviderDefinition(key);
  if (!def) return probe('PROVIDER_UNAVAILABLE', { errorCode: 'UNKNOWN_PROVIDER', errorCategory: 'input' });
  if (!def.liveAdapter) return probe('ADAPTER_NOT_IMPLEMENTED', { errorCode: 'ADAPTER_NOT_IMPLEMENTED', errorCategory: 'capability' });
  const probeFn = PROBES[key];
  if (!probeFn) return probe('ADAPTER_NOT_IMPLEMENTED', { errorCode: 'ADAPTER_NOT_IMPLEMENTED', errorCategory: 'capability' });

  const sleep = ctx.sleep ?? (async (ms: number) => { await new Promise<void>((resolve) => setTimeout(resolve, ms)); });
  let last = probe('PROVIDER_UNAVAILABLE', { errorCode: 'PROBE_NOT_EXECUTED', errorCategory: 'unknown' });
  for (let attempt = 0; attempt < MAX_PROBE_ATTEMPTS; attempt += 1) {
    try {
      last = await probeFn(credential, def, ctx);
    } catch (error) {
      last = probe('PROVIDER_UNAVAILABLE', {
        errorCode: String((error as Error)?.message ?? 'PROBE_FAILED').slice(0, 120),
        errorCategory: 'unknown',
        retryable: false,
      });
    }
    if (last.status === 'CONNECTED' || !last.retryable || attempt === MAX_PROBE_ATTEMPTS - 1) break;
    await sleep(computeBackoffMs(attempt + 1));
  }
  return last;
}

export function buildAuthorizationUrl(def: ProviderDefinition, input: { clientId: string; redirectUri: string; state: string; codeChallenge?: string | null; scopes?: string[] }): string {
  if (!def.oauth) throw new Error('OAUTH_NOT_SUPPORTED');
  const url = new URL(def.oauth.authorizeUrl);
  const params = url.searchParams;
  params.set(def.oauth.clientIdParam ?? 'client_id', input.clientId);
  params.set('redirect_uri', input.redirectUri);
  params.set('response_type', 'code');
  params.set('state', input.state);
  const scopes = input.scopes?.length ? input.scopes : def.oauth.scopes;
  params.set('scope', scopes.join(def.oauth.scopeSeparator ?? ' '));
  for (const [key, value] of Object.entries(def.oauth.authorizeParams ?? {})) params.set(key, value);
  if (def.oauth.pkce && input.codeChallenge) {
    params.set('code_challenge', input.codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function tokenExchange(def: ProviderDefinition, params: URLSearchParams, ctx: ProbeContext, useGet: boolean): Promise<OAuthTokenResult> {
  const url = new URL(def.oauth!.tokenUrl);
  if (useGet) for (const [key, value] of params) url.searchParams.set(key, value);
  const result = await fetchJson(url.toString(), useGet
    ? { headers: { Accept: 'application/json' } }
    : { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: params.toString() }, ctx);
  if ('status' in result) throw new Error(result.errorCode ?? 'OAUTH_TOKEN_EXCHANGE_FAILED');
  const json = result.json;
  const accessToken = String(json?.access_token ?? '').trim();
  if (!accessToken) throw new Error('OAUTH_TOKEN_MISSING');
  const expiresIn = Number(json?.expires_in);
  return {
    accessToken,
    refreshToken: typeof json?.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    scopes: String(json?.scope ?? '').split(/\s+/).filter(Boolean),
  };
}

function tokenClientParams(def: ProviderDefinition, clientId: string, clientSecret: string): URLSearchParams {
  const params = new URLSearchParams();
  params.set(def.oauth?.clientIdParam ?? 'client_id', clientId);
  params.set('client_secret', clientSecret);
  return params;
}

export async function exchangeAuthorizationCode(def: ProviderDefinition, input: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier?: string | null }, ctx: ProbeContext = {}): Promise<OAuthTokenResult> {
  if (!def.oauth) throw new Error('OAUTH_NOT_SUPPORTED');
  const params = tokenClientParams(def, input.clientId, input.clientSecret);
  params.set('grant_type', 'authorization_code');
  params.set('code', input.code);
  params.set('redirect_uri', input.redirectUri);
  if (def.oauth.pkce && input.codeVerifier) params.set('code_verifier', input.codeVerifier);
  // Meta's token endpoint documents query parameters; Google/TikTok use a POST body.
  return tokenExchange(def, params, ctx, def.key === 'instagram_meta');
}

export async function refreshAccessToken(def: ProviderDefinition, input: { refreshToken: string; clientId: string; clientSecret: string }, ctx: ProbeContext = {}): Promise<OAuthTokenResult> {
  if (!def.oauth) throw new Error('OAUTH_NOT_SUPPORTED');
  const isMeta = def.key === 'instagram_meta';
  const params = tokenClientParams(def, input.clientId, input.clientSecret);
  params.set('grant_type', isMeta ? 'fb_exchange_token' : 'refresh_token');
  params.set(isMeta ? 'fb_exchange_token' : 'refresh_token', input.refreshToken);
  return tokenExchange(def, params, ctx, isMeta);
}

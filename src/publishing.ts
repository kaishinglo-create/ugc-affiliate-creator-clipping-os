import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { withWorkspaceTransaction } from '../lib/db.js';
import { workspaceMediaPath } from './media-workspace.js';
import { writeAuditEvent } from '../lib/audit.js';
import { redactText } from '../lib/redaction.js';
import { isKillSwitchActive } from '../lib/security.js';
import { persistPublishingTokenRefresh, resolvePublishingCredentials } from './api-integration-center/service.js';
import {
  executeLivePublishing,
  type PublishingFetch,
  type PublishingLookup,
} from './publishing-adapters.js';
import { claimJobById, completeJob, createJob, failJob, heartbeatJob, requeueDeadLetterJob } from './jobs.js';

/**
 * Publishing adapters — official contracts only, no fake success.
 *
 * A live adapter runs only when BOTH real environment credentials and the
 * explicit PUBLISHING_LIVE_ADAPTERS=1|true opt-in are present. Otherwise the
 * honest legacy behaviour is preserved:
 *   - missing credentials              -> NOT_CONFIGURED (retryable, zero network calls)
 *   - credentials present, opt-in off  -> CREDENTIALS_ONLY + ADAPTER_NOT_IMPLEMENTED
 * Never invent an externalId, URL, publishedAt or ContentPost row.
 *
 * Live HTTP lives in src/publishing-adapters.ts. The claim, the network call and
 * the settlement are three separate phases: no fetch call holds a DB
 * transaction, and both success and failure settle only after re-checking the
 * approved gate and the job lease.
 *
 * Official contracts implemented by the live adapters:
 *
 * 1. YouTube Data API v3 — videos.insert
 *    POST https://www.googleapis.com/upload/youtube/v3/videos
 *      ?uploadType=resumable&part=snippet,status
 *    OAuth 2.0 scope: https://www.googleapis.com/auth/youtube.upload
 *    Flow: metadata request (snippet + status incl. privacyStatus) returns a
 *    resumable session Location header; the bytes are PUT to that session.
 *    multipart/uploadType=multipart is the alternative small-file flow.
 *    https://developers.google.com/youtube/v3/docs/videos/insert
 *
 * 2. TikTok Content Posting API v2 — direct post
 *    POST https://open.tiktokapis.com/v2/post/publish/video/init/
 *    Scope: video.publish (approved for the app AND granted by the creator).
 *    Status polling: POST /v2/post/publish/status/fetch/
 *    https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 *
 * 3. Instagram Graph API — container then publish
 *    POST https://graph.facebook.com/{version}/{ig-user-id}/media
 *    POST https://graph.facebook.com/{version}/{ig-user-id}/media_publish
 *    Requires an Instagram Business/Creator account, a long-lived token and
 *    the container to reach FINISHED before publishing.
 *    https://developers.facebook.com/docs/instagram-api/guides/content-publishing
 *
 * The clipping providers in src/integrations.ts (YAPS/CLIPPINGMINI/KLAP/
 * OPUSCLIP) are unrelated to publishing credentials and are never consulted
 * here. Status responses expose only variable NAMES; credential values are
 * read only by the live adapter, are never logged and are never returned in
 * payloads, responses or the database.
 */

export type PublishingPlatform = 'youtube' | 'tiktok' | 'instagram';
export type PublishingAdapterStatus = 'NOT_CONFIGURED' | 'CREDENTIALS_ONLY';

export const PUBLISHING_PLATFORMS: readonly PublishingPlatform[] = ['youtube', 'tiktok', 'instagram'];
export const PUBLISHING_JOB_CATEGORY = 'PUBLISHING';
/** Approval rows use this entityType; entityId is publishingApprovalEntityId(...). */
export const PUBLISHING_APPROVAL_ENTITY_TYPE = 'publishing';
export const PUBLISHING_DEFAULT_MAX_ATTEMPTS = 3;
/** Live adapters run outside a transaction; keep their lease fenced while uploading. */
export const PUBLISHING_LIVE_LEASE_TTL_MS = 5 * 60_000;

export interface PublishingAdapterContract {
  api: string;
  operation: string;
  auth: string;
  requiredEnv: readonly string[];
  note: string;
}

export const PUBLISHING_CONTRACTS: Record<PublishingPlatform, PublishingAdapterContract> = {
  youtube: {
    api: 'YouTube Data API v3',
    operation: 'videos.insert (resumable upload; multipart snippet+status)',
    auth: 'OAuth 2.0 youtube.upload',
    requiredEnv: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'],
    note: 'Upload bytes only to the resumable session Location returned by videos.insert.',
  },
  tiktok: {
    api: 'TikTok Content Posting API v2',
    operation: 'direct post: /v2/oauth/token/, /v2/post/publish/video/init/ and /v2/post/publish/status/fetch/',
    auth: 'OAuth scope video.publish (app-approved and creator-granted)',
    requiredEnv: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REFRESH_TOKEN'],
    note: 'Direct post is not the upload/inbox flow; scope approval is mandatory.',
  },
  instagram: {
    api: 'Instagram Graph API',
    operation: 'refresh long-lived token, create media container, wait for FINISHED, then media_publish',
    auth: 'Instagram Business/Creator account with long-lived access token',
    requiredEnv: ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_USER_ID', 'INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'],
    note: 'No Basic Display API publishing; publication requires a finished container.',
  },
};

/** Required in addition to real credentials before any live network call. */
export const PUBLISHING_LIVE_OPT_IN_ENV = 'PUBLISHING_LIVE_ADAPTERS';

export function isPublishingLiveOptInEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = String(env[PUBLISHING_LIVE_OPT_IN_ENV] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

export interface PublishingAdapterState {
  platform: PublishingPlatform;
  status: PublishingAdapterStatus;
  /** Legacy field kept false: this build never advertises a fake client. */
  liveAdapter: false;
  /** True only with both real env credentials and the explicit live opt-in. */
  liveEnabled: boolean;
  contract: PublishingAdapterContract;
  credentials: {
    present: boolean;
    source: 'environment' | 'workspace_integration' | 'none';
    /** Variable NAMES only; never values. */
    missingEnv: string[];
  };
  workspaceIntegrationStatus: string | null;
}

export function publishingApprovalEntityId(
  platform: PublishingPlatform,
  entityType: string,
  entityId: string,
  idempotencyKey: string,
): string {
  // JSON encoding keeps the tuple unambiguous even when an id contains ':'.
  return JSON.stringify([platform, entityType, entityId, idempotencyKey]);
}

export const PUBLISHING_FORMATS = ['standard', 'shorts', 'reels'] as const;
export type PublishingFormat = (typeof PUBLISHING_FORMATS)[number];

export function isPublishingFormat(value: unknown): value is PublishingFormat {
  return typeof value === 'string' && (PUBLISHING_FORMATS as readonly string[]).includes(value);
}

/** Canonical hash of the exact content/account/parameters covered by an approval. */
export function publishingBindingHash(input: {
  platform: PublishingPlatform;
  accountKey: string | null;
  entityType: string;
  entityId: string;
  checksum: string | null;
  params: Record<string, unknown>;
  idempotencyKey: string;
}): string {
  const canonical = JSON.stringify({
    platform: input.platform,
    accountKey: input.accountKey ?? null,
    entityType: input.entityType,
    entityId: input.entityId,
    checksum: input.checksum ?? null,
    params: input.params,
    idempotencyKey: input.idempotencyKey,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Versioned approval entity. Changing the checksum, target account, content or
 * any publishing parameter changes this value, so the old human approval stops
 * matching and a new approval is required. Legacy four-field approvals remain
 * valid when no Phase H binding is supplied.
 */
export function publishingApprovalEntityIdForBinding(binding: {
  platform: PublishingPlatform;
  accountKey: string | null;
  entityType: string;
  entityId: string;
  checksum: string | null;
  params: Record<string, unknown>;
  idempotencyKey: string;
}): string {
  const legacy = publishingApprovalEntityId(
    binding.platform, binding.entityType, binding.entityId, binding.idempotencyKey,
  );
  return JSON.stringify(['v2', legacy, publishingBindingHash(binding)]);
}

/** Resolve a local wall-clock time in an IANA timezone to the next UTC instant. */
export function publishingLocalTimeToUtc(localTime: string, timezone: string, from = new Date()): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(localTime ?? '').trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as number[];
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  if (!Number.isFinite(wallClock)) return null;
  let guess = wallClock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date(guess));
    } catch {
      return null;
    }
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? NaN);
    const localParts = Date.UTC(
      value('year'), value('month') - 1, value('day'),
      value('hour') % 24, value('minute'), 0, 0,
    );
    const delta = wallClock - localParts;
    if (delta === 0) {
      // A wall time that also occurs one hour earlier or later is ambiguous
      // (fall-back). Never silently pick one of two possible instants.
      const observedAt = (instant: number): number | null => {
        try {
          const nearby = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
          }).formatToParts(new Date(instant));
          const get = (type: string) => Number(nearby.find((part) => part.type === type)?.value ?? NaN);
          const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), 0, 0);
          return Number.isFinite(local) ? local : null;
        } catch {
          return null;
        }
      };
      if (observedAt(guess - 3_600_000) === wallClock || observedAt(guess + 3_600_000) === wallClock) {
        return null;
      }
      const resolved = new Date(guess);
      return Number.isFinite(resolved.getTime()) && resolved.getTime() > from.getTime() ? resolved : null;
    }
    guess += delta;
  }
  return null;
}

function isPublishingPlatform(value: unknown): value is PublishingPlatform {
  return typeof value === 'string' && (PUBLISHING_PLATFORMS as readonly string[]).includes(value);
}

function envCredentials(platform: PublishingPlatform): { present: boolean; missingEnv: string[] } {
  const missingEnv = PUBLISHING_CONTRACTS[platform].requiredEnv.filter(
    (name) => !String(process.env[name] ?? '').trim(),
  );
  return { present: missingEnv.length === 0, missingEnv: [...missingEnv] };
}

export function getPublishingAdapter(
  platform: PublishingPlatform,
  workspaceIntegrationStatus: string | null = null,
): PublishingAdapterState {
  const env = envCredentials(platform);
  // A stored Integration row records credential storage only (see
  // resolveIntegrationStatus in integrations.ts); it is never a live connection.
  const stored = workspaceIntegrationStatus === 'CONFIGURED';
  const present = env.present || stored;
  return {
    platform,
    status: present ? 'CREDENTIALS_ONLY' : 'NOT_CONFIGURED',
    liveAdapter: false,
    // A stored Integration row is not a usable OAuth client; only real env
    // credentials plus the explicit opt-in can enable network calls.
    liveEnabled: isPublishingLiveOptInEnabled() && env.present,
    contract: PUBLISHING_CONTRACTS[platform],
    credentials: {
      present,
      source: env.present ? 'environment' : stored ? 'workspace_integration' : 'none',
      missingEnv: env.missingEnv,
    },
    workspaceIntegrationStatus,
  };
}

export async function listPublishingAdapters(workspaceId: string): Promise<PublishingAdapterState[]> {
  const rows = await withWorkspaceTransaction(workspaceId, (tx) =>
    tx.integration.findMany({
      where: { workspaceId, provider: { in: [...PUBLISHING_PLATFORMS] } },
      select: { provider: true, status: true },
    })
  ) as any[];
  const byProvider = new Map<string, string>();
  for (const row of rows ?? []) byProvider.set(String(row.provider), String(row.status));
  const credentials = await Promise.all(
    PUBLISHING_PLATFORMS.map((platform) => resolvePublishingCredentials(workspaceId, platform)),
  );
  return PUBLISHING_PLATFORMS.map((platform, index) => {
    const base = getPublishingAdapter(platform, byProvider.get(platform) ?? null);
    const resolved = credentials[index];
    const required = PUBLISHING_CONTRACTS[platform].requiredEnv;
    const missingEnv = resolved.blocked ? [...required] : required.filter((name) => !resolved.env[name]);
    const present = !resolved.blocked && missingEnv.length === 0;
    return {
      ...base,
      status: present ? 'CREDENTIALS_ONLY' : 'NOT_CONFIGURED',
      liveEnabled: isPublishingLiveOptInEnabled() && present,
      credentials: {
        present,
        source: resolved.source === 'workspace' ? 'workspace_integration' : resolved.source,
        missingEnv,
      },
      ...(resolved.blocked ? { credentialError: 'CREDENTIAL_DECRYPT_FAILED' } : {}),
    } as PublishingAdapterState & { credentialError?: string };
  });
}

/** Resolve the exact secret map for a live call; never expose it outside this module. */
async function livePublishingCredentials(
  workspaceId: string,
  platform: PublishingPlatform,
): Promise<{ env: Record<string, string>; blocked: boolean; source: string }> {
  const resolved = await resolvePublishingCredentials(workspaceId, platform);
  return { env: resolved.env, blocked: resolved.blocked, source: resolved.source };
}

function adapterStateForCredentials(
  base: PublishingAdapterState,
  resolved: Awaited<ReturnType<typeof livePublishingCredentials>>,
): PublishingAdapterState {
  const required = PUBLISHING_CONTRACTS[base.platform].requiredEnv;
  const missingEnv = resolved.blocked ? [...required] : required.filter((name) => !resolved.env[name]);
  const present = !resolved.blocked && missingEnv.length === 0;
  return {
    ...base,
    status: present ? 'CREDENTIALS_ONLY' : 'NOT_CONFIGURED',
    liveEnabled: isPublishingLiveOptInEnabled() && present,
    credentials: {
      present,
      source: resolved.source === 'workspace' ? 'workspace_integration' : resolved.source as any,
      missingEnv,
    },
  };
}

async function publishingRateLimit(
  tx: any,
  workspaceId: string,
  platform: PublishingPlatform,
  now: Date,
): Promise<{ blocked: boolean; code: string | null }> {
  const providerKey = platform === 'youtube' ? 'youtube_google' : platform === 'tiktok' ? 'tiktok' : 'instagram_meta';
  const row: any = await tx.apiConnection.findUnique({
    where: { workspaceId_providerKey: { workspaceId, providerKey } },
    select: { enabled: true, cooldownUntil: true, circuitState: true, consecutiveFailures: true, quota: true, status: true },
  });
  if (!row || row.enabled === false) return { blocked: false, code: null };
  if (row.circuitState === 'OPEN' || (row.cooldownUntil && new Date(row.cooldownUntil).getTime() > now.getTime())) {
    return { blocked: true, code: 'RATE_LIMITED' };
  }
  const quota = row.quota && typeof row.quota === 'object' ? row.quota as Record<string, unknown> : null;
  const remaining = quota ? Number(quota.remaining) : NaN;
  if (Number.isFinite(remaining) && remaining <= 0) return { blocked: true, code: 'RATE_LIMITED' };
  // Local per-platform budget: only confirmed provider usage is counted.
  const configured = Number(process.env.PUBLISHING_MAX_PROVIDER_UNITS_PER_WORKSPACE_DAILY ?? 100);
  const cap = Number.isFinite(configured) ? Math.max(1, Math.min(100_000, Math.trunc(configured))) : 100;
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const used = await tx.auditEvent.count({
    where: { workspaceId, type: `publishing_provider_usage_${platform}`, createdAt: { gte: day } },
  });
  if (used >= cap) return { blocked: true, code: 'PLATFORM_BUDGET_EXCEEDED' };
  return { blocked: false, code: null };
}

async function recordPublishingConnectionOutcome(
  workspaceId: string,
  platform: PublishingPlatform,
  ok: boolean,
  code: string | null,
): Promise<void> {
  const providerKey = platform === 'youtube' ? 'youtube_google' : platform === 'tiktok' ? 'tiktok' : 'instagram_meta';
  await withWorkspaceTransaction(workspaceId, async (tx) => {
    const row: any = await tx.apiConnection.findUnique({
      where: { workspaceId_providerKey: { workspaceId, providerKey } },
      select: { consecutiveFailures: true, status: true, credentialId: true, enabled: true },
    });
    if (!row) return;
    const failures = ok ? 0 : Number(row.consecutiveFailures ?? 0) + 1;
    const cooldownMs = Math.min(15 * 60_000, 30_000 * Math.pow(2, Math.max(0, failures - 1)));
    await tx.apiConnection.update({
      where: { workspaceId_providerKey: { workspaceId, providerKey } },
      data: {
        lastSuccessAt: ok ? new Date() : undefined,
        lastFailureAt: ok ? undefined : new Date(),
        lastErrorCode: ok ? null : code,
        lastErrorCategory: ok ? null : 'publishing',
        consecutiveFailures: failures,
        circuitState: failures >= 3 ? 'OPEN' : 'CLOSED',
        cooldownUntil: !ok && failures >= 3 ? new Date(Date.now() + cooldownMs) : null,
        // A successful upload is not a probe: never promote this to CONNECTED.
        status: row.status === 'CONNECTED' ? row.status : row.status,
      },
    });
  });
}

async function recordPublishingProgress(
  workspaceId: string,
  jobId: string,
  payloadProgress: Record<string, unknown>,
  lease: { leaseId: string; workerId: string },
): Promise<void> {
  await withWorkspaceTransaction(workspaceId, async (tx) => {
    const job: any = await tx.job.findFirst({ where: { id: jobId, workspaceId } });
    if (!job || !isPublishingJob(job) || job.status !== 'RUNNING') return;
    if (job.leaseId !== lease.leaseId || job.leaseOwner !== lease.workerId) return;
    await tx.job.update({
      where: { id: jobId, workspaceId },
      data: { payload: { ...(job.payload as object), progress: payloadProgress } },
    });
  });
  await heartbeatJob(jobId, lease.leaseId, lease.workerId, {
    workspaceId, extendMs: PUBLISHING_LIVE_LEASE_TTL_MS,
  });
}

/** Public error classification shared by the attempt loop and tests. */
export function classifyPublishingFailure(code: string): { retryable: boolean; terminal: boolean } {
  const retryableCodes = new Set([
    'NOT_CONFIGURED',
    'RATE_LIMITED',
    'NETWORK_ERROR',
    'TOKEN_EXPIRED',
    'PLATFORM_TEMPORARY_ERROR',
  ]);
  const retryable = retryableCodes.has(code);
  return { retryable, terminal: !retryable };
}

/** Deterministic exponential backoff used when a publishing attempt is retried. */
export function publishingBackoffMs(attempts: number): number {
  const safeAttempts = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1;
  return Math.min(30_000, 1_000 * Math.pow(2, safeAttempts - 1));
}

export interface EnqueuePublishingInput {
  workspaceId: string;
  actor: string | null;
  platform: unknown;
  entityType: unknown;
  entityId: unknown;
  idempotencyKey: unknown;
  approvalId?: unknown;
  options?: unknown;
  maxAttempts?: unknown;
  runAt?: Date | null;
  /** Phase H: exact human-approved binding inputs. */
  accountKey?: unknown;
  checksum?: unknown;
  qualityReportId?: unknown;
  scheduleId?: unknown;
}

export interface PublishingResult {
  statusCode: number;
  body: Record<string, unknown>;
}

function fail(code: string, message: string, statusCode = 400): PublishingResult {
  return { statusCode, body: { error: { code, message }, code } };
}

const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ENTITY_TYPE_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const ENTITY_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function normalizeOptions(raw: unknown): Record<string, string | null> {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, string | null> = {};
  const limits: Record<string, number> = {
    title: 5_000,
    description: 5_000,
    caption: 5_000,
    visibility: 64,
    format: 16,
    // Basenames only; workspaceMediaPath enforces the scratch-root boundary.
    mediaName: 128,
    mediaFile: 128,
    fileName: 128,
    // Public https URLs only; never a filesystem path.
    mediaUrl: 2_048,
    videoUrl: 2_048,
    fileUrl: 2_048,
  };
  for (const [key, limit] of Object.entries(limits)) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, limit);
  }
  return out;
}

export function isPublishingJob(job: any): boolean {
  return Boolean(
    job
      && job.category === PUBLISHING_JOB_CATEGORY
      && job.payload
      && (job.payload as any).kind === 'publishing'
      && isPublishingPlatform((job.payload as any).platform),
  );
}

function publicJob(job: any): any {
  if (!job) return null;
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    type: job.type,
    category: job.category,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError ?? null,
    runAt: job.runAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    createdAt: job.createdAt,
    payload: job.payload,
    progress: (job.payload as any)?.progress ?? null,
  };
}

/** Recompute the SHA-256 of the actual clip and compare it to the report. */
async function verifyClipChecksum(
  workspaceId: string,
  report: any,
  expected: string | null,
): Promise<boolean> {
  const checksum = typeof report?.checksum === 'string' ? report.checksum : null;
  if (!checksum || !/^sha256:[a-f0-9]{64}$/.test(checksum)) return false;
  if (expected && expected !== checksum) return false;
  try {
    const clipName = String(report.clipPath ?? '').split(/[\\/]/).pop() ?? '';
    const target = workspaceMediaPath(workspaceId, clipName);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
    return `sha256:${hash.digest('hex')}` === checksum;
  } catch {
    return false;
  }
}

async function findApprovedGate(
  tx: any,
  workspaceId: string,
  expectedEntityId: string,
  approvalId: string | null,
  qualityReportId: string | null = null,
): Promise<any | null> {
  if (await isKillSwitchActive(workspaceId, tx)) return null;
  if (qualityReportId) {
    const report: any = await tx.qualityReport.findFirst({
      where: { id: qualityReportId, workspaceId, passed: true },
      select: { id: true, passed: true, checksum: true, clipPath: true },
    });
    if (!report?.passed || !(await verifyClipChecksum(workspaceId, report, null))) return null;
  }
  const where: any = {
    workspaceId,
    entityType: PUBLISHING_APPROVAL_ENTITY_TYPE,
    entityId: expectedEntityId,
    status: 'approved',
  };
  if (approvalId) where.id = approvalId;
  // Approved decisions are final in this app, but an explicit decidedAt check
  // prevents a hand-crafted row from being treated as a human decision.
  const rows = await tx.approval.findMany({ where, orderBy: { decidedAt: 'desc' }, take: 1 }) as any[];
  const row = rows?.[0];
  if (!row?.decidedAt) return null;
  // Expiry/revocation columns are optional during the upgrade window; once the
  // lifecycle migration is applied they are enforced here as well.
  if (row.revokedAt) return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;
  return row;
}

function expectedApprovalEntityId(payload: any): string | null {
  if (!isPublishingPlatform(payload?.platform)) return null;
  if (!KEY_RE.test(String(payload?.idempotencyKey ?? ''))) return null;
  const entityType = String(payload.entity?.type ?? '');
  const entityId = String(payload.entity?.id ?? '');
  const idempotencyKey = String(payload.idempotencyKey);
  const binding = payload.binding;
  if (!binding) {
    return publishingApprovalEntityId(payload.platform, entityType, entityId, idempotencyKey);
  }
  return publishingApprovalEntityIdForBinding({
    platform: payload.platform,
    accountKey: binding.accountKey ?? null,
    entityType,
    entityId,
    checksum: binding.checksum ?? null,
    params: (binding.params ?? {}) as Record<string, unknown>,
    idempotencyKey,
  });
}

async function gateForJob(tx: any, workspaceId: string, job: any): Promise<any | null> {
  const payload = job.payload as any;
  const approval = payload?.approval ?? {};
  const expectedEntityId = expectedApprovalEntityId(payload);
  if (!expectedEntityId || approval?.entityId !== expectedEntityId) return null;
  const qualityReportId = payload.qualityReportId ? String(payload.qualityReportId) : null;
  return findApprovedGate(
    tx,
    workspaceId,
    expectedEntityId,
    approval?.id ? String(approval.id) : null,
    qualityReportId,
  );
}

export interface PreparedPublishingInput {
  platform: PublishingPlatform;
  entityType: string;
  entityId: string;
  idempotencyKey: string;
  approvalId: string | null;
  accountKey: string | null;
  checksum: string | null;
  qualityReportId: string | null;
  scheduleId: string | null;
  options: Record<string, string | null>;
  maxAttempts: number;
  binding: {
    platform: PublishingPlatform;
    accountKey: string | null;
    entityType: string;
    entityId: string;
    checksum: string | null;
    params: Record<string, unknown>;
  } | null;
  expectedEntityId: string;
  fingerprint: string;
}

/** Pure validation shared by direct jobs and durable publishing schedules. */
function preparePublishingInput(input: EnqueuePublishingInput): PreparedPublishingInput | PublishingResult {
  if (!isPublishingPlatform(input.platform)) return fail('INVALID_PLATFORM', 'Unsupported publishing platform.');
  const platform = input.platform;
  const entityType = String(input.entityType ?? '').trim();
  const entityId = String(input.entityId ?? '').trim();
  const idempotencyKey = String(input.idempotencyKey ?? '').trim();
  if (!ENTITY_TYPE_RE.test(entityType) || !ENTITY_ID_RE.test(entityId) || !KEY_RE.test(idempotencyKey)) {
    return fail('INVALID_INPUT', 'entityType, entityId and idempotencyKey must be valid identifiers.');
  }
  const approvalId = input.approvalId == null ? null : String(input.approvalId).trim();
  if (approvalId && !ENTITY_ID_RE.test(approvalId)) return fail('INVALID_INPUT', 'Invalid approvalId.');
  const accountKey = input.accountKey == null || String(input.accountKey).trim() === ''
    ? null
    : String(input.accountKey).trim();
  if (accountKey && !ENTITY_ID_RE.test(accountKey)) return fail('INVALID_INPUT', 'Invalid accountKey.');
  const checksum = input.checksum == null || String(input.checksum).trim() === ''
    ? null
    : String(input.checksum).trim();
  if (checksum && !/^[A-Za-z0-9._:-]{1,128}$/.test(checksum)) return fail('INVALID_INPUT', 'Invalid checksum.');
  const qualityReportId = input.qualityReportId == null || String(input.qualityReportId).trim() === ''
    ? null
    : String(input.qualityReportId).trim();
  if (qualityReportId && !ENTITY_ID_RE.test(qualityReportId)) return fail('INVALID_INPUT', 'Invalid qualityReportId.');
  const options = normalizeOptions(input.options);
  if (options.format && !isPublishingFormat(options.format)) return fail('INVALID_INPUT', 'Unsupported publishing format.');
  const scheduleId = input.scheduleId == null || String(input.scheduleId).trim() === ''
    ? null
    : String(input.scheduleId).trim();
  if (options.format && !isFormatForPlatform(platform, options.format as PublishingFormat)) {
    return fail('UNSUPPORTED_FORMAT', 'The requested format is not supported on this platform.', 400);
  }

  const maxAttempts = Number.isFinite(Number(input.maxAttempts))
    && Number(input.maxAttempts) >= 1
    && Number(input.maxAttempts) <= 10
    ? Math.floor(Number(input.maxAttempts))
    : PUBLISHING_DEFAULT_MAX_ATTEMPTS;

  const hasBinding = Boolean(accountKey || checksum || qualityReportId || options.format || scheduleId);
  const binding = hasBinding
    ? { platform, accountKey, entityType, entityId, checksum, params: options as Record<string, unknown> }
    : null;
  const expectedEntityId = binding
    ? publishingApprovalEntityIdForBinding({ ...binding, idempotencyKey })
    : publishingApprovalEntityId(platform, entityType, entityId, idempotencyKey);
  // Legacy jobs (no v2 binding) keep their original idempotency semantics:
  // a repeated key with different cosmetic options returns the same job.
  // Versioned bindings include every parameter, so any change conflicts.
  const fingerprint = binding
    ? JSON.stringify([platform, entityType, entityId, accountKey, checksum, options])
    : JSON.stringify([platform, entityType, entityId]);
  return {
    platform, entityType, entityId, idempotencyKey, approvalId, accountKey, checksum,
    qualityReportId, scheduleId, options, maxAttempts, binding, expectedEntityId, fingerprint,
  };
}

function isFormatForPlatform(platform: PublishingPlatform, format: PublishingFormat): boolean {
  if (platform === 'instagram') return format === 'standard' || format === 'reels';
  return format === 'standard' || format === 'shorts';
}

/**
 * Public helper for the human approval route: the approval entity must encode
 * the exact same content/checksum/account/parameter tuple that enqueue checks.
 */
export function publishingApprovalTarget(input: EnqueuePublishingInput): { entityId: string; bindingHash: string | null } | null {
  const prepared = preparePublishingInput(input);
  if ('statusCode' in prepared) return null;
  return {
    entityId: prepared.expectedEntityId,
    bindingHash: prepared.binding
      ? publishingBindingHash({ ...prepared.binding, idempotencyKey: prepared.idempotencyKey })
      : null,
  };
}

/**
 * Enqueue a publish attempt. No network call is made here. The approval gate is
 * checked inside the same workspace transaction that creates the durable Job,
 * so a rejected/forged approval can never leave a RUNNING upload behind.
 */
export async function enqueuePublishingJob(input: EnqueuePublishingInput): Promise<PublishingResult> {
  const prepared = preparePublishingInput(input);
  if ('statusCode' in prepared) return prepared;
  const {
    platform, entityType, entityId, idempotencyKey, approvalId, accountKey,
    qualityReportId, options, maxAttempts, binding, expectedEntityId, fingerprint,
  } = prepared;
  const scheduleId = prepared.scheduleId;

  return withWorkspaceTransaction(input.workspaceId, async (tx) => {
    if (accountKey) {
      const account: any = await tx.publishingAccount.findFirst({
        where: { workspaceId: input.workspaceId, platform, accountKey, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!account) return fail('UNKNOWN_ACCOUNT', 'The target publishing account is not configured.', 400);
    }

    const approval = await findApprovedGate(
      tx, input.workspaceId, expectedEntityId, approvalId, qualityReportId,
    );
    if (!approval) {
      return fail(
        'APPROVAL_REQUIRED',
        'A matching approved Approval is required before a publishing job can be queued.',
        409,
      );
    }

    const payload = {
      kind: 'publishing',
      schemaVersion: 2,
      platform,
      entity: { type: entityType, id: entityId },
      idempotencyKey,
      fingerprint,
      ...(binding ? { binding } : {}),
      ...(qualityReportId ? { qualityReportId } : {}),
      ...(scheduleId ? { scheduleId } : {}),
      approval: {
        id: approval.id,
        entityType: PUBLISHING_APPROVAL_ENTITY_TYPE,
        entityId: expectedEntityId,
      },
      options,
      requestedBy: input.actor ?? null,
    };

    const existing = await tx.job.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey } },
    }) as any;
    if (existing && (existing.category !== PUBLISHING_JOB_CATEGORY || (existing.payload as any)?.fingerprint !== fingerprint)) {
      return fail('IDEMPOTENCY_KEY_CONFLICT', 'This idempotencyKey belongs to a different request.', 409);
    }

    const job = await createJob({
      workspaceId: input.workspaceId,
      type: 'AGENT_TASK',
      category: PUBLISHING_JOB_CATEGORY,
      payload,
      idempotencyKey,
      maxAttempts,
      runAt: input.runAt ?? null,
    }, tx) as any;

    await writeAuditEvent({
      workspaceId: input.workspaceId,
      userId: input.actor ?? null,
      runId: null,
      type: 'publishing_job_enqueued',
      actor: input.actor ?? null,
      data: {
        jobId: job.id,
        platform,
        entityType,
        entityId,
        idempotencyKey,
        approvalId: approval.id,
        bindingHash: binding ? publishingBindingHash({ ...binding, idempotencyKey }) : null,
        qualityReportId,
        accountKey,
        status: 'QUEUED',
        duplicate: Boolean(existing),
      },
      tx,
    });

    return {
      statusCode: 201,
      body: { job: publicJob(job), approvalId: approval.id, duplicate: Boolean(existing) },
    };
  });
}

export async function getPublishingJob(workspaceId: string, jobId: string): Promise<any | null> {
  const job = await withWorkspaceTransaction(workspaceId, (tx) =>
    tx.job.findFirst({ where: { id: jobId, workspaceId } })
  ) as any;
  return job && isPublishingJob(job) ? publicJob(job) : null;
}

export async function listPublishingJobs(workspaceId: string, filters: any = {}): Promise<any[]> {
  const rows = await withWorkspaceTransaction(workspaceId, (tx) => {
    const where: any = { workspaceId, category: PUBLISHING_JOB_CATEGORY };
    if (filters?.status) where.status = String(filters.status);
    const take = Number.isFinite(Number(filters?.limit)) ? Math.min(100, Math.max(1, Number(filters.limit))) : 50;
    const skip = Number.isFinite(Number(filters?.offset)) ? Math.max(0, Number(filters.offset)) : 0;
    return tx.job.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip });
  }) as any[];
  return (rows ?? []).filter(isPublishingJob).map(publicJob);
}

/* -------------------------------------------------------------------------- *
 * Phase H.1/H.2: target accounts and durable, timezone-aware plans.
 * No credential value is stored in either model; only a stable account key.
 * -------------------------------------------------------------------------- */

export const PUBLISHING_ACCOUNT_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type PublishingAccountStatus = (typeof PUBLISHING_ACCOUNT_STATUSES)[number];

function publicAccount(row: any): any {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    accountKey: row.accountKey,
    displayName: row.displayName ?? null,
    note: row.note ?? null,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertPublishingAccount(input: {
  workspaceId: string;
  actor: string | null;
  platform: unknown;
  accountKey: unknown;
  displayName?: unknown;
  note?: unknown;
  status?: unknown;
}): Promise<PublishingResult> {
  if (!isPublishingPlatform(input.platform)) return fail('INVALID_PLATFORM', 'Unsupported publishing platform.');
  const accountKey = String(input.accountKey ?? '').trim();
  if (!ENTITY_ID_RE.test(accountKey)) return fail('INVALID_INPUT', 'Invalid accountKey.');
  const status = String(input.status ?? 'ACTIVE').trim().toUpperCase();
  if (!(PUBLISHING_ACCOUNT_STATUSES as readonly string[]).includes(status)) return fail('INVALID_INPUT', 'Invalid account status.');
  const displayName = input.displayName == null ? null : String(input.displayName).trim().slice(0, 120) || null;
  const note = input.note == null ? null : String(input.note).trim().slice(0, 1_000) || null;

  const account = await withWorkspaceTransaction(input.workspaceId, async (tx) => {
    const row: any = await tx.publishingAccount.upsert({
      where: {
        workspaceId_platform_accountKey: {
          workspaceId: input.workspaceId, platform: input.platform, accountKey,
        },
      },
      create: {
        workspaceId: input.workspaceId, platform: input.platform, accountKey,
        displayName, note, status,
      },
      update: { displayName, note, status },
    });
    await writeAuditEvent({
      workspaceId: input.workspaceId,
      userId: input.actor ?? null,
      runId: null,
      type: 'publishing_account_upserted',
      actor: input.actor ?? null,
      data: { accountId: row.id, platform: input.platform, accountKey, status },
      tx,
    });
    return row;
  });
  return { statusCode: 200, body: { account: publicAccount(account) } };
}

export async function listPublishingAccounts(workspaceId: string): Promise<any[]> {
  const rows = await withWorkspaceTransaction(workspaceId, (tx) =>
    tx.publishingAccount.findMany({ where: { workspaceId }, orderBy: [{ platform: 'asc' }, { accountKey: 'asc' }] })
  ) as any[];
  return (rows ?? []).map(publicAccount);
}

export async function setPublishingAccountStatus(
  workspaceId: string,
  id: string,
  status: unknown,
  actor: string | null,
): Promise<any | null> {
  const next = String(status ?? '').trim().toUpperCase();
  if (!(PUBLISHING_ACCOUNT_STATUSES as readonly string[]).includes(next)) return null;
  const updated = await withWorkspaceTransaction(workspaceId, async (tx) => {
    const result = await tx.publishingAccount.updateMany({
      where: { id, workspaceId }, data: { status: next },
    });
    if (result.count !== 1) return null;
    const row: any = await tx.publishingAccount.findFirst({ where: { id, workspaceId } });
    await writeAuditEvent({
      workspaceId, userId: actor ?? null, runId: null,
      type: 'publishing_account_status_changed', actor: actor ?? null,
      data: { accountId: id, status: next }, tx,
    });
    return row;
  });
  return updated ? publicAccount(updated) : null;
}

export interface CreatePublishingScheduleInput extends EnqueuePublishingInput {
  localTime: unknown;
  timezone: unknown;
}

function publicSchedule(row: any): any {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    accountKey: row.accountKey ?? null,
    entityType: row.entityType,
    entityId: row.entityId,
    idempotencyKey: row.idempotencyKey,
    approvalId: row.approvalId,
    qualityReportId: row.qualityReportId ?? null,
    checksum: row.checksum ?? null,
    options: row.options ?? {},
    localTime: row.localTime,
    timezone: row.timezone,
    runAt: row.runAt,
    status: row.status,
    lastError: row.lastError ?? null,
    lastRunAt: row.lastRunAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createPublishingSchedule(input: CreatePublishingScheduleInput): Promise<PublishingResult> {
  const prepared = preparePublishingInput(input);
  if ('statusCode' in prepared) return prepared;
  const localTime = String(input.localTime ?? '').trim();
  const timezone = String(input.timezone ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localTime) || !timezone || timezone.length > 64) {
    return fail('INVALID_INPUT', 'localTime must be YYYY-MM-DDTHH:mm and timezone must be an IANA name.');
  }
  const runAt = input.runAt instanceof Date && Number.isFinite(input.runAt.getTime())
    ? input.runAt
    : publishingLocalTimeToUtc(localTime, timezone);
  if (!runAt) return fail('INVALID_SCHEDULE_TIME', 'The timezone is invalid or the local time is not in the future.');

  return withWorkspaceTransaction(input.workspaceId, async (tx) => {
    if (prepared.accountKey) {
      const account: any = await tx.publishingAccount.findFirst({
        where: { workspaceId: input.workspaceId, platform: prepared.platform, accountKey: prepared.accountKey, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!account) return fail('UNKNOWN_ACCOUNT', 'The target publishing account is not configured.', 400);
    }
    const approval = await findApprovedGate(
      tx, input.workspaceId, prepared.expectedEntityId, prepared.approvalId, prepared.qualityReportId,
    );
    if (!approval) return fail('APPROVAL_REQUIRED', 'A matching approved Approval is required for a publishing plan.', 409);
    const existing = await tx.publishingSchedule.findUnique({
      where: {
        workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: prepared.idempotencyKey },
      },
    });
    if (existing) return fail('SCHEDULE_EXISTS', 'A plan with this idempotencyKey already exists.', 409);

    const row: any = await tx.publishingSchedule.create({
      data: {
        workspaceId: input.workspaceId,
        platform: prepared.platform,
        accountKey: prepared.accountKey,
        entityType: prepared.entityType,
        entityId: prepared.entityId,
        idempotencyKey: prepared.idempotencyKey,
        approvalId: approval.id,
        qualityReportId: prepared.qualityReportId,
        checksum: prepared.checksum,
        options: prepared.options,
        localTime,
        timezone,
        runAt,
        status: 'PENDING',
      },
    });
    await writeAuditEvent({
      workspaceId: input.workspaceId,
      userId: input.actor ?? null,
      runId: null,
      type: 'publishing_schedule_created',
      actor: input.actor ?? null,
      data: {
        scheduleId: row.id,
        platform: row.platform,
        accountKey: row.accountKey,
        idempotencyKey: row.idempotencyKey,
        approvalId: approval.id,
        bindingHash: prepared.binding
          ? publishingBindingHash({ ...prepared.binding, idempotencyKey: prepared.idempotencyKey })
          : null,
        runAt: row.runAt,
        timezone,
      },
      tx,
    });
    return { statusCode: 201, body: { schedule: publicSchedule(row) } };
  });
}

export async function listPublishingSchedules(workspaceId: string, limit = 100): Promise<any[]> {
  const take = Number.isFinite(Number(limit)) ? Math.min(200, Math.max(1, Number(limit))) : 100;
  const rows = await withWorkspaceTransaction(workspaceId, (tx) =>
    tx.publishingSchedule.findMany({ where: { workspaceId }, orderBy: { runAt: 'asc' }, take })
  ) as any[];
  return (rows ?? []).map(publicSchedule);
}

export async function setPublishingScheduleStatus(
  workspaceId: string,
  id: string,
  status: unknown,
  actor: string | null,
): Promise<any | null> {
  const next = String(status ?? '').trim().toUpperCase();
  if (!['PENDING', 'CANCELLED'].includes(next)) return null;
  const updated = await withWorkspaceTransaction(workspaceId, async (tx) => {
    const current: any = await tx.publishingSchedule.findFirst({ where: { id, workspaceId } });
    if (!current) return null;
    if (current.status === 'ENQUEUED' || current.status === 'ENQUEUING') return null;
    const result = await tx.publishingSchedule.updateMany({
      where: { id, workspaceId, status: current.status }, data: { status: next },
    });
    if (result.count !== 1) return null;
    const row: any = await tx.publishingSchedule.findFirst({ where: { id, workspaceId } });
    await writeAuditEvent({
      workspaceId, userId: actor ?? null, runId: null,
      type: 'publishing_schedule_status_changed', actor: actor ?? null,
      data: { scheduleId: id, fromStatus: current.status, toStatus: next }, tx,
    });
    return row;
  });
  return updated ? publicSchedule(updated) : null;
}

/** Enqueue at most one job per due plan, re-checking the human approval gate. */
export async function enqueueDuePublishingSchedules(workspaceId: string, now = new Date()): Promise<number> {
  const due = await withWorkspaceTransaction(workspaceId, (tx) => tx.publishingSchedule.findMany({
    where: { workspaceId, status: 'PENDING', runAt: { lte: now } },
    orderBy: { runAt: 'asc' },
    take: 50,
  })) as any[];
  let enqueued = 0;
  for (const schedule of due) {
    const claimed = await withWorkspaceTransaction(workspaceId, async (tx) => {
      if (await isKillSwitchActive(workspaceId, tx)) return null;
      const existingJob: any = await tx.job.findFirst({
        where: { workspaceId, idempotencyKey: schedule.idempotencyKey },
        select: { id: true, status: true },
      });
      if (existingJob) {
        await tx.publishingSchedule.update({
          where: { id: schedule.id }, data: { status: 'ENQUEUED', lastRunAt: now, lastError: null },
        });
        return null;
      }
      const result = await tx.publishingSchedule.updateMany({
        where: { id: schedule.id, workspaceId, status: 'PENDING' },
        data: { status: 'ENQUEUING', lastRunAt: now },
      });
      return result.count === 1 ? schedule : null;
    });
    if (!claimed) continue;

    const result = await enqueuePublishingJob({
      workspaceId,
      actor: null,
      platform: claimed.platform,
      entityType: claimed.entityType,
      entityId: claimed.entityId,
      idempotencyKey: claimed.idempotencyKey,
      approvalId: claimed.approvalId,
      accountKey: claimed.accountKey,
      checksum: claimed.checksum,
      qualityReportId: claimed.qualityReportId,
      options: claimed.options ?? {},
      scheduleId: claimed.id,
      runAt: now,
    });
    const ok = result.statusCode >= 200 && result.statusCode < 300;
    const code = ok ? null : String((result.body as any)?.code ?? 'SCHEDULE_ENQUEUE_FAILED');
    await withWorkspaceTransaction(workspaceId, async (tx) => {
      await tx.publishingSchedule.update({
        where: { id: claimed.id },
        data: { status: ok ? 'ENQUEUED' : 'BLOCKED', lastError: code },
      });
      await writeAuditEvent({
        workspaceId, userId: null, runId: null,
        type: ok ? 'publishing_schedule_enqueued' : 'publishing_schedule_blocked',
        actor: 'engine',
        data: { scheduleId: claimed.id, jobId: (result.body as any)?.job?.id ?? null, code, status: ok ? 'ENQUEUED' : 'BLOCKED' },
        tx,
      });
    });
    if (ok) enqueued += 1;
  }
  return enqueued;
}

/** Reset plans that crashed between claiming and settlement. */
export async function recoverStalePublishingSchedules(workspaceId: string, now = new Date(), staleMs = 10 * 60_000): Promise<number> {
  const rows = await withWorkspaceTransaction(workspaceId, async (tx) => {
    const stale = await tx.publishingSchedule.findMany({
      where: { workspaceId, status: 'ENQUEUING', lastRunAt: { lte: new Date(now.getTime() - staleMs) } },
      select: { id: true, idempotencyKey: true },
    }) as any[];
    let recovered = 0;
    for (const row of stale) {
      const job: any = await tx.job.findFirst({
        where: { workspaceId, idempotencyKey: row.idempotencyKey }, select: { id: true },
      });
      await tx.publishingSchedule.update({
        where: { id: row.id },
        data: job ? { status: 'ENQUEUED' } : { status: 'PENDING', lastError: null },
      });
      recovered += 1;
    }
    return recovered;
  });
  return rows;
}

/** Dead-letter retry remains an explicit operator action with a fresh gate check. */
export async function retryPublishingDeadLetter(
  workspaceId: string,
  jobId: string,
  actor: string | null,
): Promise<PublishingResult | null> {
  const result = await withWorkspaceTransaction(workspaceId, async (tx) => {
    const job: any = await tx.job.findFirst({ where: { id: jobId, workspaceId } });
    if (!job || !isPublishingJob(job)) return { kind: 'not_found' as const };
    if (!['DEAD_LETTER', 'FAILED'].includes(String(job.status))) return { kind: 'conflict' as const };
    if (await isKillSwitchActive(workspaceId, tx)) return { kind: 'conflict' as const };
    if (!(await gateForJob(tx, workspaceId, job))) return { kind: 'approval' as const };
    return { kind: 'ok' as const };
  });
  if (result.kind === 'not_found') return fail('NOT_FOUND', 'Publishing job not found.', 404);
  if (result.kind === 'conflict') return fail('JOB_NOT_RETRYABLE', 'Job is not retryable or the kill switch is active.', 409);
  if (result.kind === 'approval') return fail('APPROVAL_REQUIRED', 'A fresh approval is required before retrying.', 409);
  const requeued = await requeueDeadLetterJob(jobId, {
    workspaceId, actor: actor ?? null, reason: 'publishing_dead_letter_retry',
  }) as any;
  if (!requeued) return fail('NOT_FOUND', 'Publishing job not found.', 404);
  return { statusCode: 200, body: { job: publicJob(requeued) } };
}

/**
 * Legacy seam kept for callers that have not opted in. It performs no I/O and
 * never returns a fake success. The live path uses executeLivePublishing().
 */
export function attemptOfficialPublishing(_platform: PublishingPlatform, _job: any): {
  ok: false;
  code: 'ADAPTER_NOT_IMPLEMENTED';
  retryable: false;
} {
  return { ok: false, code: 'ADAPTER_NOT_IMPLEMENTED', retryable: false };
}

export interface PublishingProcessOptions {
  workerId?: string;
  now?: Date;
  /** Injectable HTTP client for deterministic tests; defaults to globalThis.fetch. */
  fetch?: PublishingFetch;
  /** Injectable resolver used to reject private/loopback media URLs. */
  lookup?: PublishingLookup;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PublishingSettlementOptions {
  leaseId?: string | null;
  workerId?: string | null;
}

type ProcessingPhase =
  | { kind: 'final'; result: PublishingResult }
  | { kind: 'live'; claimed: any; platform: PublishingPlatform };

function publishingHttpStatus(code: string): number {
  if (code === 'NOT_CONFIGURED') return 503;
  if (code === 'ADAPTER_NOT_IMPLEMENTED') return 501;
  if (code === 'APPROVAL_REQUIRED' || code === 'JOB_NOT_CLAIMABLE') return 409;
  if (code === 'INVALID_MEDIA_INPUT' || code === 'INVALID_PLATFORM_RESULT' || code === 'INVALID_INPUT' || code === 'UNSUPPORTED_FORMAT') return 400;
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'TOKEN_EXPIRED') return 401;
  return 502;
}

function failureBody(
  code: string,
  message: string,
  statusCode: number,
  adapter: PublishingAdapterState | null,
  job: any,
): PublishingResult {
  return {
    statusCode,
    body: {
      error: { code, message: redactText(message).slice(0, 300) },
      code,
      result: { ok: false, externalId: null, url: null, publishedAt: null },
      ...(adapter ? { adapter } : {}),
      job: publicJob(job),
    },
  };
}

function leaseStillHeld(job: any, opts: PublishingSettlementOptions): boolean {
  if (!job || job.status !== 'RUNNING') return false;
  if (opts.leaseId && job.leaseId !== opts.leaseId) return false;
  if (opts.workerId && job.leaseOwner !== opts.workerId) return false;
  if (job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() <= Date.now()) return false;
  return true;
}

/** The only way a ContentPost is created: an approved gate + a verified platform id. */
function safePlatformUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function settleLostApproval(
  tx: any,
  workspaceId: string,
  job: any,
  actor: string | null,
  opts: PublishingSettlementOptions,
): Promise<PublishingResult> {
  const platform = (job.payload as any).platform as PublishingPlatform;
  const settled = await failJob(
    job.id,
    { error: 'PUBLISHING_APPROVAL_REQUIRED', retryable: false },
    {
      workspaceId,
      actor: actor ?? null,
      leaseId: opts.leaseId ?? job.leaseId ?? null,
      workerId: opts.workerId ?? job.leaseOwner ?? null,
    },
    tx,
  ) as any;
  await writeAuditEvent({
    workspaceId,
    userId: actor ?? null,
    runId: null,
    type: 'publishing_attempt_failed',
    actor: actor ?? null,
    data: {
      jobId: job.id,
      platform,
      code: 'APPROVAL_REQUIRED',
      retryable: false,
      approvalRevoked: true,
      status: settled?.status ?? null,
      noNetworkCall: false,
    },
    tx,
  });
  return failureBody(
    'APPROVAL_REQUIRED',
    'The approval is no longer active; no post was recorded.',
    409,
    getPublishingAdapter(platform),
    settled ?? job,
  );
}

/**
 * One explicit processing attempt. There is no automatic background publisher:
 * the engine never claims AGENT_TASK jobs, and this route must be called by an
 * operator. The approval gate is re-checked before any state transition.
 *
 * Live adapters run in three phases: claim in one workspace transaction,
 * network I/O with no transaction open, then settle in another workspace
 * transaction with a fresh approval + lease check.
 */
export async function processPublishingJob(
  workspaceId: string,
  jobId: string,
  actor: string | null,
  opts: PublishingProcessOptions = {},
): Promise<PublishingResult> {
  const now = opts.now instanceof Date && Number.isFinite(opts.now.getTime()) ? opts.now : new Date();
  const workerId = String(opts.workerId ?? actor ?? 'publishing-operator');
  const credentialStates = Object.fromEntries(await Promise.all(
    PUBLISHING_PLATFORMS.map(async (platform) => [platform, await livePublishingCredentials(workspaceId, platform)]),
  )) as Record<PublishingPlatform, Awaited<ReturnType<typeof livePublishingCredentials>>>;

  const phase = await withWorkspaceTransaction(workspaceId, async (tx): Promise<ProcessingPhase> => {
    const job = await tx.job.findFirst({ where: { id: jobId, workspaceId } }) as any;
    if (!job || !isPublishingJob(job)) {
      return { kind: 'final', result: fail('NOT_FOUND', 'Publishing job not found.', 404) };
    }

    const gate = await gateForJob(tx, workspaceId, job);
    if (!gate) {
      return {
        kind: 'final',
        result: fail(
          'APPROVAL_REQUIRED',
          'The publishing approval is missing, pending, rejected or does not match this job.',
          409,
        ),
      };
    }

    const platform = (job.payload as any).platform as PublishingPlatform;
    const adapter = adapterStateForCredentials(getPublishingAdapter(platform), credentialStates[platform]);
    const rateLimit = await publishingRateLimit(tx, workspaceId, platform, now);
    if (rateLimit.blocked) {
      return {
        kind: 'final',
        result: fail('RATE_LIMITED', 'The provider rate limit or cooldown is active; no upload was attempted.', 429),
      };
    }
    // H.2 budget control: a hard daily cap on publishing attempts per
    // workspace. The audit counter is authoritative and never reset.
    const configuredCap = Number(process.env.PUBLISHING_MAX_DAILY_ATTEMPTS_PER_WORKSPACE ?? 50);
    const dailyCap = Number.isFinite(configuredCap) ? Math.max(1, Math.min(10_000, Math.trunc(configuredCap))) : 50;
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    const usedToday = await tx.auditEvent.count({
      where: { workspaceId, type: 'publishing_attempt', createdAt: { gte: day } },
    });
    if (usedToday >= dailyCap) {
      return {
        kind: 'final',
        result: fail('BUDGET_EXCEEDED', 'The daily publishing attempt budget is exhausted; no upload was attempted.', 429),
      };
    }
    const liveEnabled = adapter.liveEnabled;
    // A live upload may run longer than the default lease; keep the fencing
    // token valid for the whole adapter call without holding a DB transaction.
    const claimed = await claimJobById(jobId, workerId, {
      workspaceId,
      now,
      leaseTtlMs: liveEnabled ? PUBLISHING_LIVE_LEASE_TTL_MS : undefined,
    }, tx) as any;
    if (!claimed || claimed.status !== 'RUNNING') {
      return {
        kind: 'final',
        result: {
          statusCode: 409,
          body: { error: { code: 'JOB_NOT_CLAIMABLE', message: 'Job is not claimable.' }, job: publicJob(claimed ?? job) },
        },
      };
    }

    await writeAuditEvent({
      workspaceId,
      userId: actor ?? null,
      runId: null,
      type: 'publishing_attempt',
      actor: actor ?? null,
      data: {
        jobId,
        platform: (job.payload as any).platform,
        attempts: claimed.attempts,
        status: 'RUNNING',
        workerId,
      },
      tx,
    });

    if (!liveEnabled) {
      // Preserve the legacy, network-free behaviour exactly.
      const code = adapter.status === 'NOT_CONFIGURED'
        ? 'NOT_CONFIGURED'
        : attemptOfficialPublishing(platform, job).code;
      const classification = classifyPublishingFailure(code);
      const settled = await failJob(
        jobId,
        {
          error: code === 'NOT_CONFIGURED' ? 'PUBLISHING_NOT_CONFIGURED' : 'PUBLISHING_ADAPTER_NOT_IMPLEMENTED',
          retryable: classification.retryable,
          nextRunAt: classification.retryable
            ? new Date(now.getTime() + publishingBackoffMs(Number(claimed.attempts)))
            : null,
        },
        { workspaceId, actor: actor ?? null, leaseId: claimed.leaseId, workerId },
        tx,
      ) as any;

      await writeAuditEvent({
        workspaceId,
        userId: actor ?? null,
        runId: null,
        type: 'publishing_attempt_failed',
        actor: actor ?? null,
        data: {
          jobId,
          platform,
          code,
          retryable: classification.retryable,
          attempts: claimed.attempts,
          status: settled?.status ?? null,
          noNetworkCall: true,
        },
        tx,
      });

      return {
        kind: 'final',
        result: {
          statusCode: publishingHttpStatus(code),
          body: {
            error: {
              code,
              message: code === 'NOT_CONFIGURED'
                ? 'Platform credentials are not configured; no upload was attempted.'
                : 'Credentials are present but no live platform adapter is implemented; no upload was attempted.',
            },
            code,
            result: { ok: false, externalId: null, url: null, publishedAt: null },
            adapter,
            job: publicJob(settled ?? claimed),
          },
        },
      };
    }

    return { kind: 'live', claimed, platform };
  });

  if (phase.kind === 'final') return phase.result;

  const { claimed, platform } = phase;
  // H.2/H.3: re-check the kill switch and the target account immediately
  // before any external action, inside a fresh workspace transaction. A
  // switch flipped between claim and upload therefore prevents the upload.
  const preflight = await withWorkspaceTransaction(workspaceId, async (tx): Promise<{ ok: boolean; code?: string }> => {
    if (await isKillSwitchActive(workspaceId, tx)) {
      await failJob(
        jobId,
        { error: 'KILL_SWITCH_ACTIVE', retryable: false },
        { workspaceId, leaseId: claimed.leaseId, workerId },
        tx,
      ).catch(() => undefined);
      return { ok: false, code: 'KILL_SWITCH_ACTIVE' };
    }
    const payload = claimed.payload as any;
    const accountKey = String(payload?.accountKey ?? payload?.binding?.accountKey ?? '').trim();
    if (accountKey) {
      const account: any = await tx.publishingAccount.findFirst({
        where: { workspaceId, platform, accountKey, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!account) {
        await failJob(
          jobId,
          { error: 'ACCOUNT_DISABLED', retryable: false },
          { workspaceId, leaseId: claimed.leaseId, workerId },
          tx,
        ).catch(() => undefined);
        return { ok: false, code: 'ACCOUNT_DISABLED' };
      }
    }
    return { ok: true };
  });
  if (!preflight.ok) {
    return {
      statusCode: 409,
      body: {
        error: {
          code: preflight.code,
          message: 'The publishing attempt was stopped before any external action; no upload was performed.',
        },
        job: publicJob(claimed),
      },
    };
  }

  let live: Awaited<ReturnType<typeof executeLivePublishing>>;
  try {
    live = await executeLivePublishing({
      platform,
      workspaceId,
      jobId,
      idempotencyKey: String((claimed.payload as any).idempotencyKey ?? ''),
      options: ((claimed.payload as any).options ?? {}) as Record<string, string | null>,
      // Workspace credentials from the encrypted Integration Center only;
      // never a value read directly from process.env at this layer.
      env: credentialStates[platform].env,
    }, {
      fetch: opts.fetch ?? globalThis.fetch,
      lookup: opts.lookup,
      timeoutMs: opts.timeoutMs,
      pollIntervalMs: opts.pollIntervalMs,
      maxPolls: opts.maxPolls,
      sleep: opts.sleep,
      onProgress: (progress) => recordPublishingProgress(
        workspaceId, jobId, progress as unknown as Record<string, unknown>,
        { leaseId: claimed.leaseId, workerId },
      ),
      onTokenRefresh: (tokens) => persistPublishingTokenRefresh(workspaceId, platform, tokens),
      onProviderUsage: (usage) => {
        // Never record a provider value that was not acknowledged by the API.
        if (!usage.confirmed) return Promise.resolve();
        return writeAuditEvent({
          workspaceId,
          userId: actor ?? null,
          runId: null,
          type: `publishing_provider_usage_${usage.platform}`,
          actor: actor ?? 'live-adapter',
          data: { platform: usage.platform, units: usage.units, jobId, confirmed: true },
        });
      },
    });
  } catch {
    live = {
      ok: false,
      code: 'NETWORK_ERROR',
      message: 'Publishing adapter failed unexpectedly.',
      retryable: true,
      providerStatus: null,
    };
  }

  const settlement: PublishingSettlementOptions = { leaseId: claimed.leaseId, workerId };
  // Connection health is observational only: a real upload never promotes a
  // connection to CONNECTED without an explicit probe by the Integration Center.
  // It must never prevent the settlement of an already completed upload.
  try {
    await recordPublishingConnectionOutcome(workspaceId, platform, live.ok, live.ok ? null : live.code);
  } catch {
    // Observational write; settlement below remains authoritative.
  }
  if (live.ok) {
    return settleRealPublishingSuccess(workspaceId, jobId, live.value, actor, settlement);
  }
  // H.2: an unknown upload result is never blindly retried. A retry could
  // duplicate a post whose provider acceptance we simply failed to observe.
  const unknownOutcome = live.code === 'NETWORK_ERROR' && live.providerStatus === null;
  return settleRealPublishingFailure(workspaceId, jobId, {
    code: unknownOutcome ? 'UPLOAD_STATUS_UNKNOWN' : live.code,
    message: unknownOutcome
      ? 'The provider result is unknown. Reconcile the platform status manually before retrying; no automatic re-upload was attempted.'
      : live.message,
    retryable: unknownOutcome ? false : live.retryable,
    providerStatus: live.providerStatus,
    attempts: Number(claimed.attempts),
  }, actor, settlement);
}

async function settleRealPublishingFailure(
  workspaceId: string,
  jobId: string,
  failure: {
    code: string;
    message: string;
    retryable: boolean;
    providerStatus: number | null;
    attempts: number;
  },
  actor: string | null,
  opts: PublishingSettlementOptions,
): Promise<PublishingResult> {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const job = await tx.job.findFirst({ where: { id: jobId, workspaceId } }) as any;
    if (!job || !isPublishingJob(job)) return fail('NOT_FOUND', 'Publishing job not found.', 404);
    if (!leaseStillHeld(job, opts)) {
      return failureBody('JOB_NOT_CLAIMABLE', 'Job is no longer held by this publisher.', 409, null, job);
    }
    const gate = await gateForJob(tx, workspaceId, job);
    if (!gate) return settleLostApproval(tx, workspaceId, job, actor, opts);

    const platform = (job.payload as any).platform as PublishingPlatform;
    const code = String(failure.code || 'PLATFORM_TEMPORARY_ERROR');
    const classification = classifyPublishingFailure(code);
    const attempts = Number.isFinite(failure.attempts) ? failure.attempts : Number(job.attempts);
    const settled = await failJob(
      jobId,
      {
        error: `PUBLISHING_${code}`,
        retryable: classification.retryable,
        nextRunAt: classification.retryable
          ? new Date(Date.now() + publishingBackoffMs(attempts))
          : null,
      },
      { workspaceId, actor: actor ?? null, leaseId: opts.leaseId, workerId: opts.workerId },
      tx,
    ) as any;

    await writeAuditEvent({
      workspaceId,
      userId: actor ?? null,
      runId: null,
      type: 'publishing_attempt_failed',
      actor: actor ?? null,
      data: {
        jobId,
        platform,
        code,
        retryable: classification.retryable,
        providerStatus: Number.isInteger(failure.providerStatus) ? failure.providerStatus : null,
        attempts,
        status: settled?.status ?? null,
        noNetworkCall: false,
      },
      tx,
    });

    return failureBody(
      code,
      redactText(failure.message).slice(0, 300),
      publishingHttpStatus(code),
      getPublishingAdapter(platform),
      settled ?? job,
    );
  });
}

/**
 * Success settlement for a REAL adapter. A ContentPost may only be written
 * from a verified platform response containing a real externalId, and only
 * while the approved gate and this publisher's lease are still held.
 */
export async function settleRealPublishingSuccess(
  workspaceId: string,
  jobId: string,
  result: { externalId: string; url?: string | null; publishedAt?: Date | null },
  actor: string | null,
  opts: PublishingSettlementOptions = {},
): Promise<PublishingResult> {
  const externalId = typeof result?.externalId === 'string' ? result.externalId.trim() : '';
  if (!externalId || externalId.length > 255) {
    return fail('INVALID_PLATFORM_RESULT', 'A real externalId is required to record a publish.', 502);
  }
  const url = safePlatformUrl(result.url);
  const publishedAt = result.publishedAt instanceof Date && Number.isFinite(result.publishedAt.getTime())
    ? result.publishedAt
    : null;

  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const job = await tx.job.findFirst({ where: { id: jobId, workspaceId } }) as any;
    if (!job || !isPublishingJob(job)) return fail('NOT_FOUND', 'Publishing job not found.', 404);
    if (!leaseStillHeld(job, opts)) {
      return failureBody('JOB_NOT_CLAIMABLE', 'Job is no longer held by this publisher.', 409, null, job);
    }
    const gate = await gateForJob(tx, workspaceId, job);
    if (!gate) return settleLostApproval(tx, workspaceId, job, actor, opts);

    const payload = job.payload as any;
    const existing = await tx.contentPost.findFirst({
      where: { workspaceId, platform: payload.platform, externalId },
    }) as any;
    if (!existing) {
      await tx.contentPost.create({
        data: {
          workspaceId,
          platform: payload.platform,
          externalId,
          title: payload.options?.title ?? null,
          url,
          publishedAt,
          format: payload.entity?.type ?? null,
        },
      });
    }
    const settled = await completeJob(jobId, {
      workspaceId,
      actor: actor ?? null,
      leaseId: opts.leaseId ?? job.leaseId ?? null,
      workerId: opts.workerId ?? job.leaseOwner ?? actor ?? null,
    }, tx) as any;
    await writeAuditEvent({
      workspaceId,
      userId: actor ?? null,
      runId: null,
      type: 'publishing_job_succeeded',
      actor: actor ?? null,
      data: {
        jobId,
        platform: payload.platform,
        externalId,
        status: 'SUCCEEDED',
      },
      tx,
    });
    return {
      statusCode: 200,
      body: {
        job: publicJob(settled),
        result: { ok: true, externalId, url, publishedAt },
      },
    };
  });
}

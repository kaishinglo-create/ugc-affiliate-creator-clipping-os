import { withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';
import { redactText } from '../lib/redaction.js';
import {
  executeLivePublishing,
  type PublishingFetch,
  type PublishingLookup,
} from './publishing-adapters.js';
import { claimJobById, completeJob, createJob, failJob } from './jobs.js';

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
  return PUBLISHING_PLATFORMS.map((platform) =>
    getPublishingAdapter(platform, byProvider.get(platform) ?? null),
  );
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
  };
}

async function findApprovedGate(
  tx: any,
  workspaceId: string,
  platform: PublishingPlatform,
  entityType: string,
  entityId: string,
  idempotencyKey: string,
  approvalId: string | null,
): Promise<any | null> {
  const where: any = {
    workspaceId,
    entityType: PUBLISHING_APPROVAL_ENTITY_TYPE,
    entityId: publishingApprovalEntityId(platform, entityType, entityId, idempotencyKey),
    status: 'approved',
  };
  if (approvalId) where.id = approvalId;
  // Approved decisions are final in this app, but an explicit decidedAt check
  // prevents a hand-crafted row from being treated as a human decision.
  const rows = await tx.approval.findMany({ where, orderBy: { decidedAt: 'desc' }, take: 1 }) as any[];
  const row = rows?.[0];
  return row?.decidedAt ? row : null;
}

async function gateForJob(tx: any, workspaceId: string, job: any): Promise<any | null> {
  const payload = job.payload as any;
  const approval = payload?.approval ?? {};
  if (!isPublishingPlatform(payload?.platform)) return null;
  if (!KEY_RE.test(String(payload?.idempotencyKey ?? ''))) return null;
  const expectedEntityId = publishingApprovalEntityId(
    payload.platform,
    String(payload.entity?.type ?? ''),
    String(payload.entity?.id ?? ''),
    String(payload.idempotencyKey),
  );
  if (approval?.entityId !== expectedEntityId) return null;
  return findApprovedGate(
    tx,
    workspaceId,
    payload.platform,
    String(payload.entity?.type ?? ''),
    String(payload.entity?.id ?? ''),
    String(payload.idempotencyKey),
    approval?.id ? String(approval.id) : null,
  );
}

/**
 * Enqueue a publish attempt. No network call is made here. The approval gate is
 * checked inside the same workspace transaction that creates the durable Job,
 * so a rejected/forged approval can never leave a RUNNING upload behind.
 */
export async function enqueuePublishingJob(input: EnqueuePublishingInput): Promise<PublishingResult> {
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

  const maxAttempts = Number.isFinite(Number(input.maxAttempts))
    && Number(input.maxAttempts) >= 1
    && Number(input.maxAttempts) <= 10
    ? Math.floor(Number(input.maxAttempts))
    : PUBLISHING_DEFAULT_MAX_ATTEMPTS;

  return withWorkspaceTransaction(input.workspaceId, async (tx) => {
    const approval = await findApprovedGate(
      tx, input.workspaceId, platform, entityType, entityId, idempotencyKey, approvalId,
    );
    if (!approval) {
      return fail(
        'APPROVAL_REQUIRED',
        'A matching approved Approval is required before a publishing job can be queued.',
        409,
      );
    }

    const fingerprint = JSON.stringify([platform, entityType, entityId]);
    const payload = {
      kind: 'publishing',
      schemaVersion: 1,
      platform,
      entity: { type: entityType, id: entityId },
      idempotencyKey,
      fingerprint,
      approval: {
        id: approval.id,
        entityType: PUBLISHING_APPROVAL_ENTITY_TYPE,
        entityId: publishingApprovalEntityId(platform, entityType, entityId, idempotencyKey),
      },
      options: normalizeOptions(input.options),
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
  if (code === 'INVALID_MEDIA_INPUT' || code === 'INVALID_PLATFORM_RESULT' || code === 'INVALID_INPUT') return 400;
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'TOKEN_EXPIRED') return 401;
  return 502;
}

/** Copy only the exact variables required by this platform; never spread process.env. */
function liveCredentials(platform: PublishingPlatform): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PUBLISHING_CONTRACTS[platform].requiredEnv) {
    const value = process.env[name]?.trim();
    if (value) out[name] = value;
  }
  return out;
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
    const adapter = getPublishingAdapter(platform);
    const liveEnabled = isPublishingLiveOptInEnabled()
      && adapter.status !== 'NOT_CONFIGURED'
      && adapter.credentials.present;
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
  let live: Awaited<ReturnType<typeof executeLivePublishing>>;
  try {
    live = await executeLivePublishing({
      platform,
      workspaceId,
      jobId,
      idempotencyKey: String((claimed.payload as any).idempotencyKey ?? ''),
      options: ((claimed.payload as any).options ?? {}) as Record<string, string | null>,
      env: liveCredentials(platform),
    }, {
      fetch: opts.fetch ?? globalThis.fetch,
      lookup: opts.lookup,
      timeoutMs: opts.timeoutMs,
      pollIntervalMs: opts.pollIntervalMs,
      maxPolls: opts.maxPolls,
      sleep: opts.sleep,
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
  if (live.ok) {
    return settleRealPublishingSuccess(workspaceId, jobId, live.value, actor, settlement);
  }
  return settleRealPublishingFailure(workspaceId, jobId, {
    code: live.code,
    message: live.message,
    retryable: live.retryable,
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

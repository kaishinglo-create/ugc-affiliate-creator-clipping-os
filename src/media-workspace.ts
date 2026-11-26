/** Workspace-scoped media scratch paths and client-safe error/projection helpers. */
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { redactText } from '../lib/redaction.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Jobs use the existing Job model; AGENT_TASK is ignored by the automatic engine. */
export const MEDIA_JOB_CATEGORY = 'MEDIA';
export const MEDIA_JOB_KIND = 'media_clip';

/** Default cap for a single authenticated upload (overridable, always bounded). */
export function mediaUploadLimitBytes(): number {
  const configured = Number(process.env.UGC_MEDIA_MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024);
  return Number.isFinite(configured) ? Math.max(1024, Math.min(32 * 1024 * 1024, Math.trunc(configured))) : 8 * 1024 * 1024;
}

export function workspaceMediaRoot(workspaceId: string): string {
  const configured = process.env.UGC_MEDIA_TMP_DIR?.trim() || tmpdir();
  const base = isAbsolute(configured) ? configured : resolve(configured);
  return join(base, 'ugc-media', workspaceId);
}

/** Resolve a basename only; traversal and absolute inputs are rejected. */
export function workspaceMediaPath(workspaceId: string, name: unknown): string {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..')) {
    throw Object.assign(new Error('INVALID_MEDIA_NAME'), { statusCode: 400 });
  }
  return join(workspaceMediaRoot(workspaceId), name);
}

/** Map pipeline error codes to honest HTTP statuses. */
export function mediaErrorStatus(error: unknown): number {
  const code = (error as any)?.code;
  if (Number.isInteger((error as any)?.statusCode)) return Number((error as any).statusCode);
  if (code === 'NOT_CONFIGURED') return 503;
  if (code === 'INVALID_INPUT' || code === 'MEDIA_NOT_FOUND' || code === 'INVALID_MEDIA_NAME') return 400;
  return 502;
}

type SafeMediaErrorDetails = {
  binary?: string;
  exitCode?: number;
  signal?: string;
  reason?: string;
};

/** Remove absolute/relative filesystem paths and secret assignments from free text. */
function scrubClientText(value: string): string {
  return redactText(value)
    .replace(/(?:[A-Za-z]:)?\/[^\s'"\\]+/g, '[PATH_REDACTED]')
    .replace(/\.\.?\/[^\s'"\\]+/g, '[PATH_REDACTED]')
    .slice(0, 240);
}

/**
 * Client-facing media errors never expose absolute paths or captured stderr.
 * Those remain available internally for logs/audits; only stable classification
 * fields are returned to the workspace user.
 */
export function mediaErrorBody(error: unknown): { error: string; code: string; details?: SafeMediaErrorDetails } {
  const code = String((error as any)?.code ?? (error as any)?.message ?? 'MEDIA_PIPELINE_FAILED');
  const message = error instanceof Error ? error.message : 'MEDIA_PIPELINE_FAILED';
  const raw = (error as any)?.details;
  const safe: SafeMediaErrorDetails = {};
  if (raw && typeof raw === 'object') {
    if (typeof raw.binary === 'string') safe.binary = raw.binary.slice(0, 32).replace(/[^\w-]/g, '');
    if (Number.isInteger(raw.exitCode)) safe.exitCode = raw.exitCode;
    if (typeof raw.signal === 'string') safe.signal = raw.signal.slice(0, 32).replace(/[^\w-]/g, '');
    if (typeof raw.reason === 'string' && /^[A-Za-z0-9_.,;:() -]{1,120}$/.test(raw.reason)) {
      safe.reason = scrubClientText(raw.reason);
    }
  }
  const hasDetails = Object.keys(safe).length > 0;
  return { error: scrubClientText(message), code: scrubClientText(code), ...(hasDetails ? { details: safe } : {}) };
}

export function isMediaJob(job: unknown): boolean {
  const row = job as any;
  return Boolean(
    row
      && row.category === MEDIA_JOB_CATEGORY
      && row.payload
      && (row.payload as any).kind === MEDIA_JOB_KIND,
  );
}

/** Status projections contain no absolute paths, stderr, or environment values. */
export function publicMediaJob(job: any): any {
  if (!job) return null;
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  return {
    id: job.id,
    status: job.status,
    type: job.type,
    category: job.category,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    payload: {
      kind: MEDIA_JOB_KIND,
      stage: typeof payload.stage === 'string' ? payload.stage : 'queued',
      progress: Number.isFinite(payload.progress) ? Number(payload.progress) : 0,
      ...(payload.error ? { error: mediaErrorBody(payload.error) } : {}),
      ...(payload.result !== undefined ? { result: payload.result } : {}),
    },
  };
}

/** Workspace-scoped media scratch paths. Every path stays under one temp root. */
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
  if (code === 'INVALID_INPUT' || code === 'MEDIA_NOT_FOUND') return 400;
  return 502;
}

type SafeMediaErrorDetails = {
  binary?: string;
  exitCode?: number;
  signal?: string;
  reason?: string;
};

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
    if (typeof raw.binary === 'string') safe.binary = raw.binary.slice(0, 32);
    if (Number.isInteger(raw.exitCode)) safe.exitCode = raw.exitCode;
    if (typeof raw.signal === 'string') safe.signal = raw.signal.slice(0, 32);
    if (typeof raw.reason === 'string' && raw.reason.length <= 120) safe.reason = raw.reason;
  }
  const hasDetails = Object.keys(safe).length > 0;
  return { error: message, code, ...(hasDetails ? { details: safe } : {}) };
}

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

export function mediaErrorBody(error: unknown): { error: string; code: string; details?: unknown } {
  const code = String((error as any)?.code ?? (error as any)?.message ?? 'MEDIA_PIPELINE_FAILED');
  const message = error instanceof Error ? error.message : 'MEDIA_PIPELINE_FAILED';
  return { error: message, code, details: (error as any)?.details ?? undefined };
}

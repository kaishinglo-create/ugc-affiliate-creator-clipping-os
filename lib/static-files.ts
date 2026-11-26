import { lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export type StaticPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'INVALID_PATH' | 'FORBIDDEN' | 'NOT_FOUND' };

/**
 * Resolves a user-supplied path inside `publicDir` without following symlinks
 * and without allowing traversal. The lexical path must equal the real path,
 * so even an in-tree symlink is rejected instead of silently serving another
 * file.
 */
export async function resolvePublicFile(publicDir: string, relPath: string): Promise<StaticPathResult> {
  const cleaned = String(relPath ?? 'index.html').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0')) return { ok: false, reason: 'INVALID_PATH' };

  let root: string;
  try {
    root = await realpath(resolve(publicDir));
  } catch {
    return { ok: false, reason: 'NOT_FOUND' };
  }

  const lexical = resolve(root, cleaned);
  if (lexical === root) return { ok: false, reason: 'NOT_FOUND' };
  if (!lexical.startsWith(root + sep)) return { ok: false, reason: 'FORBIDDEN' };

  let info;
  try {
    info = await lstat(lexical);
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ok: false, reason: 'NOT_FOUND' };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) return { ok: false, reason: info.isSymbolicLink() ? 'FORBIDDEN' : 'NOT_FOUND' };

  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    return { ok: false, reason: 'NOT_FOUND' };
  }
  // Any symlink component (including a parent directory) makes the real path
  // differ from the lexical path; refuse it rather than following it.
  if (real !== lexical || !real.startsWith(root + sep)) return { ok: false, reason: 'FORBIDDEN' };
  return { ok: true, path: real };
}

/**
 * Phase G media ingestion: persistent, workspace-scoped media sources with
 * checksums, rights metadata and safe storage paths.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { probeMedia } from './video/clipping.js';
import { mediaUploadLimitBytes, workspaceMediaPath, workspaceMediaRoot } from './media-workspace.js';

const ALLOWED_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'audio/wav', 'audio/mpeg', 'audio/ogg']);
const ALLOWED_RIGHTS = new Set(['AUTHORIZED', 'RESTRICTED', 'UNKNOWN']);

function normalizeName(name: unknown): string {
  const value = String(name ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes('..')) {
    throw Object.assign(new Error('INVALID_MEDIA_NAME'), { statusCode: 400 });
  }
  return value;
}

function rightsStatus(value: unknown): string {
  const status = String(value ?? 'UNKNOWN').toUpperCase();
  return ALLOWED_RIGHTS.has(status) ? status : 'UNKNOWN';
}

function safeUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) throw Object.assign(new Error('INVALID_SOURCE_URL'), { statusCode: 400 });
  let url: URL;
  try { url = new URL(raw); } catch { throw Object.assign(new Error('INVALID_SOURCE_URL'), { statusCode: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('INVALID_SOURCE_URL'), { statusCode: 400 });
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    throw Object.assign(new Error('SSRF_BLOCKED'), { statusCode: 400 });
  }
  return raw.slice(0, 2_000);
}

export async function registerUpload(input: {
  workspaceId: string;
  name: unknown;
  mimeType: unknown;
  data: Buffer;
  rights?: unknown;
  licenseNote?: unknown;
}): Promise<any> {
  const name = normalizeName(input.name);
  const mimeType = String(input.mimeType ?? '').toLowerCase();
  if (!ALLOWED_MIME.has(mimeType)) throw Object.assign(new Error('UNSUPPORTED_MIME'), { statusCode: 400 });
  const limit = mediaUploadLimitBytes();
  if (!Buffer.isBuffer(input.data) || input.data.length === 0 || input.data.length > limit) {
    throw Object.assign(new Error('INVALID_UPLOAD_SIZE'), { statusCode: 400 });
  }
  const sha256 = createHash('sha256').update(input.data).digest('hex');
  const status = rightsStatus(input.rights);
  if (status !== 'AUTHORIZED') throw Object.assign(new Error('MEDIA_NOT_AUTHORIZED'), { statusCode: 403 });

  const duplicate = await withWorkspaceTransaction(input.workspaceId, (tx: any) =>
    tx.mediaSource.findFirst({ where: { workspaceId: input.workspaceId, sha256 } }));
  if (duplicate) return duplicate;

  const path = workspaceMediaPath(input.workspaceId, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.data, { flag: 'wx' }).catch((error: any) => {
    if (error?.code === 'EEXIST') throw Object.assign(new Error('DUPLICATE_MEDIA_NAME'), { statusCode: 409 });
    throw error;
  });

  return withWorkspaceTransaction(input.workspaceId, (tx: any) => tx.mediaSource.create({
    data: {
      workspaceId: input.workspaceId,
      kind: 'UPLOAD',
      name,
      mimeType,
      sizeBytes: input.data.length,
      sha256,
      storagePath: path,
      rightsStatus: status,
      licenseNote: input.licenseNote ? String(input.licenseNote).slice(0, 2_000) : null,
      status: 'READY',
    },
  }));
}

export async function registerUrlSource(input: {
  workspaceId: string;
  name: unknown;
  sourceUrl: unknown;
  mimeType?: unknown;
  rights?: unknown;
  licenseNote?: unknown;
}): Promise<any> {
  const name = normalizeName(input.name);
  const sourceUrl = safeUrl(input.sourceUrl);
  const status = rightsStatus(input.rights);
  if (status !== 'AUTHORIZED') throw Object.assign(new Error('MEDIA_NOT_AUTHORIZED'), { statusCode: 403 });
  const sha256 = createHash('sha256').update(sourceUrl).digest('hex');
  const duplicate = await withWorkspaceTransaction(input.workspaceId, (tx: any) =>
    tx.mediaSource.findFirst({ where: { workspaceId: input.workspaceId, sha256 } }));
  if (duplicate) return duplicate;
  return withWorkspaceTransaction(input.workspaceId, (tx: any) => tx.mediaSource.create({
    data: {
      workspaceId: input.workspaceId,
      kind: 'URL',
      name,
      mimeType: String(input.mimeType ?? 'video/mp4').slice(0, 100),
      sizeBytes: 0,
      sha256,
      storagePath: '',
      sourceUrl,
      rightsStatus: status,
      licenseNote: input.licenseNote ? String(input.licenseNote).slice(0, 2_000) : null,
      status: 'PENDING',
    },
  }));
}

export async function listMediaSources(workspaceId: string, take = 100): Promise<any[]> {
  return withWorkspaceTransaction<any[]>(workspaceId, (tx: any) => tx.mediaSource.findMany({
    where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: Math.min(500, Math.max(1, take)),
    select: {
      id: true, kind: true, name: true, mimeType: true, sizeBytes: true, sha256: true,
      sourceUrl: true, rightsStatus: true, licenseNote: true, status: true,
      createdAt: true, updatedAt: true,
    },
  }));
}

export async function updateMediaRights(workspaceId: string, id: string, rights: unknown, licenseNote?: unknown): Promise<any | null> {
  const status = rightsStatus(rights);
  return withWorkspaceTransaction<any>(workspaceId, (tx: any) => tx.mediaSource.updateMany({
    where: { id, workspaceId },
    data: { rightsStatus: status, ...(licenseNote !== undefined ? { licenseNote: String(licenseNote).slice(0, 2_000) } : {}) },
  }).then((result: any) => result?.count === 1));
}

export async function probeMediaSource(workspaceId: string, id: string): Promise<any | null> {
  const row: any = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.mediaSource.findFirst({ where: { id, workspaceId } }));
  if (!row) return null;
  if (!row.storagePath) return { status: 'NO_LOCAL_FILE' };
  const metadata = await probeMedia(row.storagePath);
  await withWorkspaceTransaction(workspaceId, (tx: any) => tx.mediaSource.update({
    where: { id }, data: { ffprobeJson: metadata as any, status: 'READY' },
  }));
  return { status: 'OK', metadata };
}

export { workspaceMediaRoot };

/**
 * Phase G URL media ingestion: bounded download with DNS- and redirect-level
 * SSRF validation. Test doubles can be injected; production uses real DNS and
 * fetch with no implicit trust in caller-supplied hostnames.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { withWorkspaceTransaction } from '../lib/db.js';
import { validateSourceUrl } from './media-ingest.js';
import { mediaUploadLimitBytes, workspaceMediaPath } from './media-workspace.js';
import { probeMedia } from './video/clipping.js';

const ALLOWED_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'audio/wav', 'audio/mpeg', 'audio/ogg']);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface DownloadDeps {
  lookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;
  fetchImpl?: typeof fetch;
  probe?: (path: string) => Promise<unknown>;
}

function blocked(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/** Reject loopback, private, link-local, reserved and IPv4-mapped addresses. */
export function isPrivateAddress(address: string): boolean {
  const value = String(address ?? '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const version = isIP(value);
  if (version === 4) {
    const octets = value.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b, c] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 192 && b === 0 && c === 2)
      || (a === 203 && b === 0 && c === 113);
  }
  if (version === 6) {
    if (value === '::' || value === '::1' || value.startsWith('fe80') || /^f[cd]/.test(value)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  return true;
}

/** Validate the literal URL and every address it resolves to. */
export async function assertPublicUrl(raw: unknown, deps: DownloadDeps = {}): Promise<string> {
  const href = validateSourceUrl(raw);
  const url = new URL(href);
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (host.endsWith('.internal') || host.endsWith('.home.arpa') || host.endsWith('.localhost')) {
    throw blocked('SSRF_BLOCKED');
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw blocked('SSRF_BLOCKED');
    return href;
  }
  const resolve = deps.lookup ?? lookup;
  const resolved = await resolve(host, { all: true, verbatim: true });
  const addresses: Array<{ address: string; family: number }> = Array.isArray(resolved) ? resolved : [resolved];
  if (!addresses.length || addresses.some((entry: { address: string }) => isPrivateAddress(entry.address))) {
    throw blocked('SSRF_BLOCKED');
  }
  return href;
}

/** Download an authorized URL source into the workspace scratch directory. */
export async function downloadUrlSource(workspaceId: string, id: string, deps: DownloadDeps = {}): Promise<any | null> {
  const row: any = await withWorkspaceTransaction(workspaceId, (tx: any) =>
    tx.mediaSource.findFirst({ where: { id: String(id ?? ''), workspaceId } }));
  if (!row) return null;
  if (row.kind !== 'URL' || !row.sourceUrl) throw blocked('INVALID_SOURCE');
  if (row.rightsStatus !== 'AUTHORIZED') {
    throw Object.assign(new Error('MEDIA_NOT_AUTHORIZED'), { statusCode: 403 });
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  let current = await assertPublicUrl(row.sourceUrl, deps);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { 'user-agent': 'ugc-affiliate-clipping-os/1.0' },
    });
    if (REDIRECT_CODES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects === MAX_REDIRECTS) throw blocked('SSRF_BLOCKED');
      current = await assertPublicUrl(new URL(location, current).href, deps);
      continue;
    }
    if (!response.ok) throw Object.assign(new Error('DOWNLOAD_FAILED'), { statusCode: 502 });

    const contentType = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(contentType)) throw blocked('UNSUPPORTED_MIME');
    const limit = mediaUploadLimitBytes();
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > limit) throw blocked('INVALID_UPLOAD_SIZE');

    const chunks: Buffer[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => undefined);
          throw blocked('INVALID_UPLOAD_SIZE');
        }
        chunks.push(Buffer.from(value));
      }
    }
    if (total === 0) throw blocked('INVALID_UPLOAD_SIZE');

    const bytes = Buffer.concat(chunks);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const path = workspaceMediaPath(workspaceId, row.name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' }).catch((error: any) => {
      if (error?.code === 'EEXIST') throw Object.assign(new Error('DUPLICATE_MEDIA_NAME'), { statusCode: 409 });
      throw error;
    });
    try {
      const metadata = await (deps.probe ?? probeMedia)(path);
      const updated: any = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.mediaSource.update({
        where: { id, workspaceId },
        data: {
          storagePath: path,
          sizeBytes: bytes.length,
          sha256,
          status: 'READY',
          ffprobeJson: metadata as any,
        },
        select: {
          id: true, kind: true, name: true, mimeType: true, sizeBytes: true, sha256: true,
          sourceUrl: true, rightsStatus: true, licenseNote: true, status: true,
          createdAt: true, updatedAt: true,
        },
      }));
      return { status: 'OK', source: updated };
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }
  throw blocked('SSRF_BLOCKED');
}

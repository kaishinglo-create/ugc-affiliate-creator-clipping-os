/**
 * Phase G URL media ingestion: bounded download with DNS-, redirect- and
 * connection-level SSRF validation.
 *
 * DNS validation alone is not enough: a hostile DNS server can answer with a
 * public address during validation and a private address during the actual
 * connection (DNS rebinding). Every hop is therefore resolved and validated
 * immediately before the request, and the connection is pinned to one of the
 * *validated* addresses via a custom lookup. No second, unvalidated DNS lookup
 * happens inside the socket layer. TLS defaults are deliberately untouched:
 * certificate verification stays enabled and SNI keeps the URL hostname.
 *
 * Named test doubles can be injected; production uses real DNS plus undici
 * with a per-hop pinned dispatcher.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { withWorkspaceTransaction } from '../lib/db.js';
import { validateSourceUrl } from './media-ingest.js';
import { mediaUploadLimitBytes, workspaceMediaPath } from './media-workspace.js';
import { probeMedia } from './video/clipping.js';

const ALLOWED_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'audio/wav', 'audio/mpeg', 'audio/ogg']);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type PinnedFamily = 4 | 6;

export interface PinnedTarget {
  /** Validated URL of this exact hop. */
  url: string;
  /** Hostname from the URL; used for SNI/hostname validation, never for pinning. */
  hostname: string;
  /** A public address taken from the validated DNS answer set. */
  address: string;
  family: PinnedFamily;
}

export interface PinnedConnectOptions {
  /** Node/undici socket lookup: always returns the validated address. */
  lookup: (_hostname: string, options: any, callback?: any) => void;
  /** TLS certificate verification is explicit and never disabled here. */
  rejectUnauthorized: true;
}

export interface PinnedTransport {
  fetch(url: string, init: Record<string, unknown>): Promise<Response>;
  close(): Promise<void>;
}

export interface DownloadDeps {
  lookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;
  /**
   * Legacy test double. When supplied, no network dispatcher is created; the
   * fake still receives fully validated hop URLs. Not used in production.
   */
  fetchImpl?: typeof fetch;
  probe?: (path: string) => Promise<unknown>;
  /** Test seam for observing/replacing the per-hop pinned transport. */
  transportFactory?: (target: PinnedTarget, connect: PinnedConnectOptions) => PinnedTransport;
}

function blocked(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/** Expand an IPv6 literal into eight 16-bit groups; malformed input fails closed. */
function ipv6Groups(value: string): number[] | null {
  let normalized = value.toLowerCase();
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon < 0) return null;
  const tail = normalized.slice(lastColon + 1);
  if (tail.includes('.')) {
    // Embedded dotted-quad notation (::ffff:127.0.0.1, 64:ff9b::192.0.2.1).
    if (isIP(tail) !== 4) return null;
    const [a, b, c, d] = tail.split('.').map(Number);
    normalized = `${normalized.slice(0, lastColon + 1)}${(a << 8 | b).toString(16)}:${(c << 8 | d).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) => /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN);
  return numbers.some((group) => !Number.isFinite(group)) ? null : numbers;
}

function ipv4FromGroups(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** Reject loopback, private, link-local, reserved and embedded IPv4 addresses. */
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
      || (a === 192 && b === 0 && (c === 2 || c === 0))
      || (a === 192 && b === 88 && c === 99)
      || (a === 203 && b === 0 && c === 113);
  }
  if (version === 6) {
    const groups = ipv6Groups(value);
    if (!groups) return true;
    if (groups.every((group) => group === 0)) return true;
    if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible/deprecated forms.
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
      return isPrivateAddress(ipv4FromGroups(groups[6], groups[7]));
    }
    if (groups.slice(0, 6).every((group) => group === 0) && (groups[6] !== 0 || groups[7] !== 0)) {
      return isPrivateAddress(ipv4FromGroups(groups[6], groups[7]));
    }
    // NAT64 well-known prefix and 6to4 embed an IPv4 destination.
    if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
      return isPrivateAddress(ipv4FromGroups(groups[6], groups[7]));
    }
    if (groups[0] === 0x2002) return isPrivateAddress(ipv4FromGroups(groups[1], groups[2]));
    // ULA, link-local, site-local, multicast, documentation and benchmark ranges.
    if ((groups[0] & 0xfe00) === 0xfc00) return true;
    if ((groups[0] & 0xffc0) === 0xfe80 || (groups[0] & 0xffc0) === 0xfec0) return true;
    if ((groups[0] & 0xff00) === 0xff00) return true;
    if (groups[0] === 0x2001 && (groups[1] === 0x0db8 || groups[1] === 0 || (groups[1] === 2 && (groups[2] & 0xff00) === 0))) return true;
    return false;
  }
  return true;
}

function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

interface ValidatedUrl {
  href: string;
  hostname: string;
  addresses: Array<{ address: string; family: number }>;
}

/** Validate the literal URL, its host name and every DNS answer. */
async function validateUrl(raw: unknown, deps: DownloadDeps): Promise<ValidatedUrl> {
  const href = validateSourceUrl(raw);
  const url = new URL(href);
  const host = hostnameOf(url);
  if (host.endsWith('.internal') || host.endsWith('.home.arpa') || host.endsWith('.localhost')) {
    throw blocked('SSRF_BLOCKED');
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw blocked('SSRF_BLOCKED');
    return { href, hostname: host, addresses: [{ address: host, family: isIP(host) }] };
  }
  const resolve = deps.lookup ?? lookup;
  const resolved = await resolve(host, { all: true, verbatim: true });
  const addresses: Array<{ address: string; family: number }> = Array.isArray(resolved) ? resolved : [resolved];
  if (!addresses.length || addresses.some((entry: { address: string; family: number }) =>
    isPrivateAddress(entry.address) || isIP(entry.address) === 0 || isIP(entry.address) !== entry.family)) {
    throw blocked('SSRF_BLOCKED');
  }
  return { href, hostname: host, addresses };
}

/** Validate a hop URL without resolving it again. */
export async function assertPublicUrl(raw: unknown, deps: DownloadDeps = {}): Promise<string> {
  return (await validateUrl(raw, deps)).href;
}

/**
 * Resolve and fully validate a hop, then select one validated address to pin.
 * The returned address is used by the socket lookup, so DNS rebinding between
 * validation and connect cannot change the peer.
 */
export async function resolvePinnedTarget(raw: unknown, deps: DownloadDeps = {}): Promise<PinnedTarget> {
  const validated = await validateUrl(raw, deps);
  const chosen = validated.addresses.find((entry) => entry.family === 4) ?? validated.addresses[0];
  const family = isIP(chosen.address);
  if (family !== 4 && family !== 6) throw blocked('SSRF_BLOCKED');
  return { url: validated.href, hostname: validated.hostname, address: chosen.address, family };
}

/** Build socket options whose lookup ignores DNS and returns only the pinned IP. */
export function buildPinnedConnectOptions(target: PinnedTarget): PinnedConnectOptions {
  // Policy (public address only) is enforced by resolvePinnedTarget, the only
  // production caller. This helper builds the transport for an already chosen
  // address and deliberately does not re-run DNS policy checks.
  if (isIP(target.address) !== target.family) throw blocked('SSRF_BLOCKED');
  const lookupForSocket = (_hostname: string, options: any, callback?: any): void => {
    void _hostname;
    const cb = typeof options === 'function' ? options : callback;
    const all = Boolean(options && typeof options === 'object' && options.all === true);
    if (typeof cb !== 'function') throw blocked('INVALID_LOOKUP_CALLBACK');
    if (all) cb(null, [{ address: target.address, family: target.family }]);
    else cb(null, target.address, target.family);
  };
  // No `servername` override: undici derives SNI from the URL hostname. No TLS
  // bypass: Node's default certificate verification remains in force.
  return { lookup: lookupForSocket, rejectUnauthorized: true };
}

/** Agent with one validated address pinned; exported for focused transport tests. */
export function createPinnedAgent(target: PinnedTarget): Agent {
  return new Agent({ connect: buildPinnedConnectOptions(target) as any });
}

function defaultPinnedTransport(target: PinnedTarget): PinnedTransport {
  const agent = createPinnedAgent(target);
  return {
    fetch: (url, init) => undiciFetch(url, { ...init, dispatcher: agent } as any) as unknown as Promise<Response>,
    close: async () => { await agent.close(); },
  };
}

function legacyTransport(fetchImpl: typeof fetch): PinnedTransport {
  return {
    fetch: (url, init) => fetchImpl(url, init as RequestInit),
    close: async () => undefined,
  };
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

  let current = String(row.sourceUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    // Every hop is validated afresh. In production the connection is pinned to
    // this hop's own validated IP; a reused agent would trust a stale answer.
    const target = deps.fetchImpl ? null : await resolvePinnedTarget(current, deps);
    if (deps.fetchImpl) await assertPublicUrl(current, deps);
    const connect = target ? buildPinnedConnectOptions(target) : null;
    const transport = deps.fetchImpl ? legacyTransport(deps.fetchImpl)
      : deps.transportFactory && target && connect ? deps.transportFactory(target, connect)
        : target ? defaultPinnedTransport(target) : null;
    if (!transport) throw blocked('INVALID_TRANSPORT');

    try {
      const response = await transport.fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        headers: { 'user-agent': 'ugc-affiliate-clipping-os/1.0' },
      });
      if (REDIRECT_CODES.has(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === MAX_REDIRECTS) throw blocked('SSRF_BLOCKED');
        // No pinning carries over: the next hop gets its own DNS validation.
        current = new URL(location, current).href;
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
    } finally {
      await transport.close();
    }
  }
  throw blocked('SSRF_BLOCKED');
}

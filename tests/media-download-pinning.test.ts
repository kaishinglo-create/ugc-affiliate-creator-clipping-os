import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import { createSecureContext } from 'node:tls';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { prisma } from '../lib/db.js';
import { registerUrlSource } from '../src/media-ingest.js';
import {
  buildPinnedConnectOptions,
  createPinnedAgent,
  isPrivateAddress,
  resolvePinnedTarget,
  type PinnedConnectOptions,
  type PinnedTarget,
  type PinnedTransport,
} from '../src/media-download.js';
import { downloadUrlSource } from '../src/media-download.js';
import { workspaceMediaPath } from '../src/media-workspace.js';

const PUBLIC_IPV4 = '93.184.216.34';
const PUBLIC_IPV6 = '2606:4700::1111';
const PUBLIC_DNS = async () => [{ address: PUBLIC_IPV4, family: 4 }];
const PUBLIC_DNS_V6 = async () => [{ address: PUBLIC_IPV6, family: 6 }];
const PRIVATE_DNS = async () => [{ address: '127.0.0.1', family: 4 }];

const workspaceIds: string[] = [];

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.$disconnect();
});

async function workspace(): Promise<string> {
  const id = randomUUID();
  workspaceIds.push(id);
  await prisma.workspace.create({ data: { id, name: 'Pinning test', slug: id } });
  return id;
}

function socketLookupResult(connect: PinnedConnectOptions, options: unknown = {}): Promise<{ address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    const cb = (error: Error | null, addressOrList: any, family?: number) => {
      if (error) return reject(error);
      resolve(Array.isArray(addressOrList) ? addressOrList : [{ address: addressOrList, family }]);
    };
    connect.lookup('anything.test', options, cb);
  });
}

describe('Phase G pinned media transport (DNS rebinding hardening)', () => {
  it('classifies reserved IPv4/IPv6 ranges and embedded IPv4 forms fail-closed', async () => {
    for (const address of [
      '10.0.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '192.0.0.1',
      '192.0.2.1', '192.88.99.1', '198.18.0.1', '203.0.113.1', '224.0.0.1',
      '::1', 'fe81::1', 'febf::1', 'fc00::1', 'fd12::1', 'ff02::1',
      '2001:db8::1', '::ffff:7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '2001:4860:4860::8888']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('pins IPv4 DNS answers to one validated address for both lookup styles', async () => {
    const target = await resolvePinnedTarget('https://example.test/video.mp4', { lookup: PUBLIC_DNS });
    expect(target).toMatchObject({ hostname: 'example.test', address: PUBLIC_IPV4, family: 4 });
    const connect = buildPinnedConnectOptions(target);
    expect(connect.rejectUnauthorized).toBe(true);
    // No SNI override: undici keeps the URL hostname for TLS hostname checks.
    expect(connect).not.toHaveProperty('servername');
    expect(await socketLookupResult(connect)).toEqual([{ address: PUBLIC_IPV4, family: 4 }]);
    expect(await socketLookupResult(connect, { all: true })).toEqual([{ address: PUBLIC_IPV4, family: 4 }]);
  });

  it('pins IPv6 answers and rejects private, mixed or mismatched-family answers', async () => {
    const v6 = await resolvePinnedTarget('https://v6.example.test/video.mp4', { lookup: PUBLIC_DNS_V6 });
    expect(v6).toMatchObject({ address: PUBLIC_IPV6, family: 6 });
    expect(await socketLookupResult(buildPinnedConnectOptions(v6))).toEqual([{ address: PUBLIC_IPV6, family: 6 }]);

    await expect(resolvePinnedTarget('https://example.test/v.mp4', { lookup: PRIVATE_DNS }))
      .rejects.toThrow('SSRF_BLOCKED');
    await expect(resolvePinnedTarget('https://example.test/v.mp4', {
      lookup: async () => [{ address: PUBLIC_IPV4, family: 4 }, { address: '10.0.0.1', family: 4 }],
    })).rejects.toThrow('SSRF_BLOCKED');
    await expect(resolvePinnedTarget('https://example.test/v.mp4', {
      lookup: async () => [{ address: PUBLIC_IPV4, family: 6 }],
    })).rejects.toThrow('SSRF_BLOCKED');
  });

  it('never re-resolves between validation and connect (rebinding guard)', async () => {
    let calls = 0;
    const flippingLookup = async () => {
      calls += 1;
      return calls === 1 ? [{ address: PUBLIC_IPV4, family: 4 }] : [{ address: '169.254.169.254', family: 4 }];
    };
    const target = await resolvePinnedTarget('https://rebind.test/v.mp4', { lookup: flippingLookup });
    expect(calls).toBe(1);
    // The socket lookup must ignore the (now hostile) resolver entirely.
    expect(await socketLookupResult(buildPinnedConnectOptions(target)))
      .toEqual([{ address: PUBLIC_IPV4, family: 4 }]);
    expect(calls).toBe(1);
    // The next hop is validated independently and is rejected.
    await expect(resolvePinnedTarget('https://rebind.test/next.mp4', { lookup: flippingLookup }))
      .rejects.toThrow('SSRF_BLOCKED');
  });

  it('validates and re-pins every redirect hop, then stores a checksummed source', async () => {
    const workspaceId = await workspace();
    const source: any = await registerUrlSource({
      workspaceId, name: 'pinned.mp4', sourceUrl: 'https://origin.test/start.mp4', rights: 'AUTHORIZED',
    });
    const seen: Array<{ target: PinnedTarget; connect: PinnedConnectOptions; closed: boolean }> = [];
    const bytes = 'authorized-media-bytes-for-pinned-download';
    const hops = [
      new Response(null, { status: 302, headers: { location: 'https://cdn.test/clip.mp4' } }),
      new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4' } }),
    ];
    let hop = 0;
    const transportFactory = (target: PinnedTarget, connect: PinnedConnectOptions): PinnedTransport => {
      const record = { target, connect, closed: false };
      seen.push(record);
      return {
        fetch: async () => hops[hop++],
        close: async () => { record.closed = true; },
      };
    };
    const result: any = await downloadUrlSource(workspaceId, source.id, {
      lookup: async (hostname: string) => [{ address: hostname === 'cdn.test' ? '8.8.8.8' : PUBLIC_IPV4, family: 4 }],
      transportFactory,
      probe: async () => ({ streams: [], format: { duration: '1' } }),
    });
    expect(result.status).toBe('OK');
    expect(seen.map((entry) => entry.target.hostname)).toEqual(['origin.test', 'cdn.test']);
    expect(seen.map((entry) => entry.target.address)).toEqual([PUBLIC_IPV4, '8.8.8.8']);
    expect(seen.every((entry) => entry.connect.rejectUnauthorized === true && entry.closed)).toBe(true);
    expect(result.source.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await readFile(workspaceMediaPath(workspaceId, 'pinned.mp4'), 'utf8')).toBe(bytes);
  });

  it('rejects a pinned-path redirect to a private address before any follow-up', async () => {
    const workspaceId = await workspace();
    const source: any = await registerUrlSource({
      workspaceId, name: 'blocked.mp4', sourceUrl: 'https://origin.test/start.mp4', rights: 'AUTHORIZED',
    });
    let calls = 0;
    await expect(downloadUrlSource(workspaceId, source.id, {
      lookup: PUBLIC_DNS,
      transportFactory: () => ({
        fetch: async () => {
          calls += 1;
          return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/latest/meta-data' } });
        },
        close: async () => undefined,
      }),
    })).rejects.toThrow('SSRF_BLOCKED');
    expect(calls).toBe(1);
  });

  it('keeps TLS certificate verification and hostname/SNI validation on pinned connections', async () => {
    // Transport-level check only: a loopback pin connects to the local test
    // server. The downloader itself never accepts private pins (see above).
    const dir = await mkdtemp(path.join(tmpdir(), 'ugc-pinned-tls-'));
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
        '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
      let servername: string | undefined;
      const key = await readFile(path.join(dir, 'key.pem'));
      const cert = await readFile(path.join(dir, 'cert.pem'));
      const server = createServer({
        key,
        cert,
        SNICallback: (name, cb) => {
          servername = name;
          cb(null, createSecureContext({ key, cert }));
        },
      }, (_req, res) => res.end('ok'));
      server.on('secureConnection', (socket) => { servername = servername ?? (socket as any).servername; });
      server.on('tlsClientError', (_error, socket) => { servername = servername ?? (socket as any).servername; });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;
      try {
        const target: PinnedTarget = {
          url: `https://localhost:${port}/`, hostname: 'localhost', address: '127.0.0.1', family: 4,
        };
        let tlsError: any;
        try {
          await undiciFetch(target.url, { dispatcher: createPinnedAgent(target) } as any);
        } catch (error) {
          tlsError = error;
        }
        expect(tlsError).toBeTruthy();
        const detail = `${tlsError?.message ?? ''} ${tlsError?.cause?.message ?? ''} ${tlsError?.cause?.code ?? ''}`;
        expect(detail).toMatch(/certificate|self.signed|unable to verify|UNABLE_TO_VERIFY/i);
        // SNI must remain the URL hostname, not the pinned IP.
        expect(servername).toBe('localhost');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

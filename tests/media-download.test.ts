import 'dotenv/config';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { listMediaSources, registerUrlSource } from '../src/media-ingest.js';
import { assertPublicUrl, downloadUrlSource, isPrivateAddress } from '../src/media-download.js';
import { workspaceMediaPath } from '../src/media-workspace.js';

const workspaceIds: string[] = [];
const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];
const BLOCKED_DNS = async () => [{ address: '127.0.0.1', family: 4 }];

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.$disconnect();
});

async function workspace(): Promise<string> {
  const id = randomUUID();
  workspaceIds.push(id);
  await prisma.workspace.create({ data: { id, name: 'Download test', slug: id } });
  return id;
}

function fakeFetch(body: string, contentType = 'video/mp4', status = 200): typeof fetch {
  return (async () => new Response(body, {
    status,
    headers: { 'content-type': contentType },
  })) as unknown as typeof fetch;
}

describe('Phase G safe URL media download', () => {
  it('classifies private, reserved and mapped addresses as blocked', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', 'not-an-ip']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });

  it('validates DNS answers, not just the literal URL', async () => {
    await expect(assertPublicUrl('https://example.test/video.mp4', { lookup: PUBLIC_DNS }))
      .resolves.toContain('example.test');
    await expect(assertPublicUrl('https://example.test/video.mp4', { lookup: BLOCKED_DNS }))
      .rejects.toThrow('SSRF_BLOCKED');
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data', { lookup: PUBLIC_DNS }))
      .rejects.toThrow('SSRF_BLOCKED');
  });

  it('downloads an authorized source with checksum and READY status', async () => {
    const workspaceId = await workspace();
    const source: any = await registerUrlSource({
      workspaceId, name: 'remote.mp4', sourceUrl: 'https://example.test/video.mp4', rights: 'AUTHORIZED',
    });
    const bytes = 'real-looking authorized media bytes';
    const result: any = await downloadUrlSource(workspaceId, source.id, {
      lookup: PUBLIC_DNS,
      fetchImpl: fakeFetch(bytes),
      probe: async () => ({ streams: [], format: { duration: '1' } }),
    });
    expect(result.status).toBe('OK');
    expect(result.source.status).toBe('READY');
    expect(result.source.sizeBytes).toBe(Buffer.byteLength(bytes));
    expect(result.source.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await stat(workspaceMediaPath(workspaceId, 'remote.mp4'))).size).toBe(Buffer.byteLength(bytes));
    expect(await readFile(path.join(workspaceMediaRootFor(workspaceId), 'remote.mp4'), 'utf8')).toBe(bytes);
  });

  it('rejects redirects to private addresses and unauthorized sources', async () => {
    const workspaceId = await workspace();
    const source: any = await registerUrlSource({
      workspaceId, name: 'redirect.mp4', sourceUrl: 'https://example.test/video.mp4', rights: 'AUTHORIZED',
    });
    const redirectFetch = (async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/secret' },
    })) as unknown as typeof fetch;
    await expect(downloadUrlSource(workspaceId, source.id, {
      lookup: PUBLIC_DNS,
      fetchImpl: redirectFetch,
    })).rejects.toThrow('SSRF_BLOCKED');
    const unchanged: any = (await listMediaSources(workspaceId)).find((row: any) => row.id === source.id);
    expect(unchanged.status).toBe('PENDING');

    const restricted: any = await registerUrlSource({
      workspaceId, name: 'restricted.mp4', sourceUrl: 'https://example.test/restricted.mp4', rights: 'AUTHORIZED',
    });
    await withWorkspaceTransaction(workspaceId, (tx: any) => tx.mediaSource.update({
      where: { id: restricted.id }, data: { rightsStatus: 'RESTRICTED' },
    }));
    await expect(downloadUrlSource(workspaceId, restricted.id, { lookup: PUBLIC_DNS, fetchImpl: fakeFetch('x') }))
      .rejects.toThrow('MEDIA_NOT_AUTHORIZED');
  });
});

function workspaceMediaRootFor(workspaceId: string): string {
  return path.dirname(workspaceMediaPath(workspaceId, 'remote.mp4'));
}

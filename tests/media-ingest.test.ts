import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/db.js';
import { listMediaSources, registerUpload, registerUrlSource, updateMediaRights } from '../src/media-ingest.js';

const workspaceIds: string[] = [];

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.$disconnect();
});

async function workspace(): Promise<string> {
  const id = randomUUID();
  workspaceIds.push(id);
  await prisma.workspace.create({ data: { id, name: 'Media ingest test', slug: id } });
  return id;
}

describe('Phase G media ingestion', () => {
  it('stores an authorized upload with sha256 and deduplicates it', async () => {
    const workspaceId = await workspace();
    const data = Buffer.from('%PDF-1.7 fake bytes merely for checksum validation');
    const first: any = await registerUpload({
      workspaceId, name: 'source.bin', mimeType: 'video/mp4', data,
      rights: 'AUTHORIZED', licenseNote: 'Self-created test material',
    });
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.rightsStatus).toBe('AUTHORIZED');
    const second: any = await registerUpload({
      workspaceId, name: 'other.bin', mimeType: 'video/mp4', data,
      rights: 'AUTHORIZED',
    });
    expect(second.id).toBe(first.id);
    expect(await listMediaSources(workspaceId)).toHaveLength(1);
  });

  it('refuses uploads without authorization', async () => {
    const workspaceId = await workspace();
    await expect(registerUpload({
      workspaceId, name: 'blocked.bin', mimeType: 'video/mp4', data: Buffer.from('x'), rights: 'UNKNOWN',
    })).rejects.toThrow('MEDIA_NOT_AUTHORIZED');
  });

  it('rejects private source URLs and records authorized URL sources', async () => {
    const workspaceId = await workspace();
    await expect(registerUrlSource({
      workspaceId, name: 'private', sourceUrl: 'http://127.0.0.1/secret', rights: 'AUTHORIZED',
    })).rejects.toThrow('SSRF_BLOCKED');
    const source: any = await registerUrlSource({
      workspaceId, name: 'remote.mp4', sourceUrl: 'https://example.test/video.mp4', rights: 'AUTHORIZED',
    });
    expect(source.status).toBe('PENDING');
    expect(await updateMediaRights(workspaceId, source.id, 'RESTRICTED', 'Rights expired')).toBe(true);
    const rows = await listMediaSources(workspaceId);
    expect(rows[0].rightsStatus).toBe('RESTRICTED');
  });
});

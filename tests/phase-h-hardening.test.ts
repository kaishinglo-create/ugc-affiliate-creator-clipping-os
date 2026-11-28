import 'dotenv/config';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';
import { resolvePinnedTarget } from '../src/media-download.js';
import { assertPublicHttpsUrl, resolveYouTubeMedia } from '../src/publishing-adapters.js';
import { publishingLocalTimeToUtc } from '../src/publishing.js';
import { workspaceMediaRoot } from '../src/media-workspace.js';

const workspaceIds: string[] = [];
let app: any;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (app) await app.close();
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.$disconnect();
});

async function workspace() {
  const suffix = randomUUID();
  const email = `h5hard-${suffix}@x.com`;
  const signup = await app.inject({
    method: 'POST', url: '/api/auth/signup',
    payload: { email, password: 'password1234', workspaceName: 'H5 hardening', workspaceSlug: `h5hard-${suffix}` },
  });
  expect(signup.statusCode).toBe(201);
  const workspaceId = signup.json().workspace.id;
  workspaceIds.push(workspaceId);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
  return { workspaceId, headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId } };
}

describe('Phase H transport hardening', () => {
  it('rejects rebinding DNS answers for provider and upload endpoints', async () => {
    const privateLookup = async () => [{ address: '127.0.0.1', family: 4 }];
    expect(await assertPublicHttpsUrl('https://upload.example.test/video', privateLookup)).toBeNull();
    await expect(resolvePinnedTarget('https://upload.example.test/video', { lookup: privateLookup }))
      .rejects.toThrow('SSRF_BLOCKED');
    const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const target = await resolvePinnedTarget('https://upload.example.test/video', { lookup: publicLookup });
    expect(target.hostname).toBe('upload.example.test');
    expect(target.address).toBe('93.184.216.34');
  });

  it('resolves DST gaps and ambiguous wall times to null instead of guessing', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(publishingLocalTimeToUtc('2026-03-29T02:30', 'Europe/Berlin', from)).toBeNull();
    expect(publishingLocalTimeToUtc('2026-10-25T02:30', 'Europe/Berlin', from)).toBeNull();
  });

  it('refuses symlinked media that escapes the workspace root', async () => {
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    await prisma.workspace.create({ data: { id: workspaceId, name: 'Symlink H5', slug: workspaceId } });
    const root = workspaceMediaRoot(workspaceId);
    await mkdir(root, { recursive: true });
    const outside = path.join(root, '..', 'outside-secret.mp4');
    await writeFile(outside, 'secret media bytes');
    await symlink(outside, path.join(root, 'link.mp4')).catch(() => undefined);
    await expect(resolveYouTubeMedia(workspaceId, { mediaName: 'link.mp4' }))
      .rejects.toThrow();
  });
});

describe('Phase H webhook containment', () => {
  it('rejects a signature replayed from another workspace or provider', async () => {
    app = await buildServer();
    const first = await workspace();
    const second = await workspace();
    const secret = 'webhook-secret-for-tests';
    vi.stubEnv('AFFILIATE_WEBHOOK_SECRET_TESTNET', secret);
    const payload = { externalEventId: `evt-${randomUUID()}`, amountCents: 500 };
    const raw = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${first.workspaceId}.testnet.${raw}`).digest('hex');
    const send = (workspaceId: string) => app.inject({
      method: 'POST', url: '/api/affiliate/webhooks/testnet',
      headers: {
        'content-type': 'application/json', 'x-workspace-id': workspaceId,
        'x-affiliate-timestamp': timestamp, 'x-affiliate-signature': signature,
      },
      payload: raw,
    });
    expect((await send(first.workspaceId)).statusCode).toBe(201);
    const replay = await send(second.workspaceId);
    expect(replay.statusCode).toBe(401);
  });

  it('caps the raw webhook body while it is being read', async () => {
    const { workspaceId } = await workspace();
    const oversized = JSON.stringify({ externalEventId: 'big', amountCents: 1, padding: 'x'.repeat(300_000) });
    const res = await app.inject({
      method: 'POST', url: '/api/affiliate/webhooks/testnet',
      headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-affiliate-timestamp': String(Date.now()), 'x-affiliate-signature': '0'.repeat(64) },
      payload: oversized,
    });
    expect(res.statusCode).toBe(413);
  });
});

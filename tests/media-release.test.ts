import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { assertClipReleased, requestClipRelease } from '../src/media-release.js';
import { workspaceMediaRoot } from '../src/media-workspace.js';

const workspaceIds: string[] = [];
let app: any;

const FFPROBE_DOUBLE = `#!/bin/sh
cat <<'JSON'
{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"duration":"10.0"},{"index":1,"codec_type":"audio","codec_name":"aac"}],"format":{"format_name":"mp4","duration":"10.0","size":"1000000"}}
JSON
`;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (app) await app.close();
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.$disconnect();
});

async function workspace(): Promise<string> {
  const id = randomUUID();
  workspaceIds.push(id);
  await prisma.workspace.create({ data: { id, name: 'Release test', slug: id } });
  const root = workspaceMediaRoot(id);
  await mkdir(root, { recursive: true });
  const ffprobe = path.join(root, 'ffprobe-release');
  await writeFile(ffprobe, FFPROBE_DOUBLE, { mode: 0o755 });
  vi.stubEnv('FFPROBE_BIN', ffprobe);
  return id;
}

describe('Phase G manual release gate', () => {
  it('creates a pending approval only for a passing quality report', async () => {
    const workspaceId = await workspace();
    const root = workspaceMediaRoot(workspaceId);
    await writeFile(path.join(root, 'clip.mp4'), 'authorized clip bytes');

    const failing = await requestClipRelease({ workspaceId, clipName: 'clip.mp4', rightsStatus: 'UNKNOWN' });
    expect(failing.passed).toBe(false);
    expect(failing.approval).toBeNull();
    const approvalCount = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.approval.count({ where: { workspaceId } }));
    expect(approvalCount).toBe(0);

    const passing = await requestClipRelease({
      workspaceId, clipName: 'clip.mp4', rightsStatus: 'AUTHORIZED', requestedBy: 'operator-1',
    });
    expect(passing.passed).toBe(true);
    expect(passing.approval).toMatchObject({ status: 'pending', entityType: 'media_clip', entityId: 'clip.mp4' });
    const reportCount = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.qualityReport.count({ where: { workspaceId } }));
    expect(reportCount).toBe(2);
  });

  it('blocks export until the approval is decided and binds it to one output', async () => {
    const workspaceId = await workspace();
    const root = workspaceMediaRoot(workspaceId);
    await writeFile(path.join(root, 'clip.mp4'), 'authorized clip bytes');
    const release = await requestClipRelease({ workspaceId, clipName: 'clip.mp4', rightsStatus: 'AUTHORIZED' });
    const approvalId = release.approval!.id;

    await expect(assertClipReleased({ workspaceId, approvalId, outputName: 'clip.mp4' }))
      .rejects.toThrow('CLIP_NOT_APPROVED');

    await withWorkspaceTransaction(workspaceId, (tx: any) => tx.approval.update({
      where: { id: approvalId },
      data: { status: 'approved', decidedBy: 'operator-1', decidedAt: new Date() },
    }));

    await expect(assertClipReleased({ workspaceId, approvalId, outputName: 'other.mp4' }))
      .rejects.toThrow('APPROVAL_OUTPUT_MISMATCH');
    await expect(assertClipReleased({ workspaceId, approvalId, outputName: 'clip.mp4' }))
      .resolves.toMatchObject({ status: 'approved', entityId: 'clip.mp4' });
  });

  it('enforces the gate on the release export route', async () => {
    app = await buildServer();
    const workspaceId = await workspace();
    const root = workspaceMediaRoot(workspaceId);
    await writeFile(path.join(root, 'clip.mp4'), 'authorized clip bytes');
    const suffix = randomUUID();
    const email = `release-${suffix}@x.com`;
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email, password: 'password1234', workspaceName: 'Release API', workspaceSlug: `release-${suffix}` },
    });
    expect(signup.statusCode).toBe(201);
    const apiWorkspaceId = signup.json().workspace.id;
    workspaceIds.push(apiWorkspaceId);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const headers = { cookie: login.headers['set-cookie'], 'x-workspace-id': apiWorkspaceId };
    const apiRoot = workspaceMediaRoot(apiWorkspaceId);
    await mkdir(apiRoot, { recursive: true });
    await writeFile(path.join(apiRoot, 'clip.mp4'), 'authorized clip bytes');
    const ffprobe = path.join(apiRoot, 'ffprobe-release-api');
    await writeFile(ffprobe, FFPROBE_DOUBLE, { mode: 0o755 });
    vi.stubEnv('FFPROBE_BIN', ffprobe);

    const request = await app.inject({
      method: 'POST',
      url: '/api/media/releases/request',
      headers,
      payload: { clipName: 'clip.mp4', rightsStatus: 'AUTHORIZED' },
    });
    expect(request.statusCode).toBe(200);
    const approvalId = request.json().approval.id;

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/media/releases/${approvalId}/export`,
      headers,
      payload: { inputName: 'clip.mp4', outputName: 'clip.mp4', start: 0, duration: 2 },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toContain('CLIP_NOT_APPROVED');

    const listed = await app.inject({ method: 'GET', url: '/api/media/releases', headers });
    expect(listed.json().releases).toHaveLength(1);
    expect(listed.json().releases[0].status).toBe('pending');
  });
});

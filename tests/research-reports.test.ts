import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';
import { persistResearchReport } from '../src/research-reports.js';

const workspaceIds: string[] = [];
let app: any;

afterAll(async () => {
  if (app) await app.close();
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.$disconnect();
});

async function workspace(label: string) {
  const suffix = randomUUID();
  const email = `research-${suffix}@x.com`;
  const signup = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email, password: 'password1234', workspaceName: label, workspaceSlug: `research-${suffix}` },
  });
  expect(signup.statusCode).toBe(201);
  const workspaceId = signup.json().workspace.id;
  workspaceIds.push(workspaceId);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
  return { workspaceId, headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId } };
}

describe('Phase G persistent research reports', () => {
  it('persists an explainable score and links it to a candidate', async () => {
    app = await buildServer();
    const first = await workspace('Research A');
    const second = await workspace('Research B');

    const scored = await app.inject({
      method: 'POST',
      url: '/api/discovery/score',
      headers: first.headers,
      payload: {
        title: 'Review: creator workflow tips',
        rightsStatus: 'authorized',
        affiliateKeywords: ['workflow'],
        candidateId: 'yt-123',
        persist: true,
      },
    });
    expect(scored.statusCode).toBe(200);
    const body = scored.json();
    expect(typeof body.reportId).toBe('string');
    expect(body.overall).not.toBeNull();

    const list = await app.inject({ method: 'GET', url: '/api/discovery/scores', headers: first.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().reports).toHaveLength(1);
    expect(list.json().reports[0]).toMatchObject({ title: body.title ?? 'Review: creator workflow tips', candidateId: 'yt-123', origin: 'heuristic' });

    const detail = await app.inject({ method: 'GET', url: `/api/discovery/scores/${body.reportId}`, headers: first.headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().report.scoreJson.dimensions).toHaveLength(10);
    expect(detail.json().report.overall).toBeCloseTo(body.overall, 6);

    const foreign = await app.inject({ method: 'GET', url: `/api/discovery/scores/${body.reportId}`, headers: second.headers });
    expect(foreign.statusCode).toBe(404);
    const empty = await app.inject({ method: 'GET', url: '/api/discovery/scores', headers: second.headers });
    expect(empty.json().reports).toHaveLength(0);
  });

  it('rejects malformed reports instead of inventing dimension values', async () => {
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    await prisma.workspace.create({ data: { id: workspaceId, name: 'Research invalid', slug: workspaceId } });
    await expect(persistResearchReport({
      workspaceId,
      title: 'broken',
      role: 'OWNER',
      report: { overall: 0.5, dimensions: [], notes: [] },
    })).rejects.toThrow('INVALID_SCORE_REPORT');
  });

  it('enforces the role in the persistence module, not only in the route', async () => {
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    await prisma.workspace.create({ data: { id: workspaceId, name: 'Research module role', slug: workspaceId } });
    const report = { overall: 0.5, dimensions: [{ key: 'quality', value: 0.5, source: 'provided' as const, evidence: 'unit fixture' }], notes: [] };
    await expect(persistResearchReport({ workspaceId, title: 'member write', role: 'MEMBER', report }))
      .rejects.toThrow('INSUFFICIENT_ROLE');
    await expect(persistResearchReport({ workspaceId, title: 'missing role', report }))
      .rejects.toThrow('INSUFFICIENT_ROLE');
    expect(await prisma.researchReport.count({ where: { workspaceId } })).toBe(0);
  });

  it('lets members score but restricts persistent reports to OWNER/ADMIN', async () => {
    app = await buildServer();
    const owner = await workspace('Research roles');
    const suffix = randomUUID();
    const email = `research-member-${suffix}@x.com`;
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: {
        email, password: 'password1234', workspaceName: 'Throwaway', workspaceSlug: `throwaway-${suffix}`,
      },
    });
    expect(signup.statusCode).toBe(201);
    workspaceIds.push(signup.json().workspace.id);
    const member = await prisma.user.findUnique({ where: { email } });
    await prisma.membership.create({ data: { userId: String(member!.id), workspaceId: owner.workspaceId, role: 'MEMBER' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const headers = { cookie: login.headers['set-cookie'], 'x-workspace-id': owner.workspaceId };

    const scored = await app.inject({
      method: 'POST',
      url: '/api/discovery/score',
      headers,
      payload: { title: 'Member scoring is read-only', rightsStatus: 'authorized' },
    });
    expect(scored.statusCode).toBe(200);
    expect(scored.json().reportId).toBeUndefined();

    const denied = await app.inject({
      method: 'POST',
      url: '/api/discovery/score',
      headers,
      payload: { title: 'Member may not persist', rightsStatus: 'authorized', persist: true },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'INSUFFICIENT_ROLE' });

    const list = await app.inject({ method: 'GET', url: '/api/discovery/scores', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().reports).toHaveLength(0);
  });
});

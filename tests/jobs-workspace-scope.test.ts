import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { createJob, getJob, claimJobById, rejectJob, requeueDeadLetterJob } from '../src/jobs.js';

describe('job workspace scope', () => {
  let app: any;
  let workspaceA: string;
  let workspaceB: string;
  let cookieB: string;

  beforeAll(async () => {
    app = await buildServer();
    const emailA = `jws-a-${Date.now()}@x.com`;
    const slugA = `jws-a-${Date.now()}`;
    const resA = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: emailA, password: 'password1234', workspaceName: 'JWSA', workspaceSlug: slugA } });
    workspaceA = resA.json().workspace.id;
    const emailB = `jws-b-${Date.now()}@x.com`;
    const slugB = `jws-b-${Date.now()}`;
    const resB = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: emailB, password: 'password1234', workspaceName: 'JWSB', workspaceSlug: slugB } });
    workspaceB = resB.json().workspace.id;
    const loginB = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: emailB, password: 'password1234' } });
    cookieB = loginB.headers['set-cookie'];
  });

  afterAll(async () => {
    await withWorkspaceTransaction(workspaceA, (tx: any) => tx.job.deleteMany({ where: { workspaceId: workspaceA } }));
    await withWorkspaceTransaction(workspaceB, (tx: any) => tx.job.deleteMany({ where: { workspaceId: workspaceB } }));
    await app.close();
    await prisma.$disconnect();
  });

  it('getJob does not expose foreign workspace job with workspace binding', async () => {
    const job = await createJob({ workspaceId: workspaceA, type: 'WORKFLOW_RUN', category: 'workflow', payload: {}, idempotencyKey: `jws-key-${Date.now()}` });
    expect(await getJob(job.id, workspaceB)).toBeNull();
    expect((await getJob(job.id, workspaceA))?.id).toBe(job.id);
  });

  it('claimJobById rejects foreign workspace binding', async () => {
    const job = await createJob({ workspaceId: workspaceA, type: 'WORKFLOW_RUN', category: 'workflow', payload: {}, idempotencyKey: `jws-claim-${Date.now()}` });
    const claimed = await claimJobById(job.id, 'worker-x', { workspaceId: workspaceB, now: new Date() });
    expect(claimed).toBeNull();
    const fresh: any = await withWorkspaceTransaction(workspaceA, (tx: any) => tx.job.findUnique({ where: { id: job.id } }));
    expect(fresh?.status).toBe('QUEUED');
  });

  it('requeueDeadLetterJob rejects foreign workspace binding mutation', async () => {
    const job = await createJob({ workspaceId: workspaceA, type: 'WORKFLOW_RUN', category: 'workflow', payload: {}, idempotencyKey: `jws-requeue-${Date.now()}` });
    await withWorkspaceTransaction(workspaceA, (tx: any) => tx.job.update({ where: { id: job.id }, data: { status: 'DEAD_LETTER', finishedAt: new Date() } }));
    const result = await requeueDeadLetterJob(job.id, { workspaceId: workspaceB });
    expect(result).toBeNull();
    const fresh: any = await withWorkspaceTransaction(workspaceA, (tx: any) => tx.job.findUnique({ where: { id: job.id } }));
    expect(fresh?.status).toBe('DEAD_LETTER');
  });

  it('rejectJob rejects foreign workspace binding mutation', async () => {
    const job = await createJob({ workspaceId: workspaceA, type: 'WORKFLOW_RUN', category: 'workflow', payload: {}, idempotencyKey: `jws-reject-${Date.now()}` });
    await withWorkspaceTransaction(workspaceA, (tx: any) => tx.job.update({ where: { id: job.id }, data: { status: 'WAITING_FOR_APPROVAL', finishedAt: new Date() } }));
    const result = await rejectJob(job.id, { workspaceId: workspaceB });
    expect(result).toBeNull();
    const fresh: any = await withWorkspaceTransaction(workspaceA, (tx: any) => tx.job.findUnique({ where: { id: job.id } }));
    expect(fresh?.status).toBe('WAITING_FOR_APPROVAL');
  });

  it('cross-workspace job route access is forbidden', async () => {
    const job = await createJob({ workspaceId: workspaceA, type: 'WORKFLOW_RUN', category: 'workflow', payload: {}, idempotencyKey: `jws-route-${Date.now()}` });
    await withWorkspaceTransaction(workspaceA, (tx: any) => tx.job.update({ where: { id: job.id }, data: { status: 'DEAD_LETTER', finishedAt: new Date() } }));
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/requeue`, headers: { cookie: cookieB, 'x-workspace-id': workspaceB }, payload: {} });
    expect(res.statusCode).toBe(404);
    const fresh: any = await withWorkspaceTransaction(workspaceA, (tx: any) => tx.job.findUnique({ where: { id: job.id } }));
    expect(fresh?.status).toBe('DEAD_LETTER');
  });
});

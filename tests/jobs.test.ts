import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';
import { createJob, claimDueJobs, completeJob, failJob, cancelJob, heartbeatJob } from '../src/jobs.js';
import { createDefinition, executeRun, startRun } from '../src/workflows.js';

describe('jobs', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('creates, claims, heartbeats and completes a job', async () => {
    const email = `job-${Date.now()}@x.com`;
    const slug = `job-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'JOB', workspaceSlug: slug } });
    const ws = r.json().workspace.id;

    const job = await createJob({ workspaceId: ws, type: 'WORKFLOW_RUN', category: 'workflow', payload: { hello: 'world' }, idempotencyKey: `job-key-${Date.now()}` });
    expect(job.status).toBe('QUEUED');

    const claimed = await claimDueJobs(ws, 'worker-test', { now: new Date(), limit: 1, leaseTtlMs: 60_000 });
    expect(claimed.length).toBe(1);
    expect(claimed[0].status).toBe('RUNNING');
    expect(claimed[0].leaseOwner).toBe('worker-test');
    expect(claimed[0].attempts).toBe(1);

    const hb = await heartbeatJob(claimed[0].id, claimed[0].leaseId, 'worker-test', { now: new Date() });
    expect(hb.heartbeatAt).not.toBeNull();

    const done = await completeJob(claimed[0].id);
    expect(done.status).toBe('SUCCEEDED');

    await prisma.job.deleteMany({ where: { workspaceId: ws } });
  });

  it('retries with backoff and dead-letters after max attempts', async () => {
    const email = `jobr-${Date.now()}@x.com`;
    const slug = `jobr-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'JOBR', workspaceSlug: slug } });
    const ws = r.json().workspace.id;

    await createJob({ workspaceId: ws, type: 'WORKFLOW_RUN', category: 'workflow', payload: {}, idempotencyKey: `jobr-key-${Date.now()}`, maxAttempts: 2 });
    const claimed = await claimDueJobs(ws, 'worker-test', { now: new Date(), limit: 1, leaseTtlMs: 60_000 });
    const retry = await failJob(claimed[0].id, { error: 'TRANSIENT', retryable: true, maxAttempts: 2 });
    expect(retry.status).toBe('RETRY_WAIT');
    expect(retry.attempts).toBe(1);

    const retryDue = new Date(Date.now() + 60_000);
    const claimed2 = await claimDueJobs(ws, 'worker-test', { now: retryDue, limit: 1, leaseTtlMs: 60_000 });
    expect(claimed2.length).toBe(1);
    const dead = await failJob(claimed2[0].id, { error: 'TRANSIENT', retryable: true, maxAttempts: 2 });
    expect(dead.status).toBe('DEAD_LETTER');
    expect(dead.attempts).toBe(2);

    await prisma.job.deleteMany({ where: { workspaceId: ws } });
  });

  it('rejects duplicate idempotency keys', async () => {
    const email = `jobi-${Date.now()}@x.com`;
    const slug = `jobi-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'JOBI', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const key = `jobi-key-${Date.now()}`;
    const first = await createJob({ workspaceId: ws, type: 'WORKFLOW_RUN', category: 'workflow', payload: { a: 1 }, idempotencyKey: key });
    const second = await createJob({ workspaceId: ws, type: 'WORKFLOW_RUN', category: 'workflow', payload: { a: 1 }, idempotencyKey: key });
    expect(second.id).toBe(first.id);

    await prisma.job.deleteMany({ where: { workspaceId: ws } });
  });

  it('cancels a job and blocks workflow jobs via kill switch', async () => {
    const email = `jobk-${Date.now()}@x.com`;
    const slug = `jobk-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'JOBK', workspaceSlug: slug } });
    const ws = r.json().workspace.id;

    const def = await createDefinition(ws, 'Job kill', [{ name: 'step1', action: 'echo' }]);
    const run = await startRun(ws, def.id, { hello: 'block' }, `jobk-run-${Date.now()}`);
    const createdJobs = await prisma.job.findMany({ where: { workflowRunId: run.id } });
    expect(createdJobs.length).toBe(1);
    expect(createdJobs[0].type).toBe('WORKFLOW_RUN');

    const claimed = await claimDueJobs(ws, 'worker-test', { now: new Date(), limit: 1, leaseTtlMs: 60_000 });
    expect(claimed.length).toBe(1);
    const cancelled = await cancelJob(claimed[0].id, { reason: 'TEST_CANCEL' });
    expect(cancelled.status).toBe('CANCELLED');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const act = await app.inject({ method: 'POST', url: '/api/security/kill-switch/activate', headers: { cookie, 'x-workspace-id': ws }, payload: { reason: 'test-kill' } });
    expect(act.statusCode).toBe(200);
    const executed = await executeRun(ws, run.id);
    expect(executed.status).toBe('cancelled');
    const blockedJobs = await prisma.job.findMany({ where: { workflowRunId: run.id } });
    expect(blockedJobs[0].status).toBe('CANCELLED');

    await prisma.job.deleteMany({ where: { workspaceId: ws } });
  });
});

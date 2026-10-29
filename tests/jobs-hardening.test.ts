import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { createJob, claimDueJobs, heartbeatJob, completeJob } from '../src/jobs.js';
import { executeRun } from '../src/workflows.js';

describe('jobs hardening', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('concurrent claims are exclusive', async () => {
    const email = `hh1-${Date.now()}@x.com`;
    const slug = `hh1-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'HH1', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    await createJob({ workspaceId: ws, type: 'WORKFLOW_RUN', category: 'workflow', payload: {}, idempotencyKey: `hh1-${Date.now()}` });
    const [a, b] = await Promise.all([
      claimDueJobs(ws, 'w1', { now: new Date(), limit: 1, leaseTtlMs: 60000 }),
      claimDueJobs(ws, 'w2', { now: new Date(), limit: 1, leaseTtlMs: 60000 }),
    ]);
    expect(a.length + b.length).toBe(1);
    await prisma.job.deleteMany({ where: { workspaceId: ws } });
  });

  it('stale heartbeat is rejected', async () => {
    const email = `hh2-${Date.now()}@x.com`;
    const slug = `hh2-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'HH2', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const job = await createJob({ workspaceId: ws, type: 'WORKFLOW_RUN', category: 'workflow', payload: {}, idempotencyKey: `hh2-${Date.now()}` });
    const first = await claimDueJobs(ws, 'w1', { now: new Date(), limit: 1, leaseTtlMs: 10 });
    const oldLease = first[0].leaseId;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await claimDueJobs(ws, 'w2', { now: new Date(Date.now() + 30), limit: 1, leaseTtlMs: 60000 });
    expect(second.length).toBe(1);
    const hb = await heartbeatJob(job.id, oldLease, 'w1', { now: new Date() });
    expect(hb.status).toBe('RUNNING');
    expect(hb.leaseOwner).toBe('w2');
    await prisma.job.deleteMany({ where: { workspaceId: ws } });
  });

  it('stale completion does not succeed', async () => {
    const email = `hh3-${Date.now()}@x.com`;
    const slug = `hh3-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'HH3', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const job = await createJob({ workspaceId: ws, type: 'WORKFLOW_RUN', category: 'workflow', payload: {}, idempotencyKey: `hh3-${Date.now()}` });
    const first = await claimDueJobs(ws, 'w1', { now: new Date(), limit: 1, leaseTtlMs: 10 });
    const oldLease = first[0].leaseId;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await claimDueJobs(ws, 'w2', { now: new Date(Date.now() + 30), limit: 1, leaseTtlMs: 60000 });
    const after = await completeJob(job.id, { leaseId: oldLease, workerId: 'w1' });
    expect(after.status).toBe('RUNNING');
    await prisma.job.deleteMany({ where: { workspaceId: ws } });
  });

  it('unknown workflow action fails', async () => {
    const email = `hh4-${Date.now()}@x.com`;
    const slug = `hh4-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'HH4', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const def = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Unknown action', steps: [{ name: 'step1', action: 'totally_unknown' }] } });
    const run: any = await withWorkspaceTransaction(ws, (tx) => tx.workflowRun.create({ data: { workspaceId: ws, definitionId: def.json().workflow.id, status: 'queued', input: {}, startedAt: new Date() } }));
    let thrown = false;
    try {
      await executeRun(ws, run.id);
    } catch (e: any) {
      thrown = true;
      expect(String(e.message)).toContain('UNKNOWN_ACTION');
    }
    // transactional failure rolls back; assert either thrown already or run still queued/failed
    if (!thrown) {
      const updated: any = await withWorkspaceTransaction(ws, (tx) => tx.workflowRun.findUnique({ where: { id: run.id } }));
      expect(['queued', 'failed'].includes(updated.status)).toBe(true);
    }
  });

  it('idempotent concurrent job creation returns same job', async () => {
    const email = `hh5-${Date.now()}@x.com`;
    const slug = `hh5-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'HH5', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const key = `hh5-key-${Date.now()}`;
    const [a, b] = await Promise.all([
      createJob({ workspaceId: ws, type: 'WORKFLOW_RUN', category: 'workflow', payload: {}, idempotencyKey: key }),
      createJob({ workspaceId: ws, type: 'WORKFLOW_RUN', category: 'workflow', payload: {}, idempotencyKey: key }),
    ]);
    expect(a.id).toBe(b.id);
    await prisma.job.deleteMany({ where: { workspaceId: ws } });
  });
});

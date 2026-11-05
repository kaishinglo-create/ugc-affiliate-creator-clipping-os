import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { createJob, claimDueJobs } from '../src/jobs.js';
import { createDefinition, startRun } from '../src/workflows.js';
import { runEngineTick, recoverStaleWorkflowRuns, startEngine } from '../src/engine.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function newWorkspace(app: any, label: string) {
  const slug = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email: `${slug}@x.com`, password: 'password1234', workspaceName: label.toUpperCase(), workspaceSlug: slug },
  });
  return { workspaceId: res.json().workspace.id as string, email: `${slug}@x.com` };
}

async function readJob(workspaceId: string, where: any): Promise<any> {
  return withWorkspaceTransaction<any>(workspaceId, (tx: any) => tx.job.findFirst({ where: { workspaceId, ...where } }));
}

async function readRun(workspaceId: string, runId: string): Promise<any> {
  return withWorkspaceTransaction<any>(workspaceId, (tx: any) => tx.workflowRun.findUnique({ where: { id: runId } }));
}

async function dropWorkspace(workspaceId: string) {
  await withWorkspaceTransaction(workspaceId, (tx) => tx.job.deleteMany({ where: { workspaceId } }));
  await withWorkspaceTransaction(workspaceId, (tx) => tx.workflowRun.deleteMany({ where: { workspaceId } }));
  await withWorkspaceTransaction(workspaceId, (tx) => tx.workflowDefinition.deleteMany({ where: { workspaceId } }));
  await prisma.membership.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
}

describe('autonomous execution engine', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('executes a queued workflow run instead of leaving the job unprocessed', async () => {
    const { workspaceId } = await newWorkspace(app, 'eng-run');
    const def = await createDefinition(workspaceId, 'engine flow', [{ name: 'one', action: 'echo' }]);
    const run = await startRun(workspaceId, def.id, { hello: 'engine' });

    const queuedJob = await readJob(workspaceId, { workflowRunId: run.id });
    expect(queuedJob?.status).toBe('QUEUED');

    const summary = await runEngineTick({ workspaceId, workerId: 'engine-test', leaseTtlMs: 20_000 });
    expect(summary.claimed).toBeGreaterThanOrEqual(1);
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);

    const finishedRun = await readRun(workspaceId, run.id);
    expect(finishedRun?.status).toBe('succeeded');

    const finishedJob = await readJob(workspaceId, { workflowRunId: run.id });
    expect(finishedJob?.status).toBe('SUCCEEDED');

    await dropWorkspace(workspaceId);
  });

  it('recovers a job whose worker died mid-run (expired lease) and completes it', async () => {
    const { workspaceId } = await newWorkspace(app, 'eng-crash');
    const def = await createDefinition(workspaceId, 'crash flow', [{ name: 'one', action: 'echo' }]);
    const run = await startRun(workspaceId, def.id, { hello: 'crash' });

    // Simulate a worker that claimed the job and then vanished: the lease expires
    // without the workflow ever running.
    const claimed = await claimDueJobs(workspaceId, 'dead-worker', { limit: 1, leaseTtlMs: 5_000, types: ['WORKFLOW_RUN'] });
    expect(claimed.length).toBe(1);
    expect(claimed[0].status).toBe('RUNNING');
    expect((await readRun(workspaceId, run.id))?.status).toBe('queued');

    const summary = await runEngineTick({ workspaceId, workerId: 'engine-test', now: new Date(Date.now() + 6_000) });
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);

    const finishedRun = await readRun(workspaceId, run.id);
    expect(finishedRun?.status).toBe('succeeded');
    const finishedJob = await readJob(workspaceId, { workflowRunId: run.id });
    expect(finishedJob?.status).toBe('SUCCEEDED');
    expect(finishedJob?.attempts).toBeGreaterThanOrEqual(2);

    await dropWorkspace(workspaceId);
  });

  it('requeues a run left running by a crashed process and resumes it', async () => {
    const { workspaceId } = await newWorkspace(app, 'eng-stale');
    const def = await createDefinition(workspaceId, 'stale flow', [{ name: 'one', action: 'echo' }]);
    const run = await startRun(workspaceId, def.id, { hello: 'stale' });

    // Abandoned mid-run: status running, no live lease, long past the stale window.
    await withWorkspaceTransaction(workspaceId, (tx) =>
      tx.workflowRun.update({
        where: { id: run.id },
        data: { status: 'running', updatedAt: new Date(Date.now() - 600_000) },
      })
    );

    expect(await recoverStaleWorkflowRuns({ workspaceId, staleMs: 60_000 })).toBe(1);
    expect((await readRun(workspaceId, run.id))?.status).toBe('queued');

    await runEngineTick({ workspaceId, workerId: 'engine-test' });
    expect((await readRun(workspaceId, run.id))?.status).toBe('succeeded');

    await dropWorkspace(workspaceId);
  });

  it('dead-letters work whose workflow run no longer exists', async () => {
    const { workspaceId } = await newWorkspace(app, 'eng-gone');
    const job = await createJob({ workspaceId, type: 'WORKFLOW_RUN', category: 'workflow', payload: { runId: 'run-does-not-exist' } });

    const summary = await runEngineTick({ workspaceId, workerId: 'engine-test' });
    expect(summary.failed).toBeGreaterThanOrEqual(1);

    const failed = await readJob(workspaceId, { id: job.id });
    expect(failed?.status).toBe('FAILED');
    expect(failed?.lastError).toBe('WORKFLOW_RUN_NOT_FOUND');

    await dropWorkspace(workspaceId);
  });

  it('does not execute anything while the kill switch is active', async () => {
    const { workspaceId } = await newWorkspace(app, 'eng-kill');
    const def = await createDefinition(workspaceId, 'kill flow', [{ name: 'one', action: 'echo' }]);
    const run = await startRun(workspaceId, def.id, { hello: 'kill' });

    await withWorkspaceTransaction(workspaceId, (tx) =>
      tx.killSwitch.create({ data: { workspaceId, active: true, reason: 'test', activatedBy: 'test', activatedAt: new Date() } })
    );

    const summary = await runEngineTick({ workspaceId, workerId: 'engine-test' });
    expect(summary.claimed).toBe(0);
    expect((await readRun(workspaceId, run.id))?.status).toBe('queued');

    await dropWorkspace(workspaceId);
  });

  it('is idempotent: a second tick does not re-execute finished work', async () => {
    const { workspaceId } = await newWorkspace(app, 'eng-idem');
    const def = await createDefinition(workspaceId, 'idem flow', [{ name: 'one', action: 'echo' }]);
    const run = await startRun(workspaceId, def.id, { hello: 'idem' });

    await runEngineTick({ workspaceId, workerId: 'engine-test' });
    const second = await runEngineTick({ workspaceId, workerId: 'engine-test' });

    expect(second.claimed).toBe(0);
    const steps = await withWorkspaceTransaction(workspaceId, (tx) => tx.workflowStepRun.count({ where: { runId: run.id } }));
    expect(steps).toBe(1);

    await dropWorkspace(workspaceId);
  });

  it('resumes the blocked workflow once its approval is granted through the API', async () => {
    const { workspaceId, email } = await newWorkspace(app, 'eng-approve');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const headers = { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId };

    const def = await createDefinition(workspaceId, 'approval flow', [{ name: 'one', action: 'echo' }]);
    const approval = await app.inject({ method: 'POST', url: '/api/approvals', headers, payload: { entityType: 'workflow_step', entityId: `${(await startRun(workspaceId, def.id, { hello: 'approve' })).id}#echo` } });
    expect(approval.statusCode).toBe(201);
    const runId = String(approval.json().approval.entityId).split('#')[0];

    await runEngineTick({ workspaceId, workerId: 'engine-test' });
    expect((await readRun(workspaceId, runId))?.status).toBe('waiting_for_approval');
    expect((await readJob(workspaceId, { workflowRunId: runId }))?.status).toBe('WAITING_FOR_APPROVAL');

    const decide = await app.inject({ method: 'POST', url: `/api/approvals/${approval.json().approval.id}/decide`, headers, payload: { status: 'approved', reason: 'go' } });
    expect(decide.statusCode).toBe(200);
    expect(decide.json().resumed).toBeTruthy();
    expect((await readJob(workspaceId, { workflowRunId: runId }))?.status).toBe('QUEUED');

    await runEngineTick({ workspaceId, workerId: 'engine-test' });
    expect((await readRun(workspaceId, runId))?.status).toBe('succeeded');

    await dropWorkspace(workspaceId);
  });

  it('runs work from the background loop and stops cleanly', async () => {
    const { workspaceId } = await newWorkspace(app, 'eng-daemon');
    const def = await createDefinition(workspaceId, 'daemon flow', [{ name: 'one', action: 'echo' }]);
    const run = await startRun(workspaceId, def.id, { hello: 'daemon' });

    const handle = startEngine({ workspaceId, workerId: 'engine-daemon', intervalMs: 250, leaseTtlMs: 20_000 });
    try {
      let status = await readRun(workspaceId, run.id);
      for (let attempt = 0; attempt < 40 && status?.status !== 'succeeded'; attempt++) {
        await sleep(100);
        status = await readRun(workspaceId, run.id);
      }
      expect(status?.status).toBe('succeeded');
      expect(handle.status().running).toBe(true);
      expect(handle.status().lastTickAt).toBeTruthy();
    } finally {
      await handle.stop();
    }
    expect(handle.status().running).toBe(false);

    await dropWorkspace(workspaceId);
  });

  it('exposes runtime status only to workspace members', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/engine/status' });
    expect(anonymous.statusCode).toBe(401);

    const { workspaceId, email } = await newWorkspace(app, 'eng-api');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const status = await app.inject({ method: 'GET', url: '/api/engine/status', headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId } });
    expect(status.statusCode).toBe(200);
    expect(status.json().queue.counts).toBeTruthy();
    expect(typeof status.json().engine.running).toBe('boolean');

    await dropWorkspace(workspaceId);
  });

  it('manual tick endpoint executes work for the calling workspace', async () => {
    const { workspaceId, email } = await newWorkspace(app, 'eng-tick-api');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const headers = { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId };
    const def = await createDefinition(workspaceId, 'api flow', [{ name: 'one', action: 'echo' }]);
    const run = await startRun(workspaceId, def.id, { hello: 'api' });

    const tick = await app.inject({ method: 'POST', url: '/api/engine/tick', headers, payload: {} });
    expect(tick.statusCode).toBe(200);
    expect(tick.json().summary.succeeded).toBeGreaterThanOrEqual(1);
    expect((await readRun(workspaceId, run.id))?.status).toBe('succeeded');

    await dropWorkspace(workspaceId);
  });
});

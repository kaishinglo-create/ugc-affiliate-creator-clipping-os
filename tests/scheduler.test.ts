import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
process.env.DATABASE_URL = 'postgresql://u0_a304@localhost:5432/ugc_os_test';
process.env.JOBSCHEDULER_ENABLED = 'true';
const { buildServer } = await import('../src/index.js');
const { prisma } = await import('../lib/db.js');
const { createDefinition, startRun } = await import('../src/workflows.js');
const { getJob, claimJobById, recoverExpiredJobs, failJob } = await import('../src/jobs.js');
const { startScheduler, stopScheduler, getSchedulerStatus } = await import('../src/scheduler.js');

describe('scheduler runtime', () => {
  let app: any;
  let workspaceId = '';
  const stamp = Date.now();

  beforeAll(async () => {
    app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: `sched-${stamp}@x.com`, password: 'password1234', workspaceName: `sched-${stamp}`, workspaceSlug: `sched-${stamp}` },
    });
    workspaceId = res.json().workspace.id;
  });

  afterAll(async () => {
    await stopScheduler();
    await prisma.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined);
    await app.close();
    await prisma.$disconnect();
  }, 30000);

  it('executes a queued workflow without an HTTP trigger', async () => {
    const def = await createDefinition(workspaceId, `sched-def-${stamp}`, [{ name: 'step1', action: 'echo' }]);
    const run = await startRun(workspaceId, def.id, { value: 1 });
    const queued = await prisma.job.findMany({ where: { workspaceId, workflowRunId: run.id } });
    const jobId = queued[0]?.id;
    expect(jobId).toBeTruthy();

    await startScheduler(true);
    let status = 'QUEUED';
    for (let i = 0; i < 100 && status !== 'SUCCEEDED'; i += 1) {
      const job = await getJob(jobId, workspaceId);
      status = job?.status ?? status;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe('SUCCEEDED');
  });

  it('keeps scheduler status verifiable', async () => {
    const scheduler = getSchedulerStatus();
    expect(scheduler.enabled).toBe(true);
    expect(scheduler.intervalMs).toBeGreaterThanOrEqual(1000);
  });

  it('recovers an expired lease into retry-wait', async () => {
    await stopScheduler();
    await prisma.job.deleteMany({ where: { workspaceId, status: { in: ['QUEUED', 'RETRY_WAIT'] } } });
    const job = await prisma.job.create({
      data: { workspaceId, type: 'WORKFLOW_RUN', status: 'QUEUED', priority: 100, payload: {}, maxAttempts: 3, runAt: new Date() },
    });
    const claimed = await claimJobById(job.id, 'worker-a', { workspaceId, now: new Date(), leaseTtlMs: 1 });
    expect(claimed?.id).toBe(job.id);
    await new Promise((r) => setTimeout(r, 10));
    await recoverExpiredJobs(workspaceId, { now: new Date() });
    const recovered = await getJob(job.id, workspaceId);
    expect(['RETRY_WAIT', 'DEAD_LETTER', 'FAILED']).toContain(recovered?.status);
  });

  it('records retry wait for a failed retryable job', async () => {
    await stopScheduler();
    const job = await prisma.job.create({
      data: { workspaceId, type: 'WORKFLOW_RUN', status: 'QUEUED', priority: 0, payload: {}, maxAttempts: 3, runAt: new Date() },
    });
    const claimed = await claimJobById(job.id, 'worker-b', { workspaceId, now: new Date(), leaseTtlMs: 60000 });
    expect(claimed?.id).toBe(job.id);
    await failJob(job.id, { error: 'TEST_FAILURE', retryable: true }, { workerId: 'worker-b', leaseId: claimed.leaseId, workspaceId });
    const recovered = await getJob(job.id, workspaceId);
    expect(recovered?.status).toBe('RETRY_WAIT');
  });

  it('stops cleanly on request', async () => {
    await stopScheduler();
    const scheduler = getSchedulerStatus();
    expect(scheduler.running).toBe(false);
  });
});

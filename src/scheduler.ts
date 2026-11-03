import { prisma } from '../lib/db.js';
import { withWorkspaceTransaction } from '../lib/db.js';
import { isKillSwitchActive } from '../lib/security.js';
import {
  recoverExpiredJobs,
  runSchedulerOnce,
  heartbeatJob,
  completeJob,
  failJob,
  cancelJob,
} from './jobs.js';

const LOCK_KEY = 0x55474353; // "UGCS"
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_CONCURRENCY = 2;

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  leader: boolean;
  workerId: string;
  intervalMs: number;
  concurrency: number;
  stopping: boolean;
  startedAt: string | null;
  lastTickAt: string | null;
  lastRecoveryAt: string | null;
  lastLeaseAttemptAt: string | null;
  lastClaimedCount: number;
  activeJobs: number;
  lastError: string | null;
}

const status: SchedulerStatus = {
  enabled: false,
  running: false,
  leader: false,
  workerId: `scheduler-${process.pid}`,
  intervalMs: DEFAULT_INTERVAL_MS,
  concurrency: DEFAULT_CONCURRENCY,
  stopping: false,
  startedAt: null,
  lastTickAt: null,
  lastRecoveryAt: null,
  lastLeaseAttemptAt: null,
  lastClaimedCount: 0,
  activeJobs: 0,
  lastError: null,
};

let workerId = status.workerId;
let intervalMs = status.intervalMs;
let concurrency = status.concurrency;
let enabled = false;
let running = false;
let stopping = false;
let loopPromise: Promise<void> | null = null;
let tickPromise: Promise<void> | null = null;
let activeJobCount = 0;
let lockClient: any = null;
let isLeader = false;
const activeJobControllers = new Set<AbortController>();

function nowIso(): string {
  return new Date().toISOString();
}

function truthy(value: string | undefined): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sanitizeError(error: unknown): string {
  return String(error ?? 'UNKNOWN_ERROR').replace(/\r/g, ' ').trim().slice(0, 4000);
}

async function getLockClient(): Promise<any> {
  if (lockClient) return lockClient;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required for scheduler');
  const { Client } = await import('pg');
  const client = new Client({ connectionString });
  await client.connect();
  lockClient = client;
  return lockClient;
}

async function tryAcquireLeader(): Promise<boolean> {
  status.lastLeaseAttemptAt = nowIso();
  const client = await getLockClient();
  const result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
  isLeader = Boolean(result?.rows?.[0]?.locked);
  status.leader = isLeader;
  return isLeader;
}

async function releaseLeader(): Promise<void> {
  if (!lockClient) return;
  try {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  } catch {}
  isLeader = false;
  status.leader = false;
}

async function ensureDatabaseReady(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

async function processClaimedJob(job: any): Promise<void> {
  const jobId = String(job?.id ?? '');
  const workspaceId = String(job?.workspaceId ?? '');
  if (!jobId || !workspaceId) return;

  const controller = new AbortController();
  activeJobControllers.add(controller);
  activeJobCount += 1;
  status.activeJobs = activeJobCount;

  const leaseId = job.leaseId ?? job.leaseId;
  const worker = workerId;
  let heartbeat: NodeJS.Timeout | null = setInterval(() => {
    heartbeatJob(jobId, String(leaseId ?? job.leaseId ?? ''), worker, {
      extendMs: 30000,
      workspaceId,
      now: new Date(),
    }).catch(() => undefined);
  }, 10000);

  try {
    const killActive = await withWorkspaceTransaction(workspaceId, async (tx) => isKillSwitchActive(workspaceId, tx));
    if (killActive) {
      await cancelJob(jobId, { reason: 'KILL_SWITCH_ACTIVE', leaseId: job.leaseId ?? undefined, workerId: worker, workspaceId });
      return;
    }

    if (String(job.type) === 'AGENT_TASK') {
      const payload = (job.payload ?? {}) as Record<string, unknown>;
      const runId = String(payload.orchestrationRunId ?? '');
      if (runId) {
        const mod = await import('./orchestration.js');
        await (mod as any).processOrchestrationJob(workspaceId, runId, jobId, worker, String(job.leaseId ?? ''), new Date(job.leaseExpiresAt ?? Date.now() + 30000));
        return;
      }
    }

    if (String(job.type) === 'WORKFLOW_RUN') {
      const payload = (job.payload ?? {}) as Record<string, unknown>;
      const runId = String(payload.runId ?? '');
      if (runId) {
        const mod = await import('./workflows.js');
        const run = await (mod as any).executeRun(workspaceId, runId);
        if (run?.status === 'succeeded') {
          await completeJob(jobId, { leaseId: job.leaseId ?? undefined, workerId: worker, workspaceId });
        } else if (run?.status === 'waiting_for_approval') {
          await (await import('./jobs.js')).markWaitingForApproval(jobId, { leaseId: job.leaseId ?? undefined, workerId: worker, workspaceId });
        } else if (run?.status === 'cancelled') {
          await cancelJob(jobId, { reason: 'WORKFLOW_CANCELLED', leaseId: job.leaseId ?? undefined, workerId: worker, workspaceId });
        } else {
          await failJob(jobId, { error: String(run?.error ?? 'WORKFLOW_FAILED'), retryable: false }, { leaseId: job.leaseId ?? undefined, workerId: worker, workspaceId });
        }
        return;
      }
    }

    await failJob(
      jobId,
      { error: 'UNKNOWN_JOB_TYPE_OR_PAYLOAD', retryable: false, permanent: true },
      { leaseId: job.leaseId ?? undefined, workerId: worker, workspaceId }
    );
  } catch (error) {
    await failJob(
      jobId,
      { error: sanitizeError(error), retryable: true },
      { leaseId: job.leaseId ?? undefined, workerId: worker, workspaceId }
    ).catch(() => undefined);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    activeJobControllers.delete(controller);
    activeJobCount = Math.max(0, activeJobCount - 1);
    status.activeJobs = activeJobCount;
  }
}

async function processClaimedJobs(jobs: any[]): Promise<void> {
  if (!Array.isArray(jobs) || jobs.length === 0) return;
  let index = 0;
  const runBatch = async () => {
    const batch: Promise<void>[] = [];
    for (let i = 0; i < concurrency && index < jobs.length; i += 1) {
      const job = jobs[index];
      index += 1;
      batch.push(processClaimedJob(job));
    }
    if (batch.length > 0) await Promise.all(batch);
  };
  while (index < jobs.length) {
    await runBatch();
  }
}

async function tick(): Promise<void> {
  if (stopping || !running || !isLeader) return;
  const now = new Date();
  await recoverExpiredJobs(null, { now });
  status.lastRecoveryAt = nowIso();
  const claimed = await runSchedulerOnce({
    now,
    batchSize: concurrency * 2,
    leaseTtlMs: 30000,
    workerId,
  });
  status.lastClaimedCount = claimed.length;
  status.lastTickAt = nowIso();
  status.lastError = null;
  await processClaimedJobs(claimed);
}

async function loop(): Promise<void> {
  try {
    await ensureDatabaseReady();
    await tryAcquireLeader();
    if (!isLeader) {
      status.lastError = 'NOT_LEADER';
    } else {
      await recoverExpiredJobs(null, { now: new Date() });
      status.lastRecoveryAt = nowIso();
    }

    while (!stopping) {
      if (isLeader) {
        tickPromise = tick().catch((error) => {
          status.lastError = sanitizeError(error);
        });
        await tickPromise;
        tickPromise = null;
      } else {
        await tryAcquireLeader();
        if (isLeader) {
          await recoverExpiredJobs(null, { now: new Date() });
          status.lastRecoveryAt = nowIso();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } catch (error) {
    status.lastError = sanitizeError(error);
  } finally {
    running = false;
    status.running = false;
    await releaseLeader();
    try {
      if (lockClient) await lockClient.end();
    } catch {}
    lockClient = null;
  }
}

export function getSchedulerStatus(): SchedulerStatus {
  status.enabled = enabled;
  status.running = running;
  status.stopping = stopping;
  status.workerId = workerId;
  status.intervalMs = intervalMs;
  status.concurrency = concurrency;
  status.activeJobs = activeJobCount;
  return { ...status };
}

export async function startScheduler(force = false): Promise<SchedulerStatus> {
  enabled = truthy(process.env.JOBSCHEDULER_ENABLED) || force;
  status.enabled = enabled;
  if (!enabled) return getSchedulerStatus();
  if (running && !stopping) return getSchedulerStatus();

  intervalMs = numberEnv('JOBSCHEDULER_INTERVAL_MS', intervalMs || DEFAULT_INTERVAL_MS, 1000, 300000);
  concurrency = numberEnv('JOBSCHEDULER_CONCURRENCY', concurrency || DEFAULT_CONCURRENCY, 1, 16);
  workerId = process.env.JOBSCHEDULER_WORKER_ID?.trim() || `scheduler-${process.pid}`;
  status.workerId = workerId;
  status.intervalMs = intervalMs;
  status.concurrency = concurrency;
  status.enabled = true;
  stopping = false;
  running = true;
  status.running = true;
  status.startedAt = nowIso();
  status.lastError = null;

  if (!loopPromise || process.env.JOBSCHEDULER_ENABLED) {
    loopPromise = loop().finally(() => {
      loopPromise = null;
    });
  }
  return getSchedulerStatus();
}

export async function stopScheduler(timeoutMs = 30000): Promise<void> {
  if (!running) {
    running = false;
    status.running = false;
    return;
  }
  stopping = true;
  status.stopping = true;
  const start = Date.now();
  while (loopPromise || tickPromise) {
    if (Date.now() - start > timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const controller of activeJobControllers) controller.abort();
  await releaseLeader();
  if (lockClient) {
    try { await lockClient.end(); } catch {}
    lockClient = null;
  }
  running = false;
  status.running = false;
  stopping = false;
  status.stopping = false;
}

export async function restartScheduler(): Promise<SchedulerStatus> {
  await stopScheduler();
  return startScheduler(true);
}

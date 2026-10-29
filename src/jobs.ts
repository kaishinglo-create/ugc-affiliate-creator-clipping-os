import { randomUUID } from 'node:crypto';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';

export const DEFAULT_JOB_MAX_ATTEMPTS = 3;
export const DEFAULT_JOB_LEASE_TTL_MS = 30_000;

export type JobStatusValue =
  | 'QUEUED'
  | 'RUNNING'
  | 'RETRY_WAIT'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'DEAD_LETTER'
  | 'WAITING_FOR_APPROVAL';

export type JobTypeValue = 'WORKFLOW_RUN' | 'AGENT_TASK';

export interface CreateJobInput {
  workspaceId: string;
  type: JobTypeValue;
  category?: string | null;
  priority?: number;
  payload: any;
  idempotencyKey?: string | null;
  maxAttempts?: number;
  workflowRunId?: string | null;
}

export interface JobFailureInput {
  error: string;
  retryable?: boolean;
  nextRunAt?: Date;
  maxAttempts?: number;
}

const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_CAP_MS = 30_000;

function computeBackoffMs(attempt: number): number {
  const exp = Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)));
  return exp + Math.floor(Math.random() * 100);
}

export async function createJob(input: CreateJobInput): Promise<any> {
  return withWorkspaceTransaction(input.workspaceId, async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx.job.findUnique({
        where: {
          workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey },
        },
      });
      if (existing) return existing;
    }
    return tx.job.create({
      data: {
        workspaceId: input.workspaceId,
        type: input.type,
        category: input.category ?? null,
        status: 'QUEUED',
        priority: input.priority ?? 0,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey ?? null,
        maxAttempts: input.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
        workflowRunId: input.workflowRunId ?? null,
        runAt: new Date(),
      },
    });
  });
}

export async function getJob(jobId: string): Promise<any> {
  return prisma.job.findUnique({ where: { id: jobId } });
}

export async function claimDueJobs(
  workspaceId: string,
  workerId: string,
  opts: { now?: Date; limit?: number; leaseTtlMs?: number } = {},
): Promise<any[]> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 1;
  const leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_JOB_LEASE_TTL_MS;
  const claimed: any[] = [];

  for (let i = 0; i < limit; i += 1) {
    const job = await withWorkspaceTransaction(workspaceId, async (tx) => {
      const candidates = await tx.job.findMany({
        where: {
          workspaceId,
          status: { in: ['QUEUED', 'RETRY_WAIT'] },
          runAt: { lte: now },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
        orderBy: [{ runAt: 'asc' }, { createdAt: 'asc' }],
        take: 1,
      });
      if (candidates.length === 0) return null;
      const target = candidates[0];
      return tx.job.update({
        where: { id: target.id, status: { in: ['QUEUED', 'RETRY_WAIT'] } },
        data: {
          status: 'RUNNING',
          startedAt: now,
          leaseId: randomUUID(),
          leaseOwner: workerId,
          leaseExpiresAt: new Date(now.getTime() + leaseTtlMs),
          attempts: { increment: 1 },
        },
      });
    });

    if (!job) break;
    claimed.push(job);
  }

  return claimed;
}

export async function heartbeatJob(
  jobId: string,
  leaseId: string,
  workerId: string,
  opts: { extendMs?: number; now?: Date } = {},
): Promise<any> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status !== 'RUNNING') return null;
  if (job.leaseId !== leaseId || job.leaseOwner !== workerId) return null;
  const now = opts.now ?? new Date();
  return prisma.job.update({
    where: { id: jobId },
    data: {
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + (opts.extendMs ?? DEFAULT_JOB_LEASE_TTL_MS)),
    },
  });
}

export async function completeJob(jobId: string): Promise<any> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status !== 'RUNNING') return job;
  return prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'SUCCEEDED',
      finishedAt: new Date(),
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    },
  });
}

export async function failJob(jobId: string, input: JobFailureInput): Promise<any> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status !== 'RUNNING' && job.status !== 'RETRY_WAIT') return job;

  const attempts = job.attempts;
  const maxAttempts = input.maxAttempts ?? job.maxAttempts;
  const retryable = input.retryable ?? true;
  const finishedAt = new Date();
  const base: any = {
    attempts,
    lastError: input.error,
    finishedAt,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
  };

  if (!retryable) {
    return prisma.job.update({ where: { id: jobId }, data: { ...base, status: 'FAILED' } });
  }

  if (attempts >= maxAttempts) {
    return prisma.job.update({ where: { id: jobId }, data: { ...base, status: 'DEAD_LETTER' } });
  }

  return prisma.job.update({
    where: { id: jobId },
    data: {
      ...base,
      status: 'RETRY_WAIT',
      runAt: new Date(finishedAt.getTime() + computeBackoffMs(attempts)),
    },
  });
}

export async function cancelJob(jobId: string, opts: { reason?: string; actor?: string | null } = {}): Promise<any> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status === 'SUCCEEDED' || job.status === 'FAILED' || job.status === 'DEAD_LETTER' || job.status === 'CANCELLED') return job;
  const now = new Date();
  return prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'CANCELLED',
      finishedAt: now,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastError: opts.reason ?? job.lastError ?? null,
    },
  });
}

export async function markWaitingForApproval(jobId: string, opts: { actor?: string | null; data?: unknown } = {}) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status !== 'RUNNING') return job;
  const now = new Date();
  const updated = await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'WAITING_FOR_APPROVAL',
      finishedAt: now,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    },
  });
  await writeAuditEvent({
    workspaceId: job.workspaceId,
    runId: job.workflowRunId,
    type: 'job_waiting_for_approval',
    actor: opts.actor ?? null,
    data: { jobId, status: 'WAITING_FOR_APPROVAL', ...(opts.data as any) },
  });
  return updated;
}

export async function resumeAfterApproval(jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status !== 'WAITING_FOR_APPROVAL') return job;
  return prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'QUEUED',
      finishedAt: null,
      runAt: new Date(),
    },
  });
}

export async function rejectJob(jobId: string, opts: { error?: string; actor?: string | null } = {}) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status !== 'WAITING_FOR_APPROVAL') return job;
  const updated = await prisma.job.update({
    where: { id: jobId },
    data: { status: 'FAILED', finishedAt: new Date(), lastError: opts.error ?? 'APPROVAL_REJECTED' },
  });
  await writeAuditEvent({
    workspaceId: job.workspaceId,
    runId: job.workflowRunId,
    type: 'approval_rejected',
    actor: opts.actor ?? null,
    data: { jobId, status: 'FAILED', error: opts.error ?? 'APPROVAL_REJECTED' },
  });
  return updated;
}

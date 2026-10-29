import { randomUUID } from 'node:crypto';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';
import { isKillSwitchActive } from '../lib/security.js';

export const DEFAULT_JOB_MAX_ATTEMPTS = 3;
export const DEFAULT_JOB_LEASE_TTL_MS = 30_000;
export const DEFAULT_JOB_TIMEOUT_MS = 300_000;
export const DEFAULT_JOB_SCHEDULER_BATCH_SIZE = 10;
export const DEFAULT_JOB_WORKER_CONCURRENCY = 1;

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
  payload: unknown;
  idempotencyKey?: string | null;
  maxAttempts?: number;
  runAt?: Date | null;
  timeoutMs?: number | null;
  timeoutAt?: Date | null;
  parentJobId?: string | null;
  workflowRunId?: string | null;
  agentTaskId?: string | null;
}

export interface ClaimJobsOptions {
  now?: Date;
  limit?: number;
  leaseTtlMs?: number;
  workerId?: string;
  priorityBoost?: number;
}

export interface HeartbeatOptions {
  extendMs?: number;
  now?: Date;
}

export interface FailJobInput {
  error?: string;
  retryable?: boolean;
  nextRunAt?: Date | null;
  maxAttempts?: number;
  leaseId?: string | null;
  workerId?: string | null;
  claimId?: string | null;
  leaseOwner?: string | null;
  timeout?: boolean;
  permanent?: boolean;
}

export interface JobActionOptions {
  reason?: string | null;
  actor?: string | null;
  leaseId?: string | null;
  workerId?: string | null;
  data?: unknown;
  error?: string | null;
}

export interface RequeueOptions {
  actor?: string | null;
  reason?: string | null;
  maxAttempts?: number;
  leaseId?: string | null;
  workerId?: string | null;
}

export interface SchedulerOptions {
  now?: Date;
  workspaceId?: string | null;
  workerId?: string;
  batchSize?: number;
  limit?: number;
  leaseTtlMs?: number;
}

export type JobLeaseInfo = {
  leaseId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
};

function toNow(input?: Date | null): Date {
  if (input instanceof Date && Number.isFinite(input.getTime())) return input;
  return new Date();
}

function sanitizeJobError(error: unknown): string {
  const normalized = String(error ?? 'UNKNOWN_ERROR')
    .replace(/\r/g, ' ')
    .trim()
    .slice(0, 4_000);
  return normalized
    .replace(/(password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1:[REDACTED]');
}

function normalizeLeaseResult(row: any): any {
  if (!row) return row;
  return row;
}

function leaseMatches(job: any, leaseId?: string | null, workerId?: string | null): boolean {
  if (!job) return false;
  if (leaseId && job.leaseId !== leaseId) return false;
  if (workerId && job.leaseOwner !== workerId) return false;
  return true;
}

function transitionAllowed(from: string, to: string): boolean {
  const transitions: Record<string, string[]> = {
    QUEUED: ['RUNNING', 'CANCELLED', 'FAILED'],
    RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'RETRY_WAIT', 'DEAD_LETTER', 'WAITING_FOR_APPROVAL'],
    RETRY_WAIT: ['RUNNING', 'CANCELLED', 'FAILED'],
    WAITING_FOR_APPROVAL: ['QUEUED', 'RUNNING', 'FAILED', 'CANCELLED'],
    SUCCEEDED: [],
    FAILED: [],
    CANCELLED: [],
    DEAD_LETTER: ['QUEUED'],
  };
  return (transitions[from] ?? []).includes(to);
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

    const now = new Date();
    const runAt = input.runAt ? toNow(input.runAt) : now;
    const timeoutAt = input.timeoutAt
      ? toNow(input.timeoutAt)
      : input.timeoutMs
        ? new Date(now.getTime() + Math.max(1, Number(input.timeoutMs)))
        : null;

    try {
      return await tx.job.create({
        data: {
          workspaceId: input.workspaceId,
          type: input.type,
          category: input.category ?? null,
          status: 'QUEUED',
          priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
          payload: input.payload,
          idempotencyKey: input.idempotencyKey ?? null,
          maxAttempts: input.maxAttempts && input.maxAttempts > 0 ? input.maxAttempts : DEFAULT_JOB_MAX_ATTEMPTS,
          parentJobId: input.parentJobId ?? null,
          workflowRunId: input.workflowRunId ?? null,
          agentTaskId: input.agentTaskId ?? null,
          runAt,
          timeoutAt,
        },
      });
    } catch (e: any) {
      if (input.idempotencyKey && (e?.code === 'P2002' || String(e?.message ?? '').includes('Unique constraint'))) {
        const existing = await prisma.job.findUnique({
          where: {
            workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey },
          },
        });
        if (existing) return existing;
      }
      throw e;
    }
  });
}

export async function getJob(jobId: string): Promise<any> {
  return prisma.job.findUnique({ where: { id: jobId } });
}

export async function getJobs(workspaceId: string, filters: any = {}): Promise<any[]> {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const where: any = { workspaceId };
    if (filters?.status) where.status = filters.status;
    if (filters?.type) where.type = filters.type;
    if (filters?.workflowRunId) where.workflowRunId = filters.workflowRunId;
    if (filters?.agentTaskId) where.agentTaskId = filters.agentTaskId;
    return tx.job.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { runAt: 'asc' }, { createdAt: 'asc' }],
      take: Number.isFinite(Number(filters?.limit)) ? Number(filters.limit) : undefined,
      skip: Number.isFinite(Number(filters?.offset)) ? Number(filters.offset) : undefined,
    });
  });
}

export async function listJobs(workspaceId: string, filters: any = {}): Promise<any[]> {
  return getJobs(workspaceId, filters);
}

export async function claimJob(workspaceId: string, workerId: string, opts: ClaimJobsOptions = {}): Promise<any | null> {
  const rows = await claimDueJobs(workspaceId, workerId, { ...opts, limit: 1 });
  return rows.length > 0 ? rows[0] : null;
}

export async function claimDueJobs(workspaceId: string, workerId: string, opts: ClaimJobsOptions = {}): Promise<any[]> {
  const now = toNow(opts.now);
  const limit = Math.max(1, Math.min(100, Number(opts.limit ?? 1) || 1));
  const leaseTtlMs = Math.max(1, Number(opts.leaseTtlMs ?? DEFAULT_JOB_LEASE_TTL_MS) || DEFAULT_JOB_LEASE_TTL_MS);

  const killActive = await withWorkspaceTransaction(workspaceId, async (tx) => {
    await recoverWorkspaceExpiredJobs(tx, workspaceId, now);
    return isKillSwitchActive(workspaceId, tx);
  });
  if (killActive) return [];

  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);

  const rows = await withWorkspaceTransaction(workspaceId, async (tx) => {
    return tx.$queryRaw`
      UPDATE "Job" AS j
      SET status = 'RUNNING'::"JobStatus",
          "startedAt" = COALESCE(j."startedAt", ${now}),
          "leaseId" = ${leaseId},
          "leaseOwner" = ${workerId},
          "leaseExpiresAt" = ${leaseExpiresAt},
          "attempts" = j."attempts" + 1,
          "updatedAt" = ${now}
      WHERE j."id" IN (
        SELECT k."id"
        FROM "Job" AS k
        WHERE k."workspaceId" = ${workspaceId}
          AND k."status"::text IN ('QUEUED', 'RETRY_WAIT')
          AND k."runAt" <= ${now}
          AND (k."leaseExpiresAt" IS NULL OR k."leaseExpiresAt" < ${now})
          AND (
            k."timeoutAt" IS NULL OR k."timeoutAt" > ${now}
          )
        ORDER BY k."priority" DESC, k."runAt" ASC, k."createdAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING j.*;
    `;
  });

  return Array.isArray(rows) ? rows.map(normalizeLeaseResult) : [];
}

export async function recoverExpiredJobs(workspaceId?: string | null, opts?: { now?: Date; scope?: string } | Date): Promise<void> {
  const options = opts instanceof Date ? { now: opts } : (opts ?? {});
  const now = toNow(options.now);
  if (workspaceId) {
    await withWorkspaceTransaction(workspaceId, async (tx) => {
      await recoverWorkspaceExpiredJobs(tx, workspaceId, now);
    });
    return;
  }

  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  for (const workspace of workspaces) {
    try {
      await withWorkspaceTransaction(workspace.id, async (tx) => {
        await recoverWorkspaceExpiredJobs(tx, workspace.id, now);
      });
    } catch {
      continue;
    }
  }
}

async function recoverWorkspaceExpiredJobs(tx: any, workspaceId: string, now: Date): Promise<void> {
  await tx.$executeRaw`
    UPDATE "Job"
    SET status = CASE WHEN attempts >= "maxAttempts" THEN 'DEAD_LETTER'::"JobStatus" ELSE 'RETRY_WAIT'::"JobStatus" END,
        "runAt" = CASE WHEN attempts >= "maxAttempts" THEN "runAt" ELSE ${now} END,
        "finishedAt" = CASE WHEN attempts >= "maxAttempts" THEN ${now} ELSE "finishedAt" END,
        "lastError" = CASE WHEN "lastError" IS NULL THEN 'LEASE_EXPIRED' ELSE "lastError" END,
        "leaseId" = NULL,
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL,
        "heartbeatAt" = NULL,
        "updatedAt" = ${now}
    WHERE "workspaceId" = ${workspaceId}
      AND status = 'RUNNING'::"JobStatus"
      AND "leaseExpiresAt" IS NOT NULL
      AND "leaseExpiresAt" < ${now}
  `;

  await tx.$executeRaw`
    UPDATE "Job"
    SET status = CASE WHEN attempts >= "maxAttempts" THEN 'DEAD_LETTER'::"JobStatus" ELSE 'RETRY_WAIT'::"JobStatus" END,
        "runAt" = CASE WHEN attempts >= "maxAttempts" THEN "runAt" ELSE ${now} END,
        "finishedAt" = CASE WHEN attempts >= "maxAttempts" THEN ${now} ELSE "finishedAt" END,
        "lastError" = 'JOB_TIMEOUT',
        "leaseId" = NULL,
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL,
        "heartbeatAt" = NULL,
        "updatedAt" = ${now}
    WHERE "workspaceId" = ${workspaceId}
      AND status = 'RUNNING'::"JobStatus"
      AND "timeoutAt" IS NOT NULL
      AND "timeoutAt" < ${now}
  `;
}

export async function heartbeatJob(jobId: string, leaseId: string, workerId: string, opts: HeartbeatOptions = {}): Promise<any> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status !== 'RUNNING') return job;
  if (!leaseMatches(job, leaseId, workerId)) return job;
  const now = toNow(opts.now);
  if (job.leaseExpiresAt && job.leaseExpiresAt < now) return job;

  const renewedUntil = new Date(now.getTime() + (opts.extendMs ?? DEFAULT_JOB_LEASE_TTL_MS));
  const result = await prisma.job.updateMany({
    where: {
      id: jobId,
      status: 'RUNNING',
      leaseId,
      leaseOwner: workerId,
      leaseExpiresAt: { gte: now },
    },
    data: {
      heartbeatAt: now,
      leaseExpiresAt: renewedUntil,
      updatedAt: now,
    },
  });
  if (result.count !== 1) {
    return prisma.job.findUnique({ where: { id: jobId } });
  }
  return prisma.job.findUnique({ where: { id: jobId } });
}

export async function completeJob(jobId: string, opts: JobActionOptions = {}): Promise<any> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status === 'SUCCEEDED') return job;
  if (job.status !== 'RUNNING' && job.status !== 'WAITING_FOR_APPROVAL') return job;

  if (opts.leaseId && !leaseMatches(job, opts.leaseId, opts.workerId)) return job;

  if (!transitionAllowed(job.status, 'SUCCEEDED')) return job;

  const where: any = { id: jobId, status: job.status };
  if (opts.leaseId) {
    where.leaseId = opts.leaseId;
    if (opts.workerId) where.leaseOwner = opts.workerId;
  }

  const result = await prisma.job.updateMany({
    where,
    data: {
      status: 'SUCCEEDED',
      finishedAt: new Date(),
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      updatedAt: new Date(),
    },
  });
  if (result.count !== 1) {
    return prisma.job.findUnique({ where: { id: jobId } });
  }
  return prisma.job.findUnique({ where: { id: jobId } });
}

export async function failJob(jobId: string, input: FailJobInput | string = {}, opts: JobActionOptions = {}): Promise<any> {
  const normalizedInput: FailJobInput = typeof input === 'string' ? { error: input } : (input ?? {});
  const mergedOpts: JobActionOptions = { ...normalizedInput, ...opts } as any;

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status === 'SUCCEEDED' || job.status === 'CANCELLED' || job.status === 'FAILED' || job.status === 'DEAD_LETTER') return job;
  if (job.status !== 'RUNNING' && job.status !== 'RETRY_WAIT') return job;

  const leaseId = mergedOpts.leaseId ?? normalizedInput.leaseId ?? normalizedInput.claimId ?? null;
  const workerId = mergedOpts.workerId ?? normalizedInput.workerId ?? normalizedInput.leaseOwner ?? null;
  if (leaseId && !leaseMatches(job, leaseId, workerId)) return job;

  const attempts = job.attempts;
  const maxAttempts = normalizedInput.maxAttempts ?? (mergedOpts as any).maxAttempts ?? job.maxAttempts;
  const retryable = normalizedInput.permanent
    ? false
    : (normalizedInput.retryable ?? true) && !normalizedInput.timeout;
  const error = sanitizeJobError(normalizedInput.error ?? mergedOpts.error ?? mergedOpts.reason ?? 'JOB_FAILED');
  const now = new Date();

  if (job.status === 'RUNNING' && !transitionAllowed(job.status, retryable ? 'RETRY_WAIT' : 'FAILED')) {
    return job;
  }

  const terminalFailure = !retryable || attempts >= maxAttempts;
  const targetStatus = terminalFailure
    ? (retryable && attempts >= maxAttempts ? 'DEAD_LETTER' : 'FAILED')
    : 'RETRY_WAIT';

  if (!transitionAllowed(job.status, targetStatus)) return job;

  const base: any = {
    attempts,
    lastError: error,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    updatedAt: now,
  };

  if (terminalFailure) {
    const fencedWhere: any = { id: jobId, status: job.status };
    if (leaseId) {
      fencedWhere.leaseId = leaseId;
      if (workerId) fencedWhere.leaseOwner = workerId;
    }
    const terminalUpdate = await prisma.job.updateMany({
      where: fencedWhere,
      data: {
        ...base,
        status: targetStatus,
        finishedAt: now,
      },
    });
    if (terminalUpdate.count !== 1) {
      return prisma.job.findUnique({ where: { id: jobId } });
    }
    return prisma.job.findUnique({ where: { id: jobId } });
  }

  const delay = normalizedInput.nextRunAt
    ? Math.max(0, toNow(normalizedInput.nextRunAt).getTime() - now.getTime())
    : 0;
  const runAt = normalizedInput.nextRunAt
    ? toNow(normalizedInput.nextRunAt)
    : new Date(now.getTime() + (delay > 0 ? delay : computeBackoffMs(attempts)));

  const retryWhere: any = { id: jobId, status: job.status };
  if (leaseId) {
    retryWhere.leaseId = leaseId;
    if (workerId) retryWhere.leaseOwner = workerId;
  }
  const retryUpdate = await prisma.job.updateMany({
    where: retryWhere,
    data: {
      ...base,
      status: 'RETRY_WAIT',
      runAt,
      finishedAt: null,
    },
  });
  if (retryUpdate.count !== 1) {
    return prisma.job.findUnique({ where: { id: jobId } });
  }
  return prisma.job.findUnique({ where: { id: jobId } });
}

function computeBackoffMs(attempt: number): number {
  const exp = Math.min(30_000, 1_000 * Math.pow(2, Math.max(0, attempt - 1)));
  return exp + Math.floor(Math.random() * 100);
}

export async function cancelJob(jobId: string, opts: JobActionOptions = {}): Promise<any> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (['SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'CANCELLED'].includes(job.status)) return job;

  if (opts.leaseId && !leaseMatches(job, opts.leaseId, opts.workerId)) return job;

  const cancelWhere: any = { id: jobId, status: job.status };
  if (opts.leaseId) {
    cancelWhere.leaseId = opts.leaseId;
    if (opts.workerId) cancelWhere.leaseOwner = opts.workerId;
  }
  const cancelUpdate = await prisma.job.updateMany({
    where: cancelWhere,
    data: {
      status: 'CANCELLED',
      finishedAt: new Date(),
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastError: opts.reason ? sanitizeJobError(opts.reason) : job.lastError,
      updatedAt: new Date(),
    },
  });
  if (cancelUpdate.count !== 1) {
    return prisma.job.findUnique({ where: { id: jobId } });
  }
  return prisma.job.findUnique({ where: { id: jobId } });
}

export async function markWaitingForApproval(jobId: string, opts: JobActionOptions = {}): Promise<any> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status !== 'RUNNING') return job;

  if (opts.leaseId && !leaseMatches(job, opts.leaseId, opts.workerId)) return job;
  if (!transitionAllowed(job.status, 'WAITING_FOR_APPROVAL')) return job;

  const waitingWhere: any = { id: jobId, status: 'RUNNING' };
  if (opts.leaseId) {
    waitingWhere.leaseId = opts.leaseId;
    if (opts.workerId) waitingWhere.leaseOwner = opts.workerId;
  }
  const waitingUpdate = await prisma.job.updateMany({
    where: waitingWhere,
    data: {
      status: 'WAITING_FOR_APPROVAL',
      finishedAt: new Date(),
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      updatedAt: new Date(),
    },
  });
  if (waitingUpdate.count !== 1) {
    return prisma.job.findUnique({ where: { id: jobId } });
  }
  const updated = await prisma.job.findUnique({ where: { id: jobId } });
  await writeAuditEvent({
    workspaceId: job.workspaceId,
    runId: job.workflowRunId,
    type: 'job_waiting_for_approval',
    actor: opts.actor ?? null,
    data: { jobId, status: 'WAITING_FOR_APPROVAL', ...(opts.data as any) },
  });
  return updated;
}

export async function resumeAfterApproval(jobId: string, opts: JobActionOptions = {}): Promise<any> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status !== 'WAITING_FOR_APPROVAL') return job;

  const resumeUpdate = await prisma.job.updateMany({
    where: { id: jobId, status: 'WAITING_FOR_APPROVAL' },
    data: {
      status: 'QUEUED',
      finishedAt: null,
      runAt: new Date(),
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      updatedAt: new Date(),
    },
  });
  if (resumeUpdate.count !== 1) {
    return prisma.job.findUnique({ where: { id: jobId } });
  }
  const updated = await prisma.job.findUnique({ where: { id: jobId } });
  await writeAuditEvent({
    workspaceId: job.workspaceId,
    runId: job.workflowRunId,
    type: 'job_resumed_after_approval',
    actor: opts.actor ?? null,
    data: { jobId, status: 'QUEUED' },
  });
  return updated;
}

export async function rejectJob(jobId: string, opts: JobActionOptions = {}): Promise<any> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status !== 'WAITING_FOR_APPROVAL') return job;

  const error = sanitizeJobError(opts.error ?? 'APPROVAL_REJECTED');
  const rejectUpdate = await prisma.job.updateMany({
    where: { id: jobId, status: 'WAITING_FOR_APPROVAL' },
    data: {
      status: 'FAILED',
      finishedAt: new Date(),
      lastError: error,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      updatedAt: new Date(),
    },
  });
  if (rejectUpdate.count !== 1) {
    return prisma.job.findUnique({ where: { id: jobId } });
  }
  const updated = await prisma.job.findUnique({ where: { id: jobId } });
  await writeAuditEvent({
    workspaceId: job.workspaceId,
    runId: job.workflowRunId,
    type: 'approval_rejected',
    actor: opts.actor ?? null,
    data: { jobId, status: 'FAILED', error },
  });
  return updated;
}

export async function requeueDeadLetterJob(jobId: string, opts: RequeueOptions = {}): Promise<any> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status !== 'DEAD_LETTER' && job.status !== 'FAILED' && job.status !== 'CANCELLED') return job;

  const requeueWhere: any = { id: jobId };
  if (job.status === 'DEAD_LETTER' || job.status === 'FAILED' || job.status === 'CANCELLED') {
    requeueWhere.status = job.status;
  }
  const requeueUpdate = await prisma.job.updateMany({
    where: requeueWhere,
    data: {
      status: 'QUEUED',
      attempts: 0,
      lastError: null,
      runAt: new Date(),
      finishedAt: null,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      maxAttempts: opts.maxAttempts && opts.maxAttempts > 0 ? opts.maxAttempts : job.maxAttempts,
      updatedAt: new Date(),
    },
  });
  if (requeueUpdate.count !== 1) {
    return prisma.job.findUnique({ where: { id: jobId } });
  }
  const updated = await prisma.job.findUnique({ where: { id: jobId } });
  await writeAuditEvent({
    workspaceId: job.workspaceId,
    runId: job.workflowRunId,
    type: 'job_requeued',
    actor: opts.actor ?? null,
    data: { jobId, status: 'QUEUED', reason: opts.reason ?? null },
  });
  return updated;
}

export async function requeueJob(jobId: string, opts: RequeueOptions = {}): Promise<any> {
  return requeueDeadLetterJob(jobId, opts);
}

export async function retryJob(jobId: string, opts: RequeueOptions = {}): Promise<any> {
  return requeueDeadLetterJob(jobId, opts);
}

export async function resumeJob(jobId: string, opts: JobActionOptions = {}): Promise<any> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status === 'WAITING_FOR_APPROVAL') return resumeAfterApproval(jobId, opts);
  if (job.status === 'DEAD_LETTER' || job.status === 'FAILED' || job.status === 'CANCELLED') return requeueDeadLetterJob(jobId, opts);
  return job;
}

export async function getJobRuntimeStatus(workspaceId: string): Promise<any> {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const now = new Date();
    const [
      queued,
      running,
      retryWait,
      succeeded,
      failed,
      cancelled,
      deadLetter,
      waitingForApproval,
      oldestQueued,
      lastSucceeded,
    ] = await Promise.all([
      tx.job.count({ where: { workspaceId, status: 'QUEUED' } }),
      tx.job.count({ where: { workspaceId, status: 'RUNNING' } }),
      tx.job.count({ where: { workspaceId, status: 'RETRY_WAIT' } }),
      tx.job.count({ where: { workspaceId, status: 'SUCCEEDED' } }),
      tx.job.count({ where: { workspaceId, status: 'FAILED' } }),
      tx.job.count({ where: { workspaceId, status: 'CANCELLED' } }),
      tx.job.count({ where: { workspaceId, status: 'DEAD_LETTER' } }),
      tx.job.count({ where: { workspaceId, status: 'WAITING_FOR_APPROVAL' } }),
      tx.job.findFirst({ where: { workspaceId, status: { in: ['QUEUED', 'RETRY_WAIT'] } }, orderBy: { runAt: 'asc' } }),
      tx.job.findFirst({ where: { workspaceId, status: 'SUCCEEDED' }, orderBy: { finishedAt: 'desc' } }),
    ]);

    return {
      workspaceId,
      now,
      counts: {
        queued,
        running,
        retryWait,
        succeeded,
        failed,
        cancelled,
        deadLetter,
        waitingForApproval,
        total: queued + running + retryWait + succeeded + failed + cancelled + deadLetter + waitingForApproval,
      },
      oldestPendingAt: oldestQueued?.runAt ?? null,
      oldestPendingAgeMs: oldestQueued?.runAt ? now.getTime() - new Date(oldestQueued.runAt).getTime() : null,
      lastSucceededAt: lastSucceeded?.finishedAt ?? null,
    };
  });
}

export async function getRuntimeMetrics(workspaceId: string): Promise<any> {
  return getJobRuntimeStatus(workspaceId);
}

export async function runSchedulerOnce(opts: SchedulerOptions = {}): Promise<any[]> {
  const now = toNow(opts.now);
  const workerId = opts.workerId ?? 'scheduler';
  const batchSize = Math.max(1, Math.min(100, Number(opts.batchSize ?? opts.limit ?? DEFAULT_JOB_SCHEDULER_BATCH_SIZE) || DEFAULT_JOB_SCHEDULER_BATCH_SIZE));
  const leaseTtlMs = Math.max(1, Number(opts.leaseTtlMs ?? DEFAULT_JOB_LEASE_TTL_MS) || DEFAULT_JOB_LEASE_TTL_MS);

  const workspaces = opts.workspaceId
    ? [{ id: opts.workspaceId }]
    : await prisma.workspace.findMany({ select: { id: true } });

  const claimed: any[] = [];
  for (const workspace of workspaces) {
    try {
      await recoverExpiredJobs(workspace.id, { now });
      const killActive = await withWorkspaceTransaction(workspace.id, async (tx) => isKillSwitchActive(workspace.id, tx));
      if (killActive) continue;
      const rows = await claimDueJobs(workspace.id, workerId, { now, limit: batchSize, leaseTtlMs });
      claimed.push(...rows);
    } catch {
      continue;
    }
  }
  return claimed;
}

export async function runScheduler(opts: SchedulerOptions = {}): Promise<any[]> {
  return runSchedulerOnce(opts);
}

export async function scheduleDueJobs(opts: SchedulerOptions = {}): Promise<any[]> {
  return runSchedulerOnce(opts);
}

export async function pollJobs(opts: SchedulerOptions = {}): Promise<any[]> {
  return runSchedulerOnce(opts);
}

export async function processDueJobs(opts: SchedulerOptions = {}): Promise<any[]> {
  return runSchedulerOnce(opts);
}

export async function processJobQueue(opts: SchedulerOptions = {}): Promise<any[]> {
  return runSchedulerOnce(opts);
}

export async function tickScheduler(opts: SchedulerOptions = {}): Promise<any[]> {
  return runSchedulerOnce(opts);
}

export async function runWorkerOnce(opts: SchedulerOptions = {}): Promise<any[]> {
  return runSchedulerOnce(opts);
}

export function leaseExpired(job: any, now: Date = new Date()): boolean {
  if (!job) return false;
  if (job.status !== 'RUNNING') return false;
  if (!job.leaseExpiresAt) return false;
  return new Date(job.leaseExpiresAt).getTime() < now.getTime();
}

export function isJobTimedOut(job: any, now: Date = new Date()): boolean {
  if (!job || !job.timeoutAt) return false;
  return new Date(job.timeoutAt).getTime() < now.getTime();
}

export function canTransition(from: string, to: string): boolean {
  return transitionAllowed(from, to);
}

export function isValidTransition(from: string, to: string): boolean {
  return transitionAllowed(from, to);
}

export function validTransition(from: string, to: string): boolean {
  return transitionAllowed(from, to);
}

export const JobStatus = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  RETRY_WAIT: 'RETRY_WAIT',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  DEAD_LETTER: 'DEAD_LETTER',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
};

export const JobType = {
  WORKFLOW_RUN: 'WORKFLOW_RUN',
  AGENT_TASK: 'AGENT_TASK',
};

export {
  requeueDeadLetterJob as requeueDeadLetter,
  requeueJob as requeue,
  failJob as recordJobFailure,
  completeJob as markJobSucceeded,
  cancelJob as markJobCancelled,
  claimDueJobs as claimJobs,
  recoverExpiredJobs as recoverExpiredLeases,
  recoverExpiredJobs as recoverLeases,
  heartbeatJob as heartbeat,
  getJobRuntimeStatus as getQueueStatus,
  getJobRuntimeStatus as getJobMetrics,
  getJobRuntimeStatus as getRuntimeStatus,
  createJob as enqueueJob,
  createJob as submitJob,
  getJob as findJob,
  listJobs as findJobs,
  runSchedulerOnce as schedulerTick,
  runSchedulerOnce as workerTick,
};

export async function transitionJob(jobId: string, toStatus: string, opts: JobActionOptions = {}): Promise<any> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  const from = job.status;
  const to = String(toStatus).toUpperCase();
  if (from === to) return job;
  if (!transitionAllowed(from, to)) {
    throw new Error(`INVALID_TRANSITION:${from}->${to}`);
  }

  switch (to) {
    case 'SUCCEEDED':
      return completeJob(jobId, opts);
    case 'CANCELLED':
      return cancelJob(jobId, opts);
    case 'WAITING_FOR_APPROVAL':
      return markWaitingForApproval(jobId, opts);
    case 'FAILED':
      return failJob(jobId, { error: opts.error ?? opts.reason ?? 'TRANSITION_FAILED', retryable: false }, opts);
    case 'DEAD_LETTER':
      return failJob(jobId, { error: opts.error ?? opts.reason ?? 'TRANSITION_DEAD_LETTER', retryable: true }, opts);
    case 'RETRY_WAIT':
      return failJob(jobId, { error: opts.error ?? opts.reason ?? 'TRANSITION_RETRY', retryable: true, nextRunAt: opts.data instanceof Date ? opts.data as any : undefined }, opts);
    case 'QUEUED':
      if (job.status === 'WAITING_FOR_APPROVAL') return resumeAfterApproval(jobId, opts);
      if (job.status === 'DEAD_LETTER' || job.status === 'FAILED' || job.status === 'CANCELLED') return requeueDeadLetterJob(jobId, opts);
      return job;
    case 'RUNNING':
      return job;
    default:
      return job;
  }
}

export async function updateJobStatus(jobId: string, toStatus: string, opts: JobActionOptions = {}): Promise<any> {
  return transitionJob(jobId, toStatus, opts);
}

export async function changeJobStatus(jobId: string, toStatus: string, opts: JobActionOptions = {}): Promise<any> {
  return transitionJob(jobId, toStatus, opts);
}

export async function moveJobToState(jobId: string, toStatus: string, opts: JobActionOptions = {}): Promise<any> {
  return transitionJob(jobId, toStatus, opts);
}

export async function setJobStatus(jobId: string, toStatus: string, opts: JobActionOptions = {}): Promise<any> {
  return transitionJob(jobId, toStatus, opts);
}

export async function applyJobTransition(jobId: string, toStatus: string, opts: JobActionOptions = {}): Promise<any> {
  return transitionJob(jobId, toStatus, opts);
}

export async function advanceJob(jobId: string, toStatus: string, opts: JobActionOptions = {}): Promise<any> {
  return transitionJob(jobId, toStatus, opts);
}

export function assertTransition(from: string, to: string): void {
  if (!transitionAllowed(from, to)) throw new Error(`INVALID_TRANSITION:${from}->${to}`);
}

export async function claimJobById(jobId: string, workerId: string, opts: ClaimJobsOptions = {}): Promise<any> {
  const now = toNow(opts.now);
  const leaseTtlMs = Math.max(1, Number(opts.leaseTtlMs ?? DEFAULT_JOB_LEASE_TTL_MS) || DEFAULT_JOB_LEASE_TTL_MS);
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;

  const killActive = await withWorkspaceTransaction(job.workspaceId, async (tx) => {
    await recoverWorkspaceExpiredJobs(tx, job.workspaceId, now);
    return isKillSwitchActive(job.workspaceId, tx);
  });
  if (killActive) return null;

  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);
  const result = await withWorkspaceTransaction(job.workspaceId, async (tx) => {
    return tx.job.updateMany({
      where: {
        id: jobId,
        status: { in: ['QUEUED', 'RETRY_WAIT'] },
        runAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: {
        status: 'RUNNING',
        startedAt: now,
        leaseId,
        leaseOwner: workerId,
        leaseExpiresAt,
        attempts: { increment: 1 },
        updatedAt: now,
      },
    });
  });
  if (result.count !== 1) {
    return prisma.job.findUnique({ where: { id: jobId } });
  }
  return prisma.job.findUnique({ where: { id: jobId } });
}

export { claimJobById as claimJobByTask };

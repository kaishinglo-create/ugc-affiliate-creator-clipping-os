/**
 * Autonomous execution engine.
 *
 * The job runtime in `src/jobs.ts` owns durable queue state (leases, heartbeats,
 * retries, dead letters) and the orchestration driver in `src/orchestration.ts`
 * owns AGENT_TASK work. What was missing is the piece that actually *runs*
 * queued work: nothing ever consumed a claimed WORKFLOW_RUN job, so those jobs
 * cycled QUEUED -> RUNNING -> (lease expiry) -> RETRY_WAIT -> DEAD_LETTER
 * without their workflow ever executing.
 *
 * This module closes that gap. A tick:
 *   1. recovers jobs whose lease expired (crash recovery),
 *   2. claims due WORKFLOW_RUN jobs with a lease,
 *   3. dispatches them to the workflow executor while heartbeating the lease,
 *   4. settles the job from the real outcome of the run.
 *
 * Execution is at-least-once: a crashed process loses its lease and the job is
 * retried by the next tick, so step actions must stay idempotent.
 */
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';
import { isKillSwitchActive } from '../lib/security.js';
import {
  claimDueJobs,
  completeJob,
  failJob,
  heartbeatJob,
  recoverExpiredJobs,
} from './jobs.js';
import { executeRun } from './workflows.js';
import { discoveryEnabled, enqueueDueDiscovery, executeDiscovery } from './discovery.js';
import { runOrchestration } from './orchestration.js';

export const DEFAULT_ENGINE_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_ENGINE_BATCH_SIZE = 10;
export const DEFAULT_ENGINE_LEASE_TTL_MS = 60_000;
export const DEFAULT_ENGINE_CONCURRENCY = 4;
export const DEFAULT_ORCHESTRATION_STALE_MS = 60_000;
/**
 * Job rows are protected by forced row-level security, so a tick has to open a
 * workspace transaction per workspace and cannot pre-filter globally. The scan is
 * therefore capped and rotates, keeping a tick bounded however many workspaces exist.
 */
export const DEFAULT_ENGINE_MAX_WORKSPACES_PER_TICK = 50;

let workspaceCursor = 0;

export type EngineOutcome = 'succeeded' | 'failed' | 'retry' | 'awaiting_approval' | 'skipped';

export interface EngineTickOptions {
  workspaceId?: string | null;
  workerId?: string;
  batchSize?: number;
  leaseTtlMs?: number;
  concurrency?: number;
  now?: Date;
  /** Drive orchestration runs that stalled (for example after a restart). */
  resumeOrchestrations?: boolean;
  staleMs?: number;
  /** Cap on workspaces examined per tick when no workspaceId is given. */
  maxWorkspaces?: number;
}

export interface EngineTickSummary {
  startedAt: string;
  finishedAt: string;
  workerId: string;
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  awaitingApproval: number;
  skipped: number;
  workflowRunsRecovered: number;
  orchestrationsResumed: number;
  jobs: { id: string; type: string; outcome: EngineOutcome; runId: string | null; error?: string }[];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function sanitizeError(error: unknown): string {
  return String((error as Error)?.message ?? error ?? 'ENGINE_ERROR')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2_000);
}

/** Map a workflow run status onto the job outcome it implies. */
function outcomeForRunStatus(status: string | null | undefined): EngineOutcome {
  switch (String(status ?? '')) {
    case 'succeeded':
      return 'succeeded';
    case 'waiting_for_approval':
      return 'awaiting_approval';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'skipped';
    default:
      return 'retry';
  }
}

async function readRunStatus(workspaceId: string, runId: string): Promise<string | null | undefined> {
  const run: any = await withWorkspaceTransaction(workspaceId, (tx) =>
    tx.workflowRun.findUnique({ where: { id: runId }, select: { status: true } })
  );
  return run?.status;
}

/**
 * Settle a job after dispatch. The workflow executor updates the job row for the
 * run it settles, so this only forces a terminal state when the executor left the
 * job RUNNING (for example because the run had already completed earlier).
 */
async function settleJob(workspaceId: string, job: any, outcome: EngineOutcome, workerId: string, error?: string): Promise<void> {
  const current: any = await withWorkspaceTransaction(workspaceId, (tx) => tx.job.findUnique({ where: { id: job.id } }));
  if (!current || current.status !== 'RUNNING') return;
  if (outcome === 'succeeded') {
    await completeJob(job.id, { workspaceId, leaseId: current.leaseId ?? job.leaseId, workerId });
    return;
  }
  if (outcome === 'failed') {
    await failJob(job.id, { error: error ?? 'WORKFLOW_RUN_FAILED', retryable: false }, { workspaceId, leaseId: current.leaseId ?? job.leaseId, workerId });
    return;
  }
  if (outcome === 'retry') {
    await failJob(job.id, { error: error ?? 'WORKFLOW_RUN_INCOMPLETE', retryable: true }, { workspaceId, leaseId: current.leaseId ?? job.leaseId, workerId });
    return;
  }
}

async function executeWorkflowJob(workspaceId: string, job: any, workerId: string, leaseTtlMs: number): Promise<{ outcome: EngineOutcome; error?: string }> {
  const payload = (job.payload ?? {}) as any;
  const runId = typeof payload.runId === 'string' ? payload.runId : '';
  const leaseId = job.leaseId ? String(job.leaseId) : null;

  if (!runId) {
    await failJob(job.id, { error: 'JOB_PAYLOAD_MISSING_RUN_ID', retryable: false }, { workspaceId, workerId });
    return { outcome: 'failed', error: 'JOB_PAYLOAD_MISSING_RUN_ID' };
  }

  // A run that already reached a terminal state is not re-executed; only the job
  // row is reconciled so the queue stops carrying stale work.
  const statusBefore = await readRunStatus(workspaceId, runId);
  if (statusBefore === null || statusBefore === undefined) {
    await failJob(job.id, { error: 'WORKFLOW_RUN_NOT_FOUND', retryable: false }, { workspaceId, workerId });
    return { outcome: 'failed', error: 'WORKFLOW_RUN_NOT_FOUND' };
  }
  if (statusBefore === 'succeeded' || statusBefore === 'failed' || statusBefore === 'cancelled') {
    const outcome = outcomeForRunStatus(statusBefore);
    await settleJob(workspaceId, job, outcome, workerId, `WORKFLOW_RUN_ALREADY_${statusBefore.toUpperCase()}`);
    return { outcome };
  }

  // Keep the lease alive for as long as the executor is working.
  const keepalive = setInterval(() => {
    if (!leaseId) return;
    heartbeatJob(job.id, leaseId, workerId, { workspaceId, extendMs: leaseTtlMs }).catch(() => undefined);
  }, Math.max(1_000, Math.floor(leaseTtlMs / 3)));
  if (typeof (keepalive as any).unref === 'function') (keepalive as any).unref();

  try {
    const executed: any = await executeRun(workspaceId, runId);
    const outcome = outcomeForRunStatus(executed?.status ?? (await readRunStatus(workspaceId, runId)));
    await settleJob(workspaceId, job, outcome, workerId, executed?.error ? String(executed.error) : undefined);
    return { outcome, error: executed?.error ? String(executed.error) : undefined };
  } catch (error) {
    const message = sanitizeError(error);
    await failJob(job.id, { error: message, retryable: true }, { workspaceId, workerId });
    return { outcome: 'retry', error: message };
  } finally {
    clearInterval(keepalive);
  }
}

async function executeClaimedJob(workspaceId: string, job: any, workerId: string, leaseTtlMs: number): Promise<{ id: string; type: string; outcome: EngineOutcome; runId: string | null; error?: string }> {
  const runId = typeof (job.payload as any)?.runId === 'string' ? String((job.payload as any).runId) : null;
  let outcome: EngineOutcome = 'skipped';
  let error: string | undefined;

  try {
    if (job.type === 'WORKFLOW_RUN') {
      const result = await executeWorkflowJob(workspaceId, job, workerId, leaseTtlMs);
      outcome = result.outcome;
      error = result.error;
    } else if (job.type === 'CONTENT_DISCOVERY') {
      const result = await executeDiscovery(workspaceId, job, workerId, leaseTtlMs);
      outcome = result.outcome;
      error = result.error;
    } else {
      // Other job types are owned by their own driver (orchestration owns
      // AGENT_TASK); leave the claim decision to them.
      outcome = 'skipped';
    }
  } catch (unexpected) {
    error = sanitizeError(unexpected);
    outcome = 'retry';
    await failJob(job.id, { error, retryable: true }, { workspaceId, workerId, leaseId: job.leaseId }).catch(() => undefined);
  }

  try {
    await writeAuditEvent({
      workspaceId,
      userId: null,
      runId: null,
      type: `engine_job_${outcome}`,
      actor: workerId,
      data: { jobId: job.id, jobType: job.type, workflowRunId: runId, attempts: job.attempts, outcome, error: error ?? null },
    });
  } catch {
    // Auditing must never break execution.
  }

  return { id: String(job.id), type: String(job.type), outcome, runId, error };
}

/**
 * Bounded slice of workspaces: the half with the newest workspaces is always
 * examined (that is where live activity is), the rest rotates so no workspace is
 * starved. Keeps a tick's cost flat regardless of how many workspaces exist.
 */
async function selectWorkspacesForTick(max: number): Promise<{ id: string }[]> {
  const all = await prisma.workspace.findMany({ select: { id: true }, orderBy: { createdAt: 'desc' } });
  if (all.length <= max) return all;

  const headCount = Math.max(1, Math.ceil(max / 2));
  const head = all.slice(0, headCount);
  const rest = all.slice(headCount);
  const start = workspaceCursor % rest.length;
  const rotated = [...rest.slice(start), ...rest.slice(0, start)];
  const take = Math.max(0, max - head.length);
  workspaceCursor = (start + take) % rest.length;
  return [...head, ...rotated.slice(0, take)];
}

/**
 * Execute one pass of the queue. Safe to call concurrently from several
 * processes: claiming is fenced by row locks and leases.
 */
export async function runEngineTick(opts: EngineTickOptions = {}): Promise<EngineTickSummary> {
  const startedAt = new Date();
  const now = opts.now ?? startedAt;
  const workerId = opts.workerId ?? `engine-${process.pid}`;
  const batchSize = clamp(Number(opts.batchSize ?? DEFAULT_ENGINE_BATCH_SIZE), 1, 100);
  const leaseTtlMs = clamp(Number(opts.leaseTtlMs ?? DEFAULT_ENGINE_LEASE_TTL_MS), 5_000, 3_600_000);
  const concurrency = clamp(Number(opts.concurrency ?? DEFAULT_ENGINE_CONCURRENCY), 1, 20);

  const summary: EngineTickSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    workerId,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    awaitingApproval: 0,
    skipped: 0,
    workflowRunsRecovered: 0,
    orchestrationsResumed: 0,
    jobs: [],
  };

  const workspaces = opts.workspaceId
    ? [{ id: opts.workspaceId }]
    : await selectWorkspacesForTick(clamp(Number(opts.maxWorkspaces ?? DEFAULT_ENGINE_MAX_WORKSPACES_PER_TICK), 1, 5_000));

  for (const workspace of workspaces) {
    try {
      // Crash recovery first: abandoned runs are requeued and expired leases
      // become retryable work again.
      summary.workflowRunsRecovered += await recoverStaleWorkflowRuns({
        workspaceId: workspace.id,
        now,
        staleMs: opts.staleMs ?? DEFAULT_ORCHESTRATION_STALE_MS,
      });
      await recoverExpiredJobs(workspace.id, { now });
      const killActive = await withWorkspaceTransaction(workspace.id, (tx) => isKillSwitchActive(workspace.id, tx));
      if (killActive) continue;

      const discoveryConfigured = discoveryEnabled();
      if (discoveryConfigured) await enqueueDueDiscovery(workspace.id, startedAt);

      const claimed = await claimDueJobs(workspace.id, workerId, {
        now,
        limit: batchSize,
        leaseTtlMs,
        types: discoveryConfigured ? ['WORKFLOW_RUN', 'CONTENT_DISCOVERY'] : ['WORKFLOW_RUN'],
      });
      summary.claimed += claimed.length;

      for (let i = 0; i < claimed.length; i += concurrency) {
        const slice = claimed.slice(i, i + concurrency);
        const results = await Promise.all(slice.map((job: any) => executeClaimedJob(workspace.id, job, workerId, leaseTtlMs)));
        for (const result of results) {
          summary.jobs.push(result);
          if (result.outcome === 'succeeded') summary.succeeded += 1;
          else if (result.outcome === 'failed') summary.failed += 1;
          else if (result.outcome === 'retry') summary.retried += 1;
          else if (result.outcome === 'awaiting_approval') summary.awaitingApproval += 1;
          else summary.skipped += 1;
        }
      }
    } catch {
      // A single broken workspace must not stall the whole engine.
      continue;
    }
  }

  if (opts.resumeOrchestrations) {
    summary.orchestrationsResumed = await resumeStaleOrchestrations({
      workspaceId: opts.workspaceId ?? null,
      staleMs: opts.staleMs ?? DEFAULT_ORCHESTRATION_STALE_MS,
      now,
    });
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

const activeOrchestrations = new Set<string>();

function kickOrchestration(workspaceId: string, runId: string): void {
  activeOrchestrations.add(runId);
  void runOrchestration(workspaceId, runId)
    .catch(() => undefined)
    .finally(() => activeOrchestrations.delete(runId));
}

/** Pick up queued work, decided approvals, and abandoned runs on each tick. */
export async function resumeStaleOrchestrations(opts: { workspaceId?: string | null; staleMs?: number; now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - clampStale(opts.staleMs));
  let resumed = 0;

  const workspaces = opts.workspaceId ? [{ id: opts.workspaceId }] : await selectWorkspacesForTick(DEFAULT_ENGINE_MAX_WORKSPACES_PER_TICK);
  for (const workspace of workspaces) {
    try {
      const runs: any[] = await withWorkspaceTransaction(workspace.id, (tx) =>
        tx.orchestrationRun.findMany({
          where: {
            workspaceId: workspace.id,
            AND: [
              { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
              { OR: [
                { status: 'queued' },
                { status: 'running', OR: [
                  { leaseExpiresAt: { lte: now } },
                  { leaseExpiresAt: null, updatedAt: { lt: staleBefore } },
                ] },
                { status: 'waiting_for_approval', tasks: { none: { status: 'waiting_for_approval' } } },
              ] },
            ],
          },
          select: { id: true },
          orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
          take: 10,
        })
      );
      for (const run of runs) {
        if (activeOrchestrations.has(run.id)) continue;
        resumed += 1;
        kickOrchestration(workspace.id, String(run.id));
      }
    } catch {
      continue;
    }
  }
  return resumed;
}

function clampStale(value?: number): number {
  const parsed = Number(value ?? DEFAULT_ORCHESTRATION_STALE_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_ORCHESTRATION_STALE_MS;
  return Math.max(1_000, Math.trunc(parsed));
}

/**
 * Restart recovery for workflow runs: a run left `running` with no live job lease
 * (the process died mid-run) is put back to `queued` so the next tick resumes it
 * from its recorded `currentStep` instead of hanging forever.
 */
export async function recoverStaleWorkflowRuns(opts: { workspaceId?: string | null; staleMs?: number; now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - clampStale(opts.staleMs));
  let recovered = 0;

  const workspaces = opts.workspaceId ? [{ id: opts.workspaceId }] : await prisma.workspace.findMany({ select: { id: true } });
  for (const workspace of workspaces) {
    try {
      const runs: any[] = await withWorkspaceTransaction(workspace.id, (tx) =>
        tx.workflowRun.findMany({
          where: { workspaceId: workspace.id, status: 'running', updatedAt: { lt: staleBefore } },
          select: { id: true },
          take: 20,
        })
      );
      for (const run of runs) {
        const liveLease: any = await withWorkspaceTransaction(workspace.id, (tx) =>
          tx.job.findFirst({
            where: { workspaceId: workspace.id, workflowRunId: run.id, status: 'RUNNING', leaseExpiresAt: { gt: now } },
            select: { id: true },
          })
        );
        if (liveLease) continue;
        const didRecover = await withWorkspaceTransaction(workspace.id, async (tx) => {
          const result = await tx.workflowRun.updateMany({
            where: { id: run.id, workspaceId: workspace.id, status: 'running' },
            data: { status: 'queued', error: 'RECOVERED_AFTER_RESTART' },
          });
          if (result.count !== 1) return false;
          await writeAuditEvent({
            workspaceId: workspace.id,
            userId: null,
            runId: null,
            type: 'workflow_run_recovered',
            actor: 'engine',
            data: { runId: run.id, reason: 'STALE_RUNNING_WITHOUT_LEASE' },
            tx,
          });
          return true;
        });
        if (didRecover) recovered += 1;
      }
    } catch {
      continue;
    }
  }
  return recovered;
}

export interface EngineStatus {
  enabled: boolean;
  running: boolean;
  workerId: string;
  intervalMs: number;
  lastTickAt: string | null;
  lastSummary: EngineTickSummary | null;
  lastError: string | null;
}

export interface EngineHandle {
  status(): EngineStatus;
  tick(): Promise<EngineTickSummary>;
  stop(): Promise<void>;
}

let engineHandle: EngineHandle | null = null;

export function engineStatus(): EngineStatus {
  if (engineHandle) return engineHandle.status();
  return {
    enabled: process.env.AUTOMATION_ENGINE !== 'off',
    running: false,
    workerId: `engine-${process.pid}`,
    intervalMs: Number(process.env.AUTOMATION_ENGINE_INTERVAL_MS ?? DEFAULT_ENGINE_POLL_INTERVAL_MS) || DEFAULT_ENGINE_POLL_INTERVAL_MS,
    lastTickAt: null,
    lastSummary: null,
    lastError: null,
  };
}

/**
 * Start the background loop. Re-entrant calls return the running handle.
 * Set `AUTOMATION_ENGINE=off` to run the API without autonomous execution.
 */
export function startEngine(opts: EngineTickOptions & { intervalMs?: number } = {}): EngineHandle {
  if (engineHandle) return engineHandle;

  const intervalMs = clamp(Number(opts.intervalMs ?? process.env.AUTOMATION_ENGINE_INTERVAL_MS ?? DEFAULT_ENGINE_POLL_INTERVAL_MS), 250, 300_000);
  const workerId = opts.workerId ?? `engine-${process.pid}`;
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;
  let lastTickAt: string | null = null;
  let lastSummary: EngineTickSummary | null = null;
  let lastError: string | null = null;

  const tick = async (): Promise<EngineTickSummary> => {
    const summary = await runEngineTick({ ...opts, workerId, resumeOrchestrations: opts.resumeOrchestrations ?? true });
    lastTickAt = summary.finishedAt;
    lastSummary = summary;
    lastError = null;
    return summary;
  };

  const loop = () => {
    if (stopped || inFlight) return;
    inFlight = tick()
      .catch((error) => {
        lastError = sanitizeError(error);
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(loop, intervalMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  loop();

  engineHandle = {
    status: () => ({
      enabled: true,
      running: !stopped,
      workerId,
      intervalMs,
      lastTickAt,
      lastSummary,
      lastError,
    }),
    tick,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight.catch(() => undefined);
      engineHandle = null;
    },
  };
  return engineHandle;
}

export async function stopEngine(): Promise<void> {
  if (engineHandle) await engineHandle.stop();
}

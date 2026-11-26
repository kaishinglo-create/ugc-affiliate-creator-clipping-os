import { randomUUID } from 'node:crypto';
import { withWorkspaceTransaction } from '../lib/db.js';
import { newSpan, trace } from './qa-trace.js';

export type OrchestrationLease = {
  workspaceId: string;
  runId: string;
  owner: string;
  token: string;
  epoch: number;
};


export async function claimOrchestrationLease(
  workspaceId: string,
  runId: string,
  owner: string,
  ttlMs = 30_000,
): Promise<OrchestrationLease | null> {
  if (!owner || !Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) throw new Error('INVALID_LEASE');
  const span = newSpan();
  const started = Date.now();
  trace('lease_claim.start', { span, workspaceId, runId, owner, ttlMs });
  const token = randomUUID();
  try {
    const result = await withWorkspaceTransaction(workspaceId, async (tx) => {
      // Database time, rather than host clock, is the source of truth.
      const queryStarted = Date.now();
      const rows: Array<{ leaseEpoch: number }> = await tx.$queryRaw`
        UPDATE "OrchestrationRun"
        SET "leaseOwner" = ${owner},
            "leaseToken" = ${token},
            "leaseExpiresAt" = clock_timestamp() + (${ttlMs}::integer * interval '1 millisecond'),
            "leaseEpoch" = "leaseEpoch" + 1
        WHERE "id" = ${runId}
          AND "workspaceId" = ${workspaceId}
          AND "status" NOT IN ('succeeded', 'failed', 'cancelled')
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp())
        RETURNING "leaseEpoch"
      `;
      trace('lease_claim.query', { span, runId, owner, queryMs: Date.now() - queryStarted, rows: rows.length });
      if (rows.length !== 1) return null;
      return { workspaceId, runId, owner, token, epoch: Number(rows[0].leaseEpoch) };
    });
    trace('lease_claim.end', { span, runId, owner, claimed: Boolean(result), epoch: result?.epoch ?? null, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    trace('lease_claim.error', { span, runId, owner, durationMs: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
    throw error;
  }
}

export async function heartbeatOrchestrationLease(lease: OrchestrationLease, ttlMs = 30_000): Promise<boolean> {
  if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) throw new Error('INVALID_LEASE');
  const span = newSpan();
  const started = Date.now();
  trace('lease_heartbeat.start', { span, workspaceId: lease.workspaceId, runId: lease.runId, owner: lease.owner, epoch: lease.epoch, ttlMs });
  try {
    const result = await withWorkspaceTransaction(lease.workspaceId, async (tx) => {
      const queryStarted = Date.now();
      const rows: Array<{ id: string }> = await tx.$queryRaw`
        UPDATE "OrchestrationRun"
        SET "leaseExpiresAt" = clock_timestamp() + (${ttlMs}::integer * interval '1 millisecond')
        WHERE "id" = ${lease.runId} AND "workspaceId" = ${lease.workspaceId}
          AND "leaseOwner" = ${lease.owner} AND "leaseToken" = ${lease.token}
          AND "leaseEpoch" = ${lease.epoch}
          AND "leaseExpiresAt" > clock_timestamp()
          AND "status" NOT IN ('succeeded', 'failed', 'cancelled')
        RETURNING "id"
      `;
      trace('lease_heartbeat.query', { span, runId: lease.runId, owner: lease.owner, epoch: lease.epoch, queryMs: Date.now() - queryStarted, rows: rows.length });
      return rows.length === 1;
    });
    trace('lease_heartbeat.end', { span, runId: lease.runId, owner: lease.owner, epoch: lease.epoch, ok: result, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    trace('lease_heartbeat.error', { span, runId: lease.runId, owner: lease.owner, epoch: lease.epoch, durationMs: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
    throw error;
  }
}

export async function releaseOrchestrationLease(lease: OrchestrationLease): Promise<boolean> {
  const span = newSpan();
  const started = Date.now();
  trace('lease_release.start', { span, workspaceId: lease.workspaceId, runId: lease.runId, owner: lease.owner, epoch: lease.epoch });
  try {
    const result = await withWorkspaceTransaction(lease.workspaceId, async (tx) => {
      const queryStarted = Date.now();
      const rows: Array<{ id: string }> = await tx.$queryRaw`
        UPDATE "OrchestrationRun"
        SET "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL
        WHERE "id" = ${lease.runId} AND "workspaceId" = ${lease.workspaceId}
          AND "leaseOwner" = ${lease.owner} AND "leaseToken" = ${lease.token}
          AND "leaseEpoch" = ${lease.epoch}
        RETURNING "id"
      `;
      trace('lease_release.query', { span, runId: lease.runId, owner: lease.owner, epoch: lease.epoch, queryMs: Date.now() - queryStarted, rows: rows.length });
      return rows.length === 1;
    });
    trace('lease_release.end', { span, runId: lease.runId, owner: lease.owner, epoch: lease.epoch, ok: result, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    trace('lease_release.error', { span, runId: lease.runId, owner: lease.owner, epoch: lease.epoch, durationMs: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
    throw error;
  }
}

export async function assertOrchestrationLease(lease: OrchestrationLease, tx: any): Promise<void> {
  const rows: Array<{ id: string }> = await tx.$queryRaw`
    SELECT "id" FROM "OrchestrationRun"
    WHERE "id" = ${lease.runId} AND "workspaceId" = ${lease.workspaceId}
      AND "leaseOwner" = ${lease.owner} AND "leaseToken" = ${lease.token}
      AND "leaseEpoch" = ${lease.epoch} AND "leaseExpiresAt" > clock_timestamp()
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new Error('ORCHESTRATION_LEASE_LOST');
}

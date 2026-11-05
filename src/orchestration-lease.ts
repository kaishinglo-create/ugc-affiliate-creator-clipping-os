import { randomUUID } from 'node:crypto';
import { withWorkspaceTransaction } from '../lib/db.js';

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
  const token = randomUUID();
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    // Database time, rather than host clock, is the source of truth.
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
    if (rows.length !== 1) return null;
    return { workspaceId, runId, owner, token, epoch: Number(rows[0].leaseEpoch) };
  });
}

export async function heartbeatOrchestrationLease(lease: OrchestrationLease, ttlMs = 30_000): Promise<boolean> {
  if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) throw new Error('INVALID_LEASE');
  return withWorkspaceTransaction(lease.workspaceId, async (tx) => {
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
    return rows.length === 1;
  });
}

export async function releaseOrchestrationLease(lease: OrchestrationLease): Promise<boolean> {
  return withWorkspaceTransaction(lease.workspaceId, async (tx) => {
    const rows: Array<{ id: string }> = await tx.$queryRaw`
      UPDATE "OrchestrationRun"
      SET "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL
      WHERE "id" = ${lease.runId} AND "workspaceId" = ${lease.workspaceId}
        AND "leaseOwner" = ${lease.owner} AND "leaseToken" = ${lease.token}
        AND "leaseEpoch" = ${lease.epoch}
      RETURNING "id"
    `;
    return rows.length === 1;
  });
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

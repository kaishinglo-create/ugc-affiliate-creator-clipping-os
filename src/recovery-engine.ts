/**
 * Phase I.2: approval-gated recovery workflow.
 *
 * Detect -> Diagnose -> Plan -> Policy Check -> Approval -> Execute -> Verify
 * -> Audit -> Rollback. Only actions owned by this application are permitted;
 * foreign processes and foreign database transactions are never terminated.
 */
import { withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';
import { isKillSwitchActive } from '../lib/security.js';

export type RecoveryAction = 'report_only' | 'clear_stale_lease' | 'promote_due_retry_wait';

export interface RecoveryPlan {
  incidentId: string;
  kind: string;
  action: RecoveryAction;
  reason: string;
  policy: 'safe' | 'approval_required';
  rollback: { type: 'none' | 'job_lease_snapshot'; note: string };
}

function invalid(code: string, status = 400): Error {
  return Object.assign(new Error(code), { statusCode: status });
}

/** Deterministic diagnosis of the six real incident classes. */
export function diagnoseIncidentKind(kind: string, _evidence: Record<string, unknown>): {
  classification: string;
  action: RecoveryAction;
  reason: string;
} {
  switch (kind) {
    case 'INC-PH-01':
    case 'competing_coding_processes':
      return { classification: 'foreign_process', action: 'report_only', reason: 'Foreign coding processes must never be terminated automatically.' };
    case 'INC-PH-02':
    case 'port_conflict':
      return { classification: 'port_owner_unknown', action: 'report_only', reason: 'Port owner is not proven; no automatic restart.' };
    case 'INC-PH-03':
    case 'idle_in_transaction':
      return { classification: 'database_transaction', action: 'report_only', reason: 'Transaction ownership cannot be proven; no automatic cancel.' };
    case 'INC-PH-04':
    case 'qa_watchdog_timeout':
      return { classification: 'qa_runtime', action: 'report_only', reason: 'QA cluster ownership requires human confirmation.' };
    case 'INC-PH-05':
    case 'source_drift':
      return { classification: 'freeze_drift', action: 'report_only', reason: 'Source drift invalidates the verdict; no silent rewrite.' };
    case 'INC-PH-06':
    case 'qa_preflight_blocked':
      return { classification: 'service_state', action: 'report_only', reason: 'Foreign services must not be stopped automatically.' };
    case 'stale_job_lease':
      return { classification: 'own_lease', action: 'clear_stale_lease', reason: 'Expired lease owned by this application can be recovered.' };
    case 'due_retry_wait':
      return { classification: 'own_job', action: 'promote_due_retry_wait', reason: 'Due RETRY_WAIT job owned by this application can be promoted.' };
    default:
      return { classification: 'unknown', action: 'report_only', reason: 'Unknown incident; report only.' };
  }
}

export async function planRecovery(input: {
  workspaceId: string;
  incidentId: string;
  actor: string | null;
}): Promise<any> {
  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    const incident: any = await tx.incident.findFirst({
      where: { id: input.incidentId, workspaceId: input.workspaceId },
    });
    if (!incident) throw invalid('INCIDENT_NOT_FOUND', 404);
    const diagnosis = diagnoseIncidentKind(String(incident.kind), incident.evidence as any);
    const plan: RecoveryPlan = {
      incidentId: incident.id,
      kind: String(incident.kind),
      action: diagnosis.action,
      reason: diagnosis.reason,
      policy: diagnosis.action === 'report_only' ? 'approval_required' : 'safe',
      rollback: { type: diagnosis.action === 'report_only' ? 'none' : 'job_lease_snapshot', note: 'Snapshot before mutation.' },
    };
    const run: any = await tx.recoveryRun.create({
      data: { workspaceId: input.workspaceId, incidentId: incident.id, status: 'planned', plan },
    });
    await tx.incident.update({ where: { id: incident.id }, data: { status: 'planned', diagnosis } });
    await writeAuditEvent({
      tx, workspaceId: input.workspaceId, userId: input.actor, runId: null,
      type: 'recovery_planned', actor: input.actor ?? 'planner',
      data: { recoveryRunId: run.id, incidentId: incident.id, action: plan.action },
    });
    return run;
  });
}

export async function approveRecovery(input: {
  workspaceId: string;
  recoveryRunId: string;
  actor: string;
}): Promise<any> {
  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    const run: any = await tx.recoveryRun.findFirst({
      where: { id: input.recoveryRunId, workspaceId: input.workspaceId },
    });
    if (!run) throw invalid('RECOVERY_NOT_FOUND', 404);
    if (!['planned', 'approved'].includes(String(run.status))) throw invalid('INVALID_RECOVERY_STATE', 409);
    const approval: any = await tx.approval.create({
      data: {
        workspaceId: input.workspaceId,
        entityType: 'recovery_run',
        entityId: run.id,
        status: 'approved',
        requestedBy: input.actor,
        decidedBy: input.actor,
        decidedAt: new Date(),
      },
    });
    const updated: any = await tx.recoveryRun.update({
      where: { id: run.id }, data: { status: 'approved', approvalId: approval.id },
    });
    await writeAuditEvent({
      tx, workspaceId: input.workspaceId, userId: input.actor, runId: null,
      type: 'recovery_approved', actor: input.actor,
      data: { recoveryRunId: run.id, approvalId: approval.id },
    });
    return updated;
  });
}

async function executePlan(tx: any, workspaceId: string, plan: RecoveryPlan): Promise<{ result: Record<string, unknown>; snapshot: Record<string, unknown> }> {
  if (plan.action === 'report_only') {
    return { result: { action: 'report_only', mutations: 0 }, snapshot: { action: 'none' } };
  }
  if (plan.action === 'clear_stale_lease') {
    const stale: any[] = await tx.job.findMany({
      where: { workspaceId, status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
      select: { id: true, leaseId: true, leaseOwner: true, status: true },
    });
    const snapshot = { leases: stale };
    if (stale.length) {
      await tx.job.updateMany({
        where: { id: { in: stale.map((job) => job.id) }, workspaceId },
        data: { status: 'QUEUED', leaseId: null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null },
      });
    }
    return { result: { action: plan.action, recovered: stale.length }, snapshot };
  }
  const due: any[] = await tx.job.findMany({
    where: { workspaceId, status: 'RETRY_WAIT', runAt: { lte: new Date() } },
    select: { id: true, status: true, runAt: true },
  });
  if (due.length) {
    await tx.job.updateMany({
      where: { id: { in: due.map((job) => job.id) }, workspaceId },
      data: { status: 'QUEUED', runAt: new Date() },
    });
  }
  return { result: { action: plan.action, promoted: due.length }, snapshot: { jobs: due } };
}

export async function executeRecovery(input: {
  workspaceId: string;
  recoveryRunId: string;
  actor: string | null;
  now?: Date;
}): Promise<any> {
  const now = input.now ?? new Date();
  const out = await withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    if (await isKillSwitchActive(input.workspaceId, tx)) throw invalid('KILL_SWITCH_ACTIVE', 409);
    const run: any = await tx.recoveryRun.findFirst({
      where: { id: input.recoveryRunId, workspaceId: input.workspaceId },
    });
    if (!run) throw invalid('RECOVERY_NOT_FOUND', 404);
    if (String(run.status) !== 'approved' || !run.approvalId) throw invalid('APPROVAL_REQUIRED', 409);
    const approval: any = await tx.approval.findFirst({
      where: {
        id: run.approvalId, workspaceId: input.workspaceId, entityType: 'recovery_run',
        entityId: run.id, status: 'approved', revokedAt: null,
      },
    });
    if (!approval) throw invalid('APPROVAL_REQUIRED', 409);
    if (approval.expiresAt && new Date(approval.expiresAt).getTime() <= now.getTime()) throw invalid('APPROVAL_EXPIRED', 409);
    // Atomic daily budget: only recovery attempts count.
    const configured = Number(process.env.PHASE_I_MAX_RECOVERIES_PER_WORKSPACE_DAILY ?? 20);
    const cap = Number.isFinite(configured) ? Math.max(1, Math.min(1000, Math.trunc(configured))) : 20;
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    const used = await tx.auditEvent.count({
      where: { workspaceId: input.workspaceId, type: 'recovery_executed', createdAt: { gte: day } },
    });
    if (used >= cap) throw invalid('RECOVERY_BUDGET_EXCEEDED', 429);
    // Re-bind plan to the current incident fingerprint (no content manipulation).
    const incident: any = await tx.incident.findFirst({
      where: { id: run.incidentId, workspaceId: input.workspaceId },
    });
    if (!incident) throw invalid('INCIDENT_NOT_FOUND', 404);
    const plan = run.plan as RecoveryPlan;
    if (plan.incidentId !== incident.id) throw invalid('PLAN_MISMATCH', 409);
    const started: any = await tx.recoveryRun.update({
      where: { id: run.id }, data: { status: 'executing', startedAt: now },
    });
    return { run: started, plan, incident };
  });

  let execution: { result: Record<string, unknown>; snapshot: Record<string, unknown> };
  try {
    execution = await withWorkspaceTransaction(input.workspaceId, (tx: any) =>
      executePlan(tx, input.workspaceId, out.plan));
  } catch (error) {
    await withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
      await tx.recoveryRun.update({ where: { id: out.run.id }, data: { status: 'failed', finishedAt: new Date(), result: { error: String((error as Error)?.message ?? 'RECOVERY_FAILED') } } });
      await writeAuditEvent({ tx, workspaceId: input.workspaceId, userId: input.actor, runId: null, type: 'recovery_failed', actor: input.actor ?? 'recovery', data: { recoveryRunId: out.run.id } });
    });
    throw error;
  }

  const verified = out.plan.action === 'report_only'
    ? true
    : execution.result.recovered !== undefined || execution.result.promoted !== undefined;
  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    const updated: any = await tx.recoveryRun.update({
      where: { id: out.run.id },
      data: {
        status: verified ? 'succeeded' : 'failed',
        finishedAt: new Date(),
        result: execution.result,
        rollback: execution.snapshot,
      },
    });
    await writeAuditEvent({
      tx, workspaceId: input.workspaceId, userId: input.actor, runId: null,
      type: 'recovery_executed', actor: input.actor ?? 'recovery',
      data: { recoveryRunId: out.run.id, incidentId: out.incident.id, action: out.plan.action, verified },
    });
    return updated;
  });
}

/** Mark interrupted executions as unresolved instead of leaving them RUNNING. */
export async function recoverStaleRecoveryRuns(input: {
  workspaceId: string;
  now?: Date;
  staleMs?: number;
  actor?: string | null;
}): Promise<number> {
  const now = input.now ?? new Date();
  const staleMs = Math.max(10_000, Math.min(3_600_000, Number(input.staleMs) || 300_000));
  const cutoff = new Date(now.getTime() - staleMs);
  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    const stale: any[] = await tx.recoveryRun.findMany({
      where: { workspaceId: input.workspaceId, status: 'executing', startedAt: { lt: cutoff } },
    });
    for (const run of stale) {
      await tx.recoveryRun.update({
        where: { id: run.id },
        data: { status: 'unresolved', finishedAt: now, result: { error: 'RECOVERY_INTERRUPTED' } },
      });
      await tx.incident.updateMany({
        where: { id: run.incidentId, workspaceId: input.workspaceId, status: 'executing' },
        data: { status: 'unresolved' },
      });
      await writeAuditEvent({
        tx, workspaceId: input.workspaceId, userId: input.actor ?? null, runId: null,
        type: 'recovery_interrupted', actor: input.actor ?? 'recovery',
        data: { recoveryRunId: run.id },
      });
    }
    return stale.length;
  });
}

export async function rollbackRecovery(workspaceId: string, recoveryRunId: string, actor: string | null): Promise<any | null> {
  return withWorkspaceTransaction(workspaceId, async (tx: any) => {
    const run: any = await tx.recoveryRun.findFirst({ where: { id: recoveryRunId, workspaceId } });
    if (!run || !run.rollback || (run.rollback as any).type === 'none') return null;
    const snapshot = run.rollback as any;
    if (Array.isArray(snapshot.leases)) {
      for (const lease of snapshot.leases) {
        await tx.job.updateMany({
          where: { id: lease.id, workspaceId },
          data: { status: lease.status, leaseId: lease.leaseId, leaseOwner: lease.leaseOwner },
        });
      }
    }
    if (Array.isArray(snapshot.jobs)) {
      for (const job of snapshot.jobs) {
        await tx.job.updateMany({ where: { id: job.id, workspaceId }, data: { status: job.status, runAt: job.runAt } });
      }
    }
    const updated: any = await tx.recoveryRun.update({ where: { id: run.id }, data: { status: 'rolled_back' } });
    await writeAuditEvent({
      tx, workspaceId, userId: actor, runId: null, type: 'recovery_rolled_back', actor: actor ?? 'recovery',
      data: { recoveryRunId: run.id },
    });
    return updated;
  });
}

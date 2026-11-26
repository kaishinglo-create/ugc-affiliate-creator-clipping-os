/**
 * Persistent CEO/COO operational records.
 *
 * CEO and COO are not decorative labels: every decision is derived from real
 * stored orchestration rows and written back to workspace-scoped, RLS-protected
 * tables (DelegationRecord, OperationalPolicy, Insight, AuditEvent). The pure
 * helpers in this module are intentionally free of side effects so their
 * evidence can be unit-tested without a database.
 */
import { withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';

export type CooDecisionKind = 'route' | 'retry' | 'escalate' | 'approval_gate';

export interface CooDecision {
  kind: CooDecisionKind;
  taskIds: string[];
  reason: string;
  evidence: Record<string, unknown>;
  decidedAt: string;
}

export interface CeoSynthesisValidation {
  runId: string;
  status: 'valid' | 'invalid';
  checkedAt: string;
  tasksTotal: number;
  tasksSucceeded: number;
  tasksFailed: number;
  tasksWaitingForApproval: number;
  dependenciesResolved: string[];
  unresolvedDependencies: string[];
  evidence: { taskId: string; status: string; departmentKey: string }[];
}

const COO_COUNTERS: Record<CooDecisionKind, string> = {
  route: 'routed',
  retry: 'retries',
  escalate: 'escalations',
  approval_gate: 'approvalGates',
};

function asString(value: unknown): string {
  return String(value ?? '');
}

/** Pure validation of a CEO synthesis against the real task rows of a run. */
export function validateCeoSynthesis(run: any, tasks: any[], now: Date = new Date()): CeoSynthesisValidation {
  const rows = Array.isArray(tasks) ? tasks : [];
  const byId = new Map(rows.map((task) => [asString(task?.id), task]));
  const synthesis = rows.find((task) => task?.departmentKey === 'ceo' && task?.action === 'synthesize');
  const dependencies: string[] = Array.isArray(synthesis?.dependsOn) ? (synthesis.dependsOn as unknown[]).map(asString) : [];
  const dependenciesResolved = dependencies.filter((id) => asString(byId.get(id)?.status) === 'succeeded');
  const unresolvedDependencies = dependencies.filter((id) => asString(byId.get(id)?.status) !== 'succeeded');
  const tasksFailed = rows.filter((task) => ['failed', 'dead_letter', 'cancelled'].includes(asString(task?.status))).length;
  const tasksWaitingForApproval = rows.filter((task) => asString(task?.status) === 'waiting_for_approval').length;
  const tasksSucceeded = rows.filter((task) => asString(task?.status) === 'succeeded').length;
  const status = rows.length > 0 && unresolvedDependencies.length === 0 && tasksFailed === 0 && tasksWaitingForApproval === 0 && tasksSucceeded === rows.length
    ? 'valid' : 'invalid';
  return {
    runId: asString(run?.id),
    status,
    checkedAt: now.toISOString(),
    tasksTotal: rows.length,
    tasksSucceeded,
    tasksFailed,
    tasksWaitingForApproval,
    dependenciesResolved,
    unresolvedDependencies,
    evidence: rows.map((task) => ({
      taskId: asString(task?.id),
      status: asString(task?.status),
      departmentKey: asString(task?.departmentKey),
    })),
  };
}

/** Write one COO decision inside an existing workspace transaction. */
export async function recordCooDecisionInTx(tx: any, workspaceId: string, runId: string, decision: CooDecision): Promise<{ delegationId: string; policyKey: string }> {
  const policyKey = `coo.operations.${runId}`;
  const taskIds = Array.from(new Set(decision.taskIds.map(asString).filter(Boolean)));
  if (taskIds.length === 0) throw new Error('COO_DECISION_REQUIRES_TASK_IDS');
  const delegation = await tx.delegationRecord.create({
    data: {
      workspaceId,
      runId,
      fromRole: 'COO',
      toDepartment: 'multiple',
      taskIds,
      reason: `${decision.kind}: ${decision.reason}`.slice(0, 1000),
    },
  });
  const existing: any = await tx.operationalPolicy.findUnique({ where: { workspaceId_key: { workspaceId, key: policyKey } } });
  const previous: any = existing?.value && typeof existing.value === 'object' ? existing.value : {};
  const decisions = Array.isArray(previous.decisions) ? previous.decisions : [];
  const counter = COO_COUNTERS[decision.kind];
  const value = {
    ...previous,
    runId,
    [counter]: Number(previous[counter] ?? 0) + 1,
    decisions: [...decisions, decision].slice(-100),
  };
  await tx.operationalPolicy.upsert({
    where: { workspaceId_key: { workspaceId, key: policyKey } },
    create: { workspaceId, key: policyKey, value },
    update: { value },
  });
  await writeAuditEvent({
    workspaceId,
    type: `coo_${decision.kind}_recorded`,
    actor: 'COO',
    data: { runId, delegationId: delegation.id, ...decision },
    tx,
  });
  return { delegationId: delegation.id, policyKey };
}

/** Standalone wrapper for callers outside a workspace transaction. */
export async function recordCooDecision(workspaceId: string, runId: string, decision: CooDecision) {
  return withWorkspaceTransaction(workspaceId, (tx) => recordCooDecisionInTx(tx, workspaceId, runId, decision));
}

/** Persist a CEO validation as an Insight inside an existing workspace transaction. */
export async function persistCeoSynthesisInTx(tx: any, workspaceId: string, validation: CeoSynthesisValidation): Promise<{ insightId: string }> {
  const insight = await tx.insight.create({
    data: {
      workspaceId,
      title: `CEO synthesis validation: ${validation.runId}`,
      body: JSON.stringify(validation),
      source: 'ceo_synthesis_validation',
      confidence: validation.status === 'valid' ? 1 : 0,
      active: true,
    },
  });
  await writeAuditEvent({
    workspaceId,
    type: 'ceo_synthesis_validated',
    actor: 'CEO',
    data: validation,
    tx,
  });
  return { insightId: insight.id };
}

export async function persistCeoSynthesis(workspaceId: string, runId: string, validation: CeoSynthesisValidation) {
  return withWorkspaceTransaction(workspaceId, (tx) => persistCeoSynthesisInTx(tx, workspaceId, validation));
}

/** Read back real CEO/COO records for one run; no computed or invented fields. */
export async function getCompanyAgentRecord(workspaceId: string, runId: string) {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const policyKey = `coo.operations.${runId}`;
    const policy: any = await tx.operationalPolicy.findUnique({ where: { workspaceId_key: { workspaceId, key: policyKey } } });
    const delegations: any[] = await tx.delegationRecord.findMany({
      where: { workspaceId, runId, fromRole: 'COO' },
      orderBy: { createdAt: 'asc' },
    });
    const validations: any[] = await tx.insight.findMany({
      where: { workspaceId, source: 'ceo_synthesis_validation' },
      orderBy: { createdAt: 'desc' },
    });
    const ceoValidation = validations.find((row) => String(row.body ?? '').includes(`"runId":"${runId}"`));
    return {
      runId,
      coo: {
        policyKey,
        operations: policy?.value ?? null,
        delegations: delegations.map((row) => ({
          id: row.id,
          taskIds: row.taskIds,
          reason: row.reason,
          createdAt: row.createdAt,
        })),
      },
      ceo: {
        validation: ceoValidation ? JSON.parse(String(ceoValidation.body)) : null,
        insightId: ceoValidation?.id ?? null,
      },
    };
  });
}

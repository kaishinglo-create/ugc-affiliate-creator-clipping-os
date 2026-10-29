import { withWorkspaceTransaction } from '../lib/db.js';
import { isKillSwitchActive } from '../lib/security.js';
import { writeAuditEvent } from '../lib/audit.js';

export interface StepDef { name: string; action: string; }

export const ACTION_REGISTRY: Record<string, (input: any) => Promise<any>> = {
  echo: async (input) => ({ echoed: input }),
  delay: async (input) => { await new Promise((r) => setTimeout(r, 10)); return { delayed: true, input }; },
};

export async function createDefinition(workspaceId: string, name: string, steps: StepDef[]) {
  return withWorkspaceTransaction(workspaceId, (tx) => tx.workflowDefinition.create({ data: { workspaceId, name, steps } }));
}

export async function startRun(workspaceId: string, definitionId: string, input: any, idempotencyKey?: string) {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    if (idempotencyKey) {
      const existing = await tx.workflowRun.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } } });
      if (existing) return existing;
    }
    return tx.workflowRun.create({ data: { workspaceId, definitionId, status: 'queued', input, idempotencyKey: idempotencyKey ?? null, startedAt: new Date() } });
  });
}

export async function executeRun(workspaceId: string, runId: string) {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
  const run = await tx.workflowRun.findUnique({ where: { id: runId }, include: { definition: true, steps: true } });
  if (!run) throw new Error('RUN_NOT_FOUND');
  if (run.status === 'succeeded' || run.status === 'cancelled') return run;
  const killSwitchActive = await isKillSwitchActive(workspaceId, tx);
  if (killSwitchActive) {
    await tx.workflowRun.update({ where: { id: runId }, data: { status: 'cancelled', error: 'KILL_SWITCH_ACTIVE', finishedAt: new Date() } });
    await writeAuditEvent({ workspaceId, runId: null, type: 'workflow_run_blocked', actor: null, data: { runId, reason: 'KILL_SWITCH_ACTIVE' }, tx });
    return tx.workflowRun.findUnique({ where: { id: runId } });
  }
  await tx.workflowRun.update({ where: { id: runId }, data: { status: 'running' } });
  await writeAuditEvent({ workspaceId, runId: null, type: 'workflow_run_started', actor: null, data: { runId, definitionId: run.definitionId }, tx });
  const steps = run.definition.steps as StepDef[];
  const current = run.currentStep;
  for (let i = current; i < steps.length; i++) {
      const step = steps[i];
      const approval = await tx.approval.findFirst({ where: { workspaceId, entityType: 'workflow_step', entityId: `${runId}#${step.action}` } });
      if (approval) {
        if (approval.status === 'pending') {
          await tx.workflowRun.update({ where: { id: runId }, data: { status: 'waiting_for_approval', error: 'APPROVAL_PENDING', finishedAt: new Date() } });
          await writeAuditEvent({ workspaceId, runId: null, type: 'workflow_step_blocked', actor: null, data: { runId, stepIndex: i, action: step.action, approvalId: approval.id, reason: 'APPROVAL_PENDING' }, tx });
          return tx.workflowRun.findUnique({ where: { id: runId } });
        }
        if (approval.status === 'rejected' || !approval.decidedAt) {
          await tx.workflowRun.update({ where: { id: runId }, data: { status: 'failed', error: 'APPROVAL_REJECTED', finishedAt: new Date() } });
          await writeAuditEvent({ workspaceId, runId: null, type: 'workflow_step_blocked', actor: null, data: { runId, stepIndex: i, action: step.action, approvalId: approval.id, reason: 'APPROVAL_REJECTED' }, tx });
          return tx.workflowRun.findUnique({ where: { id: runId } });
        }
      }
      const stepRun = await tx.workflowStepRun.create({ data: { runId, stepIndex: i, name: step.name, status: 'running', startedAt: new Date(), input: run.input } });
    try {
      const action = ACTION_REGISTRY[step.action] ?? (async (x: any) => ({ skipped: true, action: step.action, input: x }));
      const output = await action(run.input);
      await tx.workflowStepRun.update({ where: { id: stepRun.id }, data: { status: 'succeeded', output, finishedAt: new Date() } });
      await tx.workflowRun.update({ where: { id: runId }, data: { currentStep: i + 1 } });
    } catch (e: any) {
      await tx.workflowStepRun.update({ where: { id: stepRun.id }, data: { status: 'failed', error: e.message, finishedAt: new Date() } });
      await tx.workflowRun.update({ where: { id: runId }, data: { status: 'failed', error: e.message, finishedAt: new Date() } });
      await writeAuditEvent({ workspaceId, runId: null, type: 'workflow_run_failed', actor: null, data: { runId, error: e.message }, tx });
      return tx.workflowRun.findUnique({ where: { id: runId } });
    }
  }
  await tx.workflowRun.update({ where: { id: runId }, data: { status: 'succeeded', finishedAt: new Date() } });
  await writeAuditEvent({ workspaceId, runId: null, type: 'workflow_run_succeeded', actor: null, data: { runId, definitionId: run.definitionId }, tx });
  return tx.workflowRun.findUnique({ where: { id: runId } });
  });
}

import { withWorkspaceTransaction } from '../lib/db.js';
import { isKillSwitchActive } from '../lib/security.js';
import { writeAuditEvent } from '../lib/audit.js';
import { createJob } from './jobs.js';

export interface StepDef { name: string; action: string; }

export const ACTION_REGISTRY: Record<string, (input: any) => Promise<any>> = {
  echo: async (input) => ({ echoed: input }),
  delay: async (input) => { await new Promise((r) => setTimeout(r, 10)); return { delayed: true, input }; },
};

export async function createDefinition(workspaceId: string, name: string, steps: StepDef[]): Promise<any> {
  return withWorkspaceTransaction(workspaceId, (tx) => tx.workflowDefinition.create({ data: { workspaceId, name, steps } }));
}

export async function startRun(workspaceId: string, definitionId: string, input: any, idempotencyKey?: string) {
  const run = await (async () => {
    try {
      return await withWorkspaceTransaction(workspaceId, async (tx) => {
        if (idempotencyKey) {
          const existing = await tx.workflowRun.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } } });
          if (existing) return existing;
        }
        return tx.workflowRun.create({ data: { workspaceId, definitionId, status: 'queued', input, idempotencyKey: idempotencyKey ?? null, startedAt: new Date() } });
      });
    } catch (e: any) {
      if (idempotencyKey && (e?.code === 'P2002' || String(e?.message ?? '').includes('Unique constraint'))) {
        return withWorkspaceTransaction(workspaceId, (tx) => tx.workflowRun.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } } }));
      }
      throw e;
    }
  })();
  await createJob({ workspaceId, type: 'WORKFLOW_RUN', category: 'workflow', payload: { runId: run.id, definitionId, input }, idempotencyKey: idempotencyKey ?? null, workflowRunId: run.id });
  return run;
}

export async function executeRun(workspaceId: string, runId: string) {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
  const run = await tx.workflowRun.findUnique({ where: { id: runId }, include: { definition: true, steps: true } });
  if (!run) throw new Error('RUN_NOT_FOUND');
  if (run.status === 'succeeded' || run.status === 'cancelled' || run.status === 'running') return run;
  const killSwitchActive = await isKillSwitchActive(workspaceId, tx);
  if (killSwitchActive) {
    await tx.workflowRun.update({ where: { id: runId }, data: { status: 'cancelled', error: 'KILL_SWITCH_ACTIVE', finishedAt: new Date() } });
    await writeAuditEvent({ workspaceId, runId: null, type: 'workflow_run_blocked', actor: null, data: { runId, reason: 'KILL_SWITCH_ACTIVE' }, tx });
    const blockedJob = await tx.job.findFirst({ where: { workflowRunId: runId } });
    if (blockedJob) {
      await tx.job.update({ where: { id: blockedJob.id }, data: { status: 'CANCELLED', finishedAt: new Date(), lastError: 'KILL_SWITCH_ACTIVE' } });
    }
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
          const pendingJob = await tx.job.findFirst({ where: { workflowRunId: runId } });
          if (pendingJob) {
            await tx.job.update({ where: { id: pendingJob.id }, data: { status: 'WAITING_FOR_APPROVAL', finishedAt: new Date() } });
          }
          return tx.workflowRun.findUnique({ where: { id: runId } });
        }
        if (approval.status === 'rejected' || !approval.decidedAt) {
          await tx.workflowRun.update({ where: { id: runId }, data: { status: 'failed', error: 'APPROVAL_REJECTED', finishedAt: new Date() } });
          await writeAuditEvent({ workspaceId, runId: null, type: 'workflow_step_blocked', actor: null, data: { runId, stepIndex: i, action: step.action, approvalId: approval.id, reason: 'APPROVAL_REJECTED' }, tx });
          const rejectedJob = await tx.job.findFirst({ where: { workflowRunId: runId } });
          if (rejectedJob) {
            await tx.job.update({ where: { id: rejectedJob.id }, data: { status: 'FAILED', finishedAt: new Date(), lastError: 'APPROVAL_REJECTED' } });
          }
          return tx.workflowRun.findUnique({ where: { id: runId } });
        }
      }
      const stepRun = await tx.workflowStepRun.create({ data: { runId, stepIndex: i, name: step.name, status: 'running', startedAt: new Date(), input: run.input } });
    try {
      const action = ACTION_REGISTRY[step.action];
      if (!action) throw new Error(`UNKNOWN_ACTION:${step.action}`);
      const output = await action(run.input);
      await tx.workflowStepRun.update({ where: { id: stepRun.id }, data: { status: 'succeeded', output, finishedAt: new Date() } });
      await tx.workflowRun.update({ where: { id: runId }, data: { currentStep: i + 1 } });
    } catch (e: any) {
      await tx.workflowStepRun.update({ where: { id: stepRun.id }, data: { status: 'failed', error: e.message, finishedAt: new Date() } });
      await tx.workflowRun.update({ where: { id: runId }, data: { status: 'failed', error: e.message, finishedAt: new Date() } });
      await writeAuditEvent({ workspaceId, runId: null, type: 'workflow_run_failed', actor: null, data: { runId, error: e.message }, tx });
      const failedJob = await tx.job.findFirst({ where: { workflowRunId: runId } });
      if (failedJob) {
        await tx.job.update({ where: { id: failedJob.id }, data: { status: 'FAILED', finishedAt: new Date(), lastError: e.message } });
      }
      return tx.workflowRun.findUnique({ where: { id: runId } });
    }
  }
  await tx.workflowRun.update({ where: { id: runId }, data: { status: 'succeeded', finishedAt: new Date() } });
  await writeAuditEvent({ workspaceId, runId: null, type: 'workflow_run_succeeded', actor: null, data: { runId, definitionId: run.definitionId }, tx });
  const succeededJob = await tx.job.findFirst({ where: { workflowRunId: runId } });
  if (succeededJob) {
    await tx.job.update({ where: { id: succeededJob.id }, data: { status: 'SUCCEEDED', finishedAt: new Date() } });
  }
  return tx.workflowRun.findUnique({ where: { id: runId } });
  });
}

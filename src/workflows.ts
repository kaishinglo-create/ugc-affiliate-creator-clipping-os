import { withWorkspaceTransaction } from '../lib/db.js';

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
  await tx.workflowRun.update({ where: { id: runId }, data: { status: 'running' } });
  const steps = run.definition.steps as StepDef[];
  const current = run.currentStep;
  for (let i = current; i < steps.length; i++) {
    const step = steps[i];
    const stepRun = await tx.workflowStepRun.create({ data: { runId, stepIndex: i, name: step.name, status: 'running', startedAt: new Date(), input: run.input } });
    try {
      const action = ACTION_REGISTRY[step.action] ?? (async (x: any) => ({ skipped: true, action: step.action, input: x }));
      const output = await action(run.input);
      await tx.workflowStepRun.update({ where: { id: stepRun.id }, data: { status: 'succeeded', output, finishedAt: new Date() } });
      await tx.workflowRun.update({ where: { id: runId }, data: { currentStep: i + 1 } });
    } catch (e: any) {
      await tx.workflowStepRun.update({ where: { id: stepRun.id }, data: { status: 'failed', error: e.message, finishedAt: new Date() } });
      await tx.workflowRun.update({ where: { id: runId }, data: { status: 'failed', error: e.message, finishedAt: new Date() } });
      return tx.workflowRun.findUnique({ where: { id: runId } });
    }
  }
  await tx.workflowRun.update({ where: { id: runId }, data: { status: 'succeeded', finishedAt: new Date() } });
  return tx.workflowRun.findUnique({ where: { id: runId } });
  });
}

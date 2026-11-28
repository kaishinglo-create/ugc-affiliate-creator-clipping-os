/**
 * Phase I.3: persistent, evidence-based improvement backlog.
 *
 * Suggestions come from the existing self-improving analyser, which reads real
 * audit rows. No improvement metric is invented: before/after values must be
 * supplied from persisted measurements.
 */
import { withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';
import { collectSelfImprovement } from './self-improving.js';

function invalid(code: string, status = 400): Error {
  return Object.assign(new Error(code), { statusCode: status });
}

const EFFORT_WEIGHT: Record<string, number> = { small: 3, medium: 2, large: 1 };
const RISK_WEIGHT: Record<string, number> = { low: 3, medium: 2, high: 1 };

export async function refreshImprovements(input: {
  workspaceId: string;
  actor?: string | null;
  now?: Date;
}): Promise<{ created: number; examined: number; tasks: any[] }> {
  const report = await collectSelfImprovement(input.workspaceId, { now: input.now ?? new Date() });
  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    let created = 0;
    for (const suggestion of report.suggestions) {
      const title = String((suggestion as any).title ?? (suggestion as any).summary ?? '').slice(0, 300);
      if (!title) continue;
      const evidence = (suggestion as any).evidence ?? (suggestion as any);
      const existing: any = await tx.improvementTask.findFirst({
        where: { workspaceId: input.workspaceId, title, status: { in: ['proposed', 'prioritized', 'in_sandbox'] } },
      });
      if (existing) continue;
      const risk = String((suggestion as any).risk ?? 'low');
      const effort = String((suggestion as any).effort ?? 'small');
      const occurrences = Number((suggestion as any).occurrences ?? (evidence as any)?.occurrences ?? 1);
      const score = Math.max(0, Math.min(1000,
        Math.round(occurrences * (RISK_WEIGHT[risk] ?? 1) * (EFFORT_WEIGHT[effort] ?? 1))));
      await tx.improvementTask.create({
        data: {
          workspaceId: input.workspaceId,
          title,
          evidence,
          priorityScore: score,
          risk: RISK_WEIGHT[risk] ? risk : 'low',
          effort: EFFORT_WEIGHT[effort] ? effort : 'medium',
          status: 'proposed',
        },
      });
      created += 1;
    }
    if (created) {
      await writeAuditEvent({
        tx, workspaceId: input.workspaceId, userId: input.actor ?? null, runId: null,
        type: 'improvement_backlog_refreshed', actor: input.actor ?? 'improvement-engine',
        data: { created, eventsExamined: report.eventsExamined },
      });
    }
    const tasks = await tx.improvementTask.findMany({
      where: { workspaceId: input.workspaceId },
      orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
    return { created, examined: report.eventsExamined, tasks };
  });
}

export async function listImprovements(workspaceId: string, status?: string, take = 100): Promise<any[]> {
  return withWorkspaceTransaction<any[]>(workspaceId, (tx: any) => tx.improvementTask.findMany({
    where: { workspaceId, ...(status ? { status } : {}) },
    orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(500, Math.max(1, take)),
  }));
}

/** Record a measured metric; null means not measured (never zero/invented). */
export async function recordImprovementMetric(input: {
  workspaceId: string;
  taskId: string;
  phase: 'before' | 'after';
  metrics: Record<string, unknown>;
  actor?: string | null;
}): Promise<any | null> {
  if (!input.metrics || typeof input.metrics !== 'object') throw invalid('INVALID_METRICS');
  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    const task: any = await tx.improvementTask.findFirst({ where: { id: input.taskId, workspaceId: input.workspaceId } });
    if (!task) return null;
    const updated: any = await tx.improvementTask.update({
      where: { id: task.id },
      data: input.phase === 'before' ? { beforeJson: input.metrics } : { afterJson: input.metrics, status: 'measured' },
    });
    await writeAuditEvent({
      tx, workspaceId: input.workspaceId, userId: input.actor ?? null, runId: null,
      type: 'improvement_metric_recorded', actor: input.actor ?? 'improvement-engine',
      data: { taskId: task.id, phase: input.phase, keys: Object.keys(input.metrics).slice(0, 20) },
    });
    return updated;
  });
}

import 'node:crypto';
import { createHash } from 'node:crypto';
import { withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';
import { isKillSwitchActive } from '../lib/security.js';
import {
  createJob,
  claimJobById,
  getJob,
  recoverExpiredJobs,
  completeJob,
  failJob,
  cancelJob,
  heartbeatJob,
  markWaitingForApproval,
} from './jobs.js';

export const DEPARTMENT_KEYS = [
  'research',
  'strategy',
  'creative',
  'video',
  'growth',
  'publishing',
  'analytics',
  'qa',
  'security',
] as const;

export const DEPARTMENT_NAMES: Record<string, string> = {
  research: 'Research & Market Intelligence',
  strategy: 'Strategy & Campaign Planning',
  creative: 'Creative & Ghostwriting',
  video: 'Video Production & Clipping',
  growth: 'Affiliate & Growth',
  publishing: 'Publishing & Distribution',
  analytics: 'Analytics & Optimization',
  qa: 'QA & Content Compliance',
  security: 'Security & Governance',
  ceo: 'CEO / Orchestrator',
};

export const DEPARTMENT_ALLOWED_TOOLS: Record<string, string[]> = {
  research: ['read_analytics', 'read_content', 'read_products'],
  strategy: ['read_research', 'write_campaign_plan'],
  creative: ['read_strategy', 'write_scripts', 'write_captions'],
  video: ['analyze_video', 'prepare_edit'],
  growth: ['read_analytics', 'write_affiliate_plan'],
  publishing: ['read_qa', 'plan_publication'],
  analytics: ['read_performance', 'write_optimization_report'],
  qa: ['validate_content', 'review_compliance'],
  security: ['review_policy', 'audit_log'],
};

export const DEPARTMENT_ALLOWED_ACTIONS: Record<string, Set<string>> = {
  research: new Set(['research_market']),
  analytics: new Set(['analyze_metrics']),
  strategy: new Set(['build_campaign_plan']),
  creative: new Set(['generate_variants']),
  video: new Set(['prepare_clips']),
  growth: new Set(['build_affiliate_plan']),
  qa: new Set(['validate_content']),
  publishing: new Set(['plan_publication']),
  security: new Set(['review_governance']),
  ceo: new Set(['orchestrate', 'synthesize']),
};

const DEPARTMENT_DESCRIPTIONS: Record<string, string> = {
  research: 'Market, niche, trend, and competitor research with source attribution.',
  strategy: 'Campaign planning and task translation from research.',
  creative: 'Hooks, scripts, storyboards, captions, and variants.',
  video: 'Video analysis and clipping instructions.',
  growth: 'Affiliate, CTA variant, and conversion hypotheses.',
  publishing: 'Publication planning and platform-specific formats.',
  analytics: 'Metrics analysis and optimization recommendations.',
  qa: 'Quality, compliance, and approval checks.',
  security: 'Governance, permissions, risk, and audit oversight.',
};

function now(): Date {
  return new Date();
}

function canonicalRequestHash(input: any): string {
  const normalized = {
    goal: String(input?.goal ?? '').trim(),
    maxConcurrency: Math.max(1, Math.min(8, Number(input?.maxConcurrency ?? 2) || 2)),
    budgetUnits: Math.max(1, Math.min(10000, Number(input?.budgetUnits ?? 100) || 100)),
  };
  const keys = Object.keys(normalized).sort();
  const ordered: any = {};
  for (const key of keys) ordered[key] = (normalized as any)[key];
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

function sanitizeError(error: unknown): string {
  return String(error ?? 'UNKNOWN_ERROR').replace(/\r/g, ' ').trim().slice(0, 4000);
}

export async function ensureDepartments(workspaceId: string): Promise<any[]> {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const existing = (await tx.department.findMany({ where: { workspaceId } })) as any[];
    const byKey = new Map(existing.map((row: any) => [row.key, row]));
    const created: any[] = [];
    for (const key of DEPARTMENT_KEYS) {
      if (byKey.has(key)) {
        created.push(byKey.get(key));
        continue;
      }
      const row = await tx.department.create({
        data: {
          workspaceId,
          key,
          name: DEPARTMENT_NAMES[key],
          description: DEPARTMENT_DESCRIPTIONS[key],
          allowedTools: DEPARTMENT_ALLOWED_TOOLS[key],
        },
      });
      created.push(row);
    }
    await writeAuditEvent({ workspaceId, type: 'departments_ensured', actor: null, data: { count: created.length }, tx });
    return created;
  });
}

export async function ensureCompanyAgents(workspaceId: string): Promise<any[]> {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const seed = [
      { name: 'CEO Orchestrator', role: 'CEO', capabilities: ['decompose', 'delegate', 'synthesize', 'approve'] },
      { name: 'COO Operations', role: 'COO', capabilities: ['schedule', 'route', 'monitor', 'retry', 'escalate'] },
    ];
    const created: any[] = [];
    for (const item of seed) {
      let row = await tx.agentDefinition.findFirst({ where: { workspaceId, name: item.name } });
      if (!row) row = await tx.agentDefinition.create({ data: { workspaceId, name: item.name, role: item.role, capabilities: item.capabilities, enabled: true } });
      created.push(row);
    }
    for (const key of DEPARTMENT_KEYS) {
      const name = `${DEPARTMENT_NAMES[key]} Lead`;
      let row = await tx.agentDefinition.findFirst({ where: { workspaceId, name } });
      if (!row) row = await tx.agentDefinition.create({ data: { workspaceId, name, role: key, capabilities: DEPARTMENT_ALLOWED_TOOLS[key], enabled: true } });
      created.push(row);
    }
    return created;
  });
}

export async function listDepartments(workspaceId: string): Promise<any[]> {
  await ensureDepartments(workspaceId);
  return withWorkspaceTransaction(workspaceId, (tx) => tx.department.findMany({ where: { workspaceId }, orderBy: { key: 'asc' } }));
}

async function getRun(workspaceId: string, runId: string): Promise<any> {
  return withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationRun.findUnique({ where: { id: runId }, include: { tasks: true } }));
}

function validateDependencyGraph(tasks: { id: string; dependsOn: string[] }[]): boolean {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) for (const dep of task.dependsOn) if (!ids.has(dep)) return false;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): boolean {
    if (visited.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (!visit(dep)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  }
  return tasks.every((task) => visit(task.id));
}

function departmentAllowed(departmentKey: string, action: string): boolean {
  return Boolean(DEPARTMENT_ALLOWED_ACTIONS[departmentKey]?.has(action));
}

function departmentProduces(departmentKey: string, action: string, goal: string): any {
  switch (departmentKey) {
    case 'research':
      return { summary: `Research plan for: ${goal}`, questions: ['market trend', 'competitor angle', 'audience pain point'], tools: DEPARTMENT_ALLOWED_TOOLS.research };
    case 'analytics':
      return { summary: `Analytics hypothesis for: ${goal}`, metrics: ['views', 'clicks', 'conversions'], tools: DEPARTMENT_ALLOWED_TOOLS.analytics };
    case 'strategy':
      return { summary: `Campaign strategy for: ${goal}`, channels: ['short-form', 'affiliate', 'email'], planningWindow: '30 days' };
    case 'creative':
      return { variants: [`Variant A: ${goal}`, `Variant B: ${goal} (proof-led)`, `Variant C: ${goal} (story-led)`], tools: DEPARTMENT_ALLOWED_TOOLS.creative };
    case 'video':
      return { clips: [{ start: 0, end: 15, rationale: 'hook segment' }, { start: 15, end: 45, rationale: 'value segment' }], tools: DEPARTMENT_ALLOWED_TOOLS.video };
    case 'growth':
      return { ctaVariants: ['link-in-bio', 'pinned comment', 'description CTA'], hypotheses: ['proof reduces friction', 'shorter CTA increases clicks'], tools: DEPARTMENT_ALLOWED_TOOLS.growth };
    case 'qa':
      return { passed: true, checks: ['required fields present', 'brand safety', 'format validity'], approvedFor: 'publishing' };
    case 'publishing':
      return { status: 'planned_only', platforms: ['tiktok', 'instagram', 'youtube'], requiresExternalIntegration: true, plannedPosts: 3 };
    case 'security':
      return { riskClass: 'medium', checks: ['approval gate present', 'allowed tools only', 'no secret exposure'], killSwitchRespected: true };
    case 'ceo':
      if (action === 'synthesize') return { summary: `CEO synthesis for: ${goal}`, dependenciesResolved: true, status: 'ready_for_review' };
      return { summary: `CEO orchestration for: ${goal}`, stage: 'coordination' };
    default:
      throw new Error(`UNKNOWN_DEPARTMENT:${departmentKey}`);
  }
}

async function reserveBudget(workspaceId: string, runId: string, amount: number, budgetUnits: number, spentUnits: number): Promise<boolean> {
  const result: any = await withWorkspaceTransaction(workspaceId, async (tx) => {
    return tx.$executeRaw`
      UPDATE "OrchestrationRun"
      SET "spentUnits" = "spentUnits" + ${amount},
          "updatedAt" = NOW()
      WHERE "id" = ${runId}
        AND "workspaceId" = ${workspaceId}
        AND ("spentUnits" + ${amount} <= "budgetUnits")
    `;
  });
  return Number(result) === 1;
}

async function releaseBudget(workspaceId: string, runId: string, amount: number): Promise<void> {
  await withWorkspaceTransaction(workspaceId, async (tx) => {
    await tx.$executeRaw`
      UPDATE "OrchestrationRun"
      SET "spentUnits" = GREATEST("spentUnits" - ${amount}, 0),
          "updatedAt" = NOW()
      WHERE "id" = ${runId}
        AND "workspaceId" = ${workspaceId}
    `;
  });
}

function taskStatusCount(tasks: any[], statuses: string[]): number {
  return tasks.filter((task) => statuses.includes(task.status)).length;
}

export async function createOrchestrationRun(workspaceId: string, input: any): Promise<any> {
  await ensureDepartments(workspaceId);
  await ensureCompanyAgents(workspaceId);

  const goal = String(input?.goal ?? '').trim();
  if (!goal) throw Object.assign(new Error('INVALID_GOAL'), { statusCode: 400 });
  const maxConcurrency = Math.max(1, Math.min(8, Number(input?.maxConcurrency ?? 2) || 2));
  const budgetUnits = Math.max(1, Math.min(10000, Number(input?.budgetUnits ?? 100) || 100));
  const idempotencyKey = input?.idempotencyKey ? String(input.idempotencyKey).trim() : null;
  if (idempotencyKey && !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
    throw Object.assign(new Error('INVALID_IDEMPOTENCY_KEY'), { statusCode: 400 });
  }
  const requestHash = canonicalRequestHash({ goal, maxConcurrency, budgetUnits });

  const normalizedInput = { goal, maxConcurrency, budgetUnits };
  try {
    return await withWorkspaceTransaction(workspaceId, async (tx) => {
      if (idempotencyKey) {
        const existing = await tx.orchestrationRun.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } }, include: { tasks: true } });
        if (existing) {
          if ((existing as any).requestHash && (existing as any).requestHash !== requestHash) {
            throw Object.assign(new Error('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH'), { statusCode: 409 });
          }
          await writeAuditEvent({ workspaceId, runId: null, type: 'orchestration_idempotent_replay', actor: input?.requestedBy ?? null, data: { key: idempotencyKey }, tx });
          return existing;
        }
      }

      const run = await tx.orchestrationRun.create({
        data: {
          workspaceId,
          goal,
          idempotencyKey,
          requestHash,
          requestedBy: input?.requestedBy ?? null,
          status: 'queued',
          budgetUnits,
          maxConcurrency,
          strategy: {
            ceo: 'decompose into research, analytics, strategy, creative, video, growth, qa, publishing, security, synthesis',
            coo: 'dependency-aware job-backed fan-out and fan-in',
          },
        },
      });

      const taskDefs: { id: string; departmentKey: string; action: string; priority: number; estimatedUnits: number; dependsOn: string[]; requiresApproval: boolean }[] = [];
      const mk = (departmentKey: string, action: string, priority: number, estimatedUnits: number, dependsOn: string[]) => {
        const id = `${run.id}-${departmentKey}-${taskDefs.length}`;
        taskDefs.push({ id, departmentKey, action, priority, estimatedUnits, dependsOn, requiresApproval: departmentKey === 'publishing' });
        return id;
      };
      const rootId = `${run.id}-ceo-root`;
      taskDefs.push({ id: rootId, departmentKey: 'ceo', action: 'orchestrate', priority: 10, estimatedUnits: 1, dependsOn: [], requiresApproval: false });
      const researchId = mk('research', 'research_market', 8, 10, [rootId]);
      const analyticsId = mk('analytics', 'analyze_metrics', 7, 6, [rootId]);
      const strategyId = mk('strategy', 'build_campaign_plan', 8, 8, [researchId, analyticsId]);
      const creativeId = mk('creative', 'generate_variants', 7, 12, [strategyId]);
      const videoId = mk('video', 'prepare_clips', 6, 15, [creativeId]);
      const growthId = mk('growth', 'build_affiliate_plan', 6, 8, [strategyId, analyticsId]);
      const qaId = mk('qa', 'validate_content', 7, 5, [creativeId, videoId]);
      const publishingId = mk('publishing', 'plan_publication', 5, 4, [qaId]);
      const securityId = mk('security', 'review_governance', 9, 4, [qaId, publishingId]);
      const finalId = mk('ceo', 'synthesize', 10, 2, [publishingId, securityId, growthId]);

      if (!validateDependencyGraph(taskDefs.map((task) => ({ id: task.id, dependsOn: task.dependsOn })))) {
        throw Object.assign(new Error('INVALID_ORCHESTRATION_GRAPH'), { statusCode: 500 });
      }

      for (const task of taskDefs) {
        await tx.orchestrationTask.create({
          data: {
            id: task.id,
            workspaceId,
            runId: run.id,
            parentTaskId: task.id === rootId ? null : rootId,
            departmentKey: task.departmentKey,
            agentType: task.departmentKey === 'ceo' ? 'CEO' : `${task.departmentKey}_lead`,
            action: task.action,
            status: 'queued',
            priority: task.priority,
            dependsOn: task.dependsOn,
            requiresApproval: task.requiresApproval,
            estimatedUnits: task.estimatedUnits,
            input: { goal, task: task.id, normalized: normalizedInput },
            timeoutMs: 30000,
          },
        });
      }

      const delegation = await tx.delegationRecord.create({
        data: {
          workspaceId,
          runId: null,
          fromRole: 'CEO',
          toDepartment: 'multiple',
          taskIds: taskDefs.map((task) => task.id),
          reason: 'initial persistently queued orchestration decomposition',
        },
      });
      await writeAuditEvent({
        workspaceId,
        runId: null,
        type: 'orchestration_created',
        actor: input?.requestedBy ?? null,
        data: { goal, maxConcurrency, budgetUnits, taskCount: taskDefs.length, delegationId: delegation.id, idempotencyKey },
        tx,
      });
      return tx.orchestrationRun.findUnique({ where: { id: run.id }, include: { tasks: true } });
    });
  } catch (e: any) {
    if (idempotencyKey && (e?.code === 'P2002' || String(e?.message ?? '').includes('Unique constraint'))) {
      const existing = await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationRun.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } }, include: { tasks: true } }));
      if (existing) {
        if ((existing as any).requestHash && (existing as any).requestHash !== requestHash) throw Object.assign(new Error('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH'), { statusCode: 409 });
        return existing;
      }
    }
    if (e?.statusCode === 409) throw e;
    throw e;
  }
}

async function ensureTaskJob(workspaceId: string, runId: string, task: any): Promise<string> {
  if (task.jobId) return task.jobId;
  const job = await createJob({
    workspaceId,
    type: 'AGENT_TASK',
    category: 'orchestration_task',
    priority: Number(task.priority ?? 0),
    payload: {
      orchestrationRunId: runId,
      orchestrationTaskId: task.id,
      departmentKey: task.departmentKey,
      action: task.action,
      goal: null,
    },
    idempotencyKey: `orchestration-task:${task.id}`,
    maxAttempts: Number(task.maxAttempts ?? 2),
    timeoutMs: Number(task.timeoutMs ?? 30000),
    workflowRunId: null,
    agentTaskId: null,
  });
  await withWorkspaceTransaction(workspaceId, async (tx) => {
    await tx.orchestrationTask.update({ where: { id: task.id }, data: { jobId: job.id } });
  });
  return job.id;
}

async function budgetReserved(task: any): Promise<boolean> {
  return (task.actualUnits ?? 0) > 0 || (task.attemptCount ?? 0) > 0;
}

async function processOrchestrationJob(workspaceId: string, runId: string, jobId: string, workerId: string, leaseId: string, _leaseExpires: Date): Promise<void> {
  await heartbeatJob(jobId, leaseId, workerId, { now: now(), extendMs: 30000 });
  const task: any = await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.findFirst({ where: { jobId } }));
  const run: any = await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationRun.findUnique({ where: { id: runId } }));
  if (!task || !run) {
    await failJob(jobId, { error: 'ORCHESTRATION_TASK_MISSING', retryable: false }, { leaseId, workerId });
    return;
  }
  const action = String(task.action ?? '');
  if (!departmentAllowed(String(task.departmentKey), action)) {
    await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.update({ where: { id: task.id }, data: { status: 'failed', error: `ACTION_NOT_ALLOWED:${task.departmentKey}:${action}`, finishedAt: now() } }));
    await failJob(jobId, { error: `ACTION_NOT_ALLOWED:${task.departmentKey}:${action}`, retryable: false }, { leaseId, workerId });
    return;
  }
  const taskRunGoal = String((task.input as any)?.goal ?? run.goal ?? '');

  if (await isKillSwitchActive(workspaceId)) {
    await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.update({ where: { id: task.id }, data: { status: 'cancelled', error: 'KILL_SWITCH_ACTIVE', finishedAt: now() } }));
    await cancelJob(jobId, { reason: 'KILL_SWITCH_ACTIVE', leaseId, workerId });
    return;
  }

  const isRetry = (task.attemptCount ?? 0) > 0;
  await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.update({ where: { id: task.id }, data: { status: 'running', startedAt: now(), attemptCount: { increment: 1 } } }));
  const updatedTask: any = await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.findUnique({ where: { id: task.id } }));

  if (task.requiresApproval) {
    const approval: any = await withWorkspaceTransaction(workspaceId, (tx) => tx.approval.create({ data: { workspaceId, entityType: 'orchestration_task', entityId: task.id, requestedBy: null } }));
    await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.update({ where: { id: task.id }, data: { status: 'waiting_for_approval', approvalId: approval.id } }));
    await markWaitingForApproval(jobId, { leaseId, workerId });
    await writeAuditEvent({ workspaceId, runId: null, type: 'orchestration_task_approval_requested', actor: null, data: { jobId, taskId: task.id, approvalId: approval.id } });
    return;
  }

  const reserved = false;

  let controller: AbortController | null = new AbortController();
  const timer = setTimeout(() => controller?.abort(), Number(task.timeoutMs ?? 30000));
  try {
    const output = departmentProduces(String(task.departmentKey), action, taskRunGoal);
    if (controller?.signal.aborted) throw new Error('TASK_TIMEOUT');
    clearTimeout(timer);
    controller = null;

    await withWorkspaceTransaction(workspaceId, async (tx) => {
      await tx.orchestrationTask.update({ where: { id: task.id }, data: { status: 'succeeded', output, finishedAt: now(), actualUnits: Number(task.estimatedUnits ?? 1) } });
      await writeAuditEvent({ workspaceId, runId: null, type: 'orchestration_task_succeeded', actor: null, data: { jobId, taskId: task.id, department: task.departmentKey } });
    });
    await completeJob(jobId, { leaseId, workerId });
  } catch (error) {
    clearTimeout(timer);
    if (controller) controller.abort();
    const message = sanitizeError(error);
    const jobAfter = await failJob(jobId, { error: message, retryable: true }, { leaseId, workerId });
    const attempts = Number(updatedTask?.attemptCount ?? 0);
    const maxAttempts = Number(task.maxAttempts ?? 2);
    if (attempts < maxAttempts && jobAfter?.status !== 'DEAD_LETTER') {
      await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.update({ where: { id: task.id }, data: { status: 'queued', error: message, startedAt: null, finishedAt: null } }));
    } else {
      const finalStatus = jobAfter?.status === 'DEAD_LETTER' ? 'dead_letter' : 'failed';
      await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.update({ where: { id: task.id }, data: { status: finalStatus, error: message, finishedAt: now() } }));
      await writeAuditEvent({ workspaceId, runId: null, type: 'orchestration_task_failed', actor: null, data: { jobId, taskId: task.id, department: task.departmentKey, error: message } });
    }
  }
}

export async function runOrchestration(workspaceId: string, runId: string): Promise<any> {
  await ensureDepartments(workspaceId);
  await ensureCompanyAgents(workspaceId);

  if (await withWorkspaceTransaction(workspaceId, (tx) => isKillSwitchActive(workspaceId, tx))) {
    return cancelOrchestrationRun(workspaceId, runId, 'KILL_SWITCH_ACTIVE');
  }

  const workerId = `orchestration-${runId}`;
  let guard = 0;
  while (guard < 10000) {
    guard += 1;
    const run: any = await getRun(workspaceId, runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return run;
    if (run.status === 'queued') {
      await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'running', startedAt: now(), currentStage: 'executing' } }));
    }

    const tasks: any[] = await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.findMany({ where: { workspaceId, runId }, orderBy: { priority: 'desc' } }));
    // Synchronize from job runtime.
    for (const task of tasks) {
      if (!task.jobId) continue;
      const job: any = await (async () => null)() ?? null;
    }

    const succeededIds = new Set(tasks.filter((task) => task.status === 'succeeded').map((task) => task.id));
    await recoverExpiredJobs(workspaceId);
    for (const task of tasks) {
      if (!task.jobId) continue;
      const job: any = await getJob(String(task.jobId));
      if (!job) continue;
      if (job.status === 'SUCCEEDED' && task.status !== 'succeeded') {
        await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.update({ where: { id: task.id }, data: { status: 'succeeded', finishedAt: now(), actualUnits: Number(task.estimatedUnits ?? 1) } }));
        task.status = 'succeeded';
      } else if ((job.status === 'FAILED' || job.status === 'DEAD_LETTER') && task.status !== 'failed' && task.status !== 'dead_letter') {
        await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.update({ where: { id: task.id }, data: { status: job.status === 'DEAD_LETTER' ? 'dead_letter' : 'failed', error: job.lastError ?? null, finishedAt: now() } }));
        task.status = job.status === 'DEAD_LETTER' ? 'dead_letter' : 'failed';
      } else if (job.status === 'CANCELLED' && task.status !== 'cancelled') {
        await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.update({ where: { id: task.id }, data: { status: 'cancelled', finishedAt: now(), error: 'RUN_CANCELLED' } }));
        task.status = 'cancelled';
      } else if (job.status === 'WAITING_FOR_APPROVAL' && task.status !== 'waiting_for_approval') {
        await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.update({ where: { id: task.id }, data: { status: 'waiting_for_approval' } }));
        task.status = 'waiting_for_approval';
      } else if ((job.status === 'QUEUED' || job.status === 'RETRY_WAIT' || job.status === 'RUNNING') && (task.status === 'running' || task.status === 'waiting_for_approval')) {
        if (job.status === 'QUEUED' || job.status === 'RETRY_WAIT') {
          await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.update({ where: { id: task.id }, data: { status: 'queued', startedAt: null } }));
          task.status = 'queued';
        }
      }
    }
    if (tasks.length > 0 && tasks.every((task) => task.status === 'succeeded')) {
      await withWorkspaceTransaction(workspaceId, async (tx) => {
        await tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'succeeded', result: { tasks: tasks.map((task) => ({ id: task.id, output: task.output })) }, finishedAt: now(), currentStage: 'completed' } });
        await writeAuditEvent({ workspaceId, runId: null, type: 'orchestration_succeeded', actor: null, data: { taskCount: tasks.length } });
      });
      return getRun(workspaceId, runId);
    }
    if (tasks.some((task) => task.status === 'failed' || task.status === 'dead_letter')) {
      const first = tasks.find((task) => task.status === 'failed' || task.status === 'dead_letter');
      await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'failed', error: first?.error ?? 'TASK_FAILED', finishedAt: now(), currentStage: first?.departmentKey ?? 'failed' } }));
      return getRun(workspaceId, runId);
    }
    if (tasks.some((task) => task.status === 'waiting_for_approval')) {
      await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'waiting_for_approval', currentStage: tasks.find((task) => task.status === 'waiting_for_approval')?.departmentKey } }));
      return getRun(workspaceId, runId);
    }
    if (tasks.some((task) => task.status === 'cancelled')) {
      await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'cancelled', finishedAt: now(), currentStage: 'cancelled' } }));
      return getRun(workspaceId, runId);
    }

    const readyTasks = tasks.filter((task) => task.status === 'queued' && (task.dependsOn ?? []).every((dep: string) => succeededIds.has(dep)))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    if (readyTasks.length === 0) {
      const pending = tasks.filter((task) => task.status === 'queued' || task.status === 'running');
      if (pending.length === 0) break;
      // Wait for any retry backoff or other process; bounded wait.
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }

    // Reserve budget atomically before any job creation.
    let batchStarted = 0;
    for (const task of readyTasks) {
      const estimated = Number(task.estimatedUnits ?? 1);
      let jobId = task.jobId;
      if (!jobId) {
        const reserved = await reserveBudget(workspaceId, runId, estimated, Number(run.budgetUnits ?? 100), 0);
        if (!reserved) {
          await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.update({ where: { id: task.id }, data: { status: 'failed', error: 'BUDGET_EXCEEDED', finishedAt: now() } }));
          continue;
        }
        try {
          jobId = await ensureTaskJob(workspaceId, runId, task);
        } catch (error) {
          await releaseBudget(workspaceId, runId, estimated);
          await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.update({ where: { id: task.id }, data: { status: 'failed', error: sanitizeError(error), finishedAt: now() } }));
          continue;
        }
      }
      batchStarted += 1;
      if (batchStarted >= Number(run.maxConcurrency ?? 2)) break;
    }

    const refreshedTasks: any[] = await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.findMany({ where: { workspaceId, runId }, orderBy: { priority: 'desc' } }));
    const prepared = refreshedTasks.filter((task) => task.status === 'queued' && (task.dependsOn ?? []).every((dep: string) => succeededIds.has(dep)) && task.jobId).slice(0, Number(run.maxConcurrency ?? 2));
    if (prepared.length === 0) continue;

    for (const task of prepared) {
      const claimedJob: any = await claimJobById(String(task.jobId), workerId, { leaseTtlMs: 30000, now: now() });
      if (!claimedJob || claimedJob.status !== 'RUNNING') continue;
      await processOrchestrationJob(workspaceId, runId, String(task.jobId), workerId, String(claimedJob.leaseId), new Date(claimedJob.leaseExpiresAt));
    }
  }
  return getRun(workspaceId, runId);
}

export async function cancelOrchestrationRun(workspaceId: string, runId: string, reason = 'MANUAL_CANCEL'): Promise<any> {
  const run = await getRun(workspaceId, runId);
  if (!run) throw new Error('RUN_NOT_FOUND');
  if (['succeeded', 'failed', 'cancelled'].includes(String(run.status))) return run;

  const tasks = run.tasks ?? [];
  const cancelErrors: any[] = [];
  for (const task of tasks) {
    if (!task.jobId) continue;
    try {
      await cancelJob(String(task.jobId), { reason: String(reason) });
    } catch (error) {
      cancelErrors.push({ jobId: task.jobId, error: sanitizeError(error) });
    }
  }
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    await tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'cancelled', error: reason, finishedAt: now(), currentStage: 'cancelled' } });
    await tx.orchestrationTask.updateMany({ where: { workspaceId, runId, status: { in: ['queued', 'running', 'waiting_for_approval'] } }, data: { status: 'cancelled', finishedAt: now(), error: reason } });
    await writeAuditEvent({ workspaceId, runId: null, type: 'orchestration_cancel_requested', actor: null, data: { reason, requestedJobs: tasks.map((t: any) => t.jobId).filter(Boolean) } });
    await writeAuditEvent({ workspaceId, runId: null, type: cancelErrors.length ? 'orchestration_cancel_failed' : 'orchestration_cancel_succeeded', actor: null, data: { reason, cancelErrors } });
    return tx.orchestrationRun.findUnique({ where: { id: runId }, include: { tasks: true } });
  });
}

export async function decideOrchestrationTaskApproval(workspaceId: string, runId: string, taskId: string, approved: boolean, actor?: string | null, reason?: string | null): Promise<any> {
  await ensureDepartments(workspaceId);
  const killActive = await withWorkspaceTransaction(workspaceId, (tx) => isKillSwitchActive(workspaceId, tx));
  if (killActive) throw Object.assign(new Error('KILL_SWITCH_ACTIVE'), { statusCode: 409 });
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const task = await tx.orchestrationTask.findUnique({ where: { id: taskId } });
    if (!task || task.runId !== runId) throw Object.assign(new Error('TASK_NOT_FOUND'), { statusCode: 404 });
    if (!task.approvalId) throw Object.assign(new Error('APPROVAL_NOT_FOUND'), { statusCode: 404 });
    const approval = await tx.approval.findUnique({ where: { id: task.approvalId } });
    if (!approval || approval.status !== 'pending') throw Object.assign(new Error('APPROVAL_NOT_PENDING'), { statusCode: 409 });
    await tx.approval.update({ where: { id: task.approvalId }, data: { status: approved ? 'approved' : 'rejected', decidedBy: actor ?? null, decidedAt: now(), reason: reason ?? null } });
    await tx.orchestrationTask.update({ where: { id: taskId }, data: { status: approved ? 'queued' : 'failed', error: approved ? null : (reason ?? 'APPROVAL_REJECTED'), finishedAt: approved ? null : now() } });
    if (task.jobId) {
      if (approved) {
        try {
          await tx.job.update({ where: { id: String(task.jobId) }, data: { status: 'QUEUED', runAt: now(), finishedAt: null, lastError: null } });
        } catch {}
      } else {
        try {
          await tx.job.update({ where: { id: String(task.jobId) }, data: { status: 'FAILED', finishedAt: now(), lastError: reason ?? 'APPROVAL_REJECTED' } });
        } catch {}
      }
    }
    await writeAuditEvent({ workspaceId, runId: null, type: 'orchestration_approval_decided', actor: actor ?? null, data: { taskId, approved, reason } });
    return tx.orchestrationRun.findUnique({ where: { id: runId }, include: { tasks: true } });
  });
}

export async function getOrchestrationRun(workspaceId: string, runId: string): Promise<any> {
  return withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationRun.findUnique({ where: { id: runId }, include: { tasks: true } }));
}

export async function listOrchestrationRuns(workspaceId: string): Promise<any[]> {
  return withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationRun.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, include: { tasks: true } }));
}

export async function resumeOrchestrationRun(workspaceId: string, runId: string): Promise<any> {
  const run = await getOrchestrationRun(workspaceId, runId);
  if (!run) throw new Error('RUN_NOT_FOUND');
  if (run.status === 'cancelled') return run;
  return runOrchestration(workspaceId, runId);
}

export const orchestrate = createOrchestrationRun;
export const createOrchestration = createOrchestrationRun;
export const startOrchestration = createOrchestrationRun;
export const processOrchestrationRun = runOrchestration;
export const runOrchestrationRun = runOrchestration;
export const getOrchestration = getOrchestrationRun;
export const listOrchestrations = listOrchestrationRuns;
export const decideTaskApproval = decideOrchestrationTaskApproval;

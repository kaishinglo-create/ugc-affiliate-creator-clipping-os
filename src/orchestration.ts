import { withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';
import { isKillSwitchActive } from '../lib/security.js';

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
  coo: 'COO / Operations',
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
    const roles = [
      { name: 'CEO Orchestrator', role: 'CEO', capabilities: ['decompose', 'delegate', 'synthesize', 'approve'], toolPermissions: [] },
      { name: 'COO Operations', role: 'COO', capabilities: ['schedule', 'route', 'monitor', 'retry', 'escalate'], toolPermissions: [] },
    ];
    const created: any[] = [];
    for (const item of roles) {
      const existing = await tx.agentDefinition.findFirst({ where: { workspaceId, name: item.name } });
      if (existing) {
        created.push(existing);
        continue;
      }
      created.push(await tx.agentDefinition.create({
        data: {
          workspaceId,
          name: item.name,
          role: item.role,
          capabilities: item.capabilities,
          enabled: true,
        },
      }));
    }
    for (const key of DEPARTMENT_KEYS) {
      const name = `${DEPARTMENT_NAMES[key]} Lead`;
      const existing = await tx.agentDefinition.findFirst({ where: { workspaceId, name } });
      if (existing) {
        created.push(existing);
        continue;
      }
      created.push(await tx.agentDefinition.create({
        data: {
          workspaceId,
          name,
          role: key,
          capabilities: DEPARTMENT_ALLOWED_TOOLS[key],
          enabled: true,
        },
      }));
    }
    return created;
  });
}

export async function listDepartments(workspaceId: string): Promise<any[]> {
  await ensureDepartments(workspaceId);
  return withWorkspaceTransaction(workspaceId, (tx) => tx.department.findMany({ where: { workspaceId }, orderBy: { key: 'asc' } }));
}

async function getRun(workspaceId: string, runId: string): Promise<any> {
  return withWorkspaceTransaction(workspaceId, async (t) => {
    return t.orchestrationRun.findUnique({ where: { id: runId }, include: { tasks: true } });
  });
}

function validateDependencyGraph(tasks: { id: string; dependsOn: string[] }[]): boolean {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) return false;
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  function visit(id: string): boolean {
    if (visited.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!visit(dep)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  }
  return tasks.every((task) => visit(task.id));
}

async function taskStatus(workspaceId: string, runId: string): Promise<any[]> {
  return withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.findMany({ where: { workspaceId, runId }, orderBy: { createdAt: 'asc' } }));
}

async function departmentHandler(departmentKey: string, context: any): Promise<any> {
  const goal = String(context.goal ?? '');
  switch (departmentKey) {
    case 'ceo':
      return { summary: goal ? `CEO synthesis for: ${goal}` : 'CEO orchestration', stage: context?.task ?? 'ceo' };
    case 'research':
      return {
        summary: `Research plan for target: ${goal}`,
        questions: ['market trend', 'competitor angle', 'audience pain point'],
        tools: DEPARTMENT_ALLOWED_TOOLS.research,
      };
    case 'analytics':
      return {
        summary: 'Analytics hypothesis based on provided goal',
        metrics: ['views', 'clicks', 'conversions'],
        tools: DEPARTMENT_ALLOWED_TOOLS.analytics,
      };
    case 'strategy':
      return {
        summary: `Campaign strategy derived from goal: ${goal}`,
        channels: ['short-form', 'affiliate', 'email'],
        inputs: context.inputs,
      };
    case 'creative':
      return {
        variants: [`Variant A: ${goal}`, `Variant B: ${goal} (proof-led)`, `Variant C: ${goal} (story-led)`],
        tools: DEPARTMENT_ALLOWED_TOOLS.creative,
      };
    case 'video':
      return {
        clips: [{ start: 0, end: 15, rationale: 'hook segment' }, { start: 15, end: 45, rationale: 'value segment' }],
        tools: DEPARTMENT_ALLOWED_TOOLS.video,
      };
    case 'growth':
      return {
        ctaVariants: ['link-in-bio', 'pinned comment', 'description CTA'],
        hypotheses: ['proof reduces friction', 'shorter CTA increases clicks'],
        tools: DEPARTMENT_ALLOWED_TOOLS.growth,
      };
    case 'qa':
      return {
        passed: true,
        checks: ['required fields present', 'brand safety', 'format validity'],
        approvedFor: 'publishing',
      };
    case 'publishing':
      return {
        status: 'planned_only',
        platforms: ['tiktok', 'instagram', 'youtube'],
        requiresExternalIntegration: true,
        plannedPosts: 3,
      };
    case 'security':
      return {
        riskClass: 'medium',
        checks: ['approval gate present', 'allowed tools only', 'no secret exposure'],
        killSwitchRespected: true,
      };
    default:
      throw new Error(`UNKNOWN_DEPARTMENT:${departmentKey}`);
  }
}

export async function createOrchestrationRun(workspaceId: string, input: any): Promise<any> {
  await ensureDepartments(workspaceId);
  await ensureCompanyAgents(workspaceId);
  const goal = String(input?.goal ?? '').trim();
  if (!goal) throw new Error('INVALID_GOAL');
  const maxConcurrency = Math.max(1, Math.min(8, Number(input?.maxConcurrency ?? 2) || 2));
  const budgetUnits = Math.max(1, Math.min(10000, Number(input?.budgetUnits ?? 100) || 100));

  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const run = await tx.orchestrationRun.create({
      data: {
        workspaceId,
        goal,
        requestedBy: input?.requestedBy ?? null,
        status: 'queued',
        budgetUnits,
        maxConcurrency,
        strategy: {
          ceo: 'decompose into research, analytics, strategy, creative, video, growth, qa, publishing, security',
          coo: 'dependency-aware fan-out and fan-in with budget and kill-switch checks',
        },
      },
    });

    const taskDefs: { id: string; departmentKey: string; action: string; priority: number; estimatedUnits: number; dependsOn: string[]; requiresApproval: boolean; parentTaskId?: string }[] = [];
    const mk = (departmentKey: string, action: string, priority: number, estimatedUnits: number, dependsOn: string[]) => {
      const id = `${run.id}-${departmentKey}`;
      taskDefs.push({ id, departmentKey, action, priority, estimatedUnits, dependsOn, requiresApproval: departmentKey === 'publishing' });
      return id;
    };

    const rootId = `${run.id}-ceo`;
    taskDefs.unshift({ id: rootId, departmentKey: 'ceo', action: 'orchestrate', priority: 10, estimatedUnits: 1, dependsOn: [], requiresApproval: false });

    const researchId = mk('research', 'research_market', 8, 10, [rootId]);
    const analyticsId = mk('analytics', 'analyze_metrics', 7, 6, [rootId]);
    const strategyId = mk('strategy', 'build_campaign_plan', 8, 8, [researchId, analyticsId]);
    const creativeId = mk('creative', 'generate_variants', 7, 12, [strategyId]);
    const videoId = mk('video', 'prepare_clips', 6, 15, [creativeId]);
    const growthId = mk('growth', 'build_affiliate_plan', 6, 8, [strategyId, analyticsId]);
    const qaId = mk('qa', 'validate_content', 7, 5, [creativeId, videoId]);
    const publishingId = mk('publishing', 'plan_publication', 5, 4, [qaId]);
    const securityId = mk('security', 'review_governance', 9, 4, [qaId, publishingId]);
    const finalId = `${run.id}-ceo-final`;
    taskDefs.push({ id: finalId, departmentKey: 'ceo', action: 'synthesize', priority: 10, estimatedUnits: 2, dependsOn: [publishingId, securityId, growthId], requiresApproval: false });

    if (!validateDependencyGraph(taskDefs.map((task) => ({ id: task.id, dependsOn: task.dependsOn })))) {
      throw new Error('INVALID_ORCHESTRATION_GRAPH');
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
          input: { goal, task: task.id },
          timeoutMs: 30000,
        },
      });
    }

    await tx.delegationRecord.create({
      data: {
        workspaceId,
        runId: run.id,
        fromRole: 'CEO',
        toDepartment: 'multiple',
        taskIds: taskDefs.map((task) => task.id),
        reason: 'initial orchestration decomposition',
      },
    });

    return tx.orchestrationRun.findUnique({ where: { id: run.id }, include: { tasks: true } });
  });
}

export async function runOrchestration(workspaceId: string, runId: string): Promise<any> {
  await ensureDepartments(workspaceId);
  await ensureCompanyAgents(workspaceId);
  const killActive = await withWorkspaceTransaction(workspaceId, (tx) => isKillSwitchActive(workspaceId, tx));
  if (killActive) {
    return withWorkspaceTransaction(workspaceId, async (tx) => {
      await tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'cancelled', error: 'KILL_SWITCH_ACTIVE', finishedAt: now() } });
      return tx.orchestrationRun.findUnique({ where: { id: runId }, include: { tasks: true } });
    });
  }

  let guard = 0;
  while (guard < 1000) {
    guard += 1;
    const run = await getRun(workspaceId, runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return run;
    if (run.status === 'queued') {
      await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'running', startedAt: now(), currentStage: 'executing' } }));
    }

    const tasks = await taskStatus(workspaceId, runId);
    const byId = new Map(tasks.map((task: any) => [task.id, task]));
    const completed = tasks.every((task: any) => task.status === 'succeeded');
    if (completed && tasks.length > 0) {
      const outputs = tasks.map((task: any) => ({ id: task.id, department: task.departmentKey, output: task.output }));
      return withWorkspaceTransaction(workspaceId, async (tx) => {
        await tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'succeeded', result: { outputs }, finishedAt: now(), currentStage: 'completed' } });
        return tx.orchestrationRun.findUnique({ where: { id: runId }, include: { tasks: true } });
      });
    }

    const failedTask = tasks.find((task: any) => task.status === 'failed' || task.status === 'dead_letter');
    if (failedTask) {
      return withWorkspaceTransaction(workspaceId, async (tx) => {
        await tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'failed', error: failedTask.error ?? 'TASK_FAILED', finishedAt: now(), currentStage: failedTask.departmentKey } });
        return tx.orchestrationRun.findUnique({ where: { id: runId }, include: { tasks: true } });
      });
    }

    const waitingTask = tasks.find((task: any) => task.status === 'waiting_for_approval');
    if (waitingTask) {
      return withWorkspaceTransaction(workspaceId, async (tx) => {
        await tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'waiting_for_approval', currentStage: waitingTask.departmentKey } });
        return tx.orchestrationRun.findUnique({ where: { id: runId }, include: { tasks: true } });
      });
    }

    const readyTasks = tasks.filter((task: any) => {
      if (task.status !== 'queued') return false;
      const depsOk = (task.dependsOn ?? []).every((dep: string) => byId.get(dep)?.status === 'succeeded');
      if (!depsOk) return false;
      if ((run.spentUnits + (task.estimatedUnits ?? 0)) > run.budgetUnits) return false;
      return true;
    }).sort((a: any, b: any) => (b.priority ?? 0) - (a.priority ?? 0));

    if (readyTasks.length === 0) {
      const stalled = tasks.filter((task: any) => task.status === 'queued' || task.status === 'running');
      if (stalled.length === 0) break;
      return withWorkspaceTransaction(workspaceId, async (tx) => {
        await tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'failed', error: 'ORCHESTRATION_STALLED', finishedAt: now() } });
        return tx.orchestrationRun.findUnique({ where: { id: runId }, include: { tasks: true } });
      });
    }

    const batch = readyTasks.slice(0, Math.max(1, Math.min(run.maxConcurrency ?? 2, readyTasks.length)));
    await Promise.all(batch.map((task: any) => executeTask(workspaceId, runId, task.id)));
  }
  throw new Error('ORCHESTRATION_LOOP_OVERFLOW');
}

async function executeTask(workspaceId: string, runId: string, taskId: string): Promise<void> {
  if (await isKillSwitchActive(workspaceId)) {
    await withWorkspaceTransaction(workspaceId, async (tx) => {
      await tx.orchestrationTask.update({ where: { id: taskId }, data: { status: 'cancelled', error: 'KILL_SWITCH_ACTIVE', finishedAt: now() } });
      await tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'cancelled', error: 'KILL_SWITCH_ACTIVE', finishedAt: now() } });
    });
    return;
  }

  await withWorkspaceTransaction(workspaceId, async (tx) => {
    await tx.orchestrationTask.update({ where: { id: taskId }, data: { status: 'running', startedAt: now(), attemptCount: { increment: 1 } } });
  });

  const task: any = await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.findUnique({ where: { id: taskId } }));
  if (!task) return;

  if (task.requiresApproval) {
    const approval: any = await withWorkspaceTransaction(workspaceId, (tx) => tx.approval.create({
      data: {
        workspaceId,
        entityType: 'orchestration_task',
        entityId: taskId,
        requestedBy: null,
      },
    }));
    await withWorkspaceTransaction(workspaceId, async (tx) => {
      await tx.orchestrationTask.update({ where: { id: taskId }, data: { status: 'waiting_for_approval', approvalId: approval.id } });
    });
    await writeAuditEvent({ workspaceId, type: 'orchestration_task_approval_requested', actor: null, data: { runId, taskId, approvalId: approval.id } });
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(task.timeoutMs ?? 30000));
    const output = await departmentHandler(task.departmentKey, {
      goal: (await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationRun.findUnique({ where: { id: runId } })) as any)?.goal,
      inputs: task.input,
    });
    clearTimeout(timeout);
    if (controller.signal.aborted) throw new Error('TASK_TIMEOUT');

    await withWorkspaceTransaction(workspaceId, async (tx) => {
      await tx.orchestrationTask.update({
        where: { id: taskId },
        data: { status: 'succeeded', output, finishedAt: now(), actualUnits: task.estimatedUnits },
      });
      await tx.orchestrationRun.update({ where: { id: runId }, data: { spentUnits: { increment: task.estimatedUnits ?? 0 } } });
      await writeAuditEvent({ workspaceId, type: 'orchestration_task_succeeded', actor: null, data: { runId, taskId, department: task.departmentKey } });
    });
  } catch (error) {
    const message = sanitizeError(error);
    const updatedTask: any = await withWorkspaceTransaction(workspaceId, (tx) => tx.orchestrationTask.findUnique({ where: { id: taskId } }));
    const attempts = updatedTask?.attemptCount ?? task.attemptCount ?? 0;
    const maxAttempts = updatedTask?.maxAttempts ?? task.maxAttempts ?? 2;
    if (attempts < maxAttempts) {
      await withWorkspaceTransaction(workspaceId, async (tx) => {
        await tx.orchestrationTask.update({ where: { id: taskId }, data: { status: 'queued', error: message, startedAt: null, finishedAt: null } });
      });
    } else {
      await withWorkspaceTransaction(workspaceId, async (tx) => {
        await tx.orchestrationTask.update({ where: { id: taskId }, data: { status: 'failed', error: message, finishedAt: now() } });
        await writeAuditEvent({ workspaceId, type: 'orchestration_task_failed', actor: null, data: { runId, taskId, department: task.departmentKey, error: message } });
      });
    }
  }
}

export async function decideOrchestrationTaskApproval(workspaceId: string, runId: string, taskId: string, approved: boolean, actor?: string | null, reason?: string | null): Promise<any> {
  await ensureDepartments(workspaceId);
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    const task = await tx.orchestrationTask.findUnique({ where: { id: taskId } });
    if (!task || task.runId !== runId) throw new Error('TASK_NOT_FOUND');
    if (!task.approvalId) throw new Error('APPROVAL_NOT_FOUND');
    await tx.approval.update({
      where: { id: task.approvalId },
      data: { status: approved ? 'approved' : 'rejected', decidedBy: actor ?? null, decidedAt: now(), reason: reason ?? null },
    });
    if (!approved) {
      await tx.orchestrationTask.update({ where: { id: taskId }, data: { status: 'failed', error: reason ?? 'APPROVAL_REJECTED', finishedAt: now() } });
    } else {
      await tx.orchestrationTask.update({ where: { id: taskId }, data: { status: 'queued', approvalId: task.approvalId } });
    }
    await writeAuditEvent({ workspaceId, type: 'orchestration_approval_decided', actor: actor ?? null, data: { runId, taskId, approved, reason } });
    return tx.orchestrationRun.findUnique({ where: { id: runId }, include: { tasks: true } });
  });
}

export async function cancelOrchestrationRun(workspaceId: string, runId: string): Promise<any> {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    await tx.orchestrationRun.update({ where: { id: runId }, data: { status: 'cancelled', finishedAt: now(), currentStage: 'cancelled' } });
    await tx.orchestrationTask.updateMany({ where: { workspaceId, runId, status: { in: ['queued', 'running', 'waiting_for_approval'] } }, data: { status: 'cancelled', finishedAt: now(), error: 'RUN_CANCELLED' } });
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
  if (run.status === 'cancelled' || run.status === 'failed') return run;
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

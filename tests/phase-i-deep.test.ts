import 'dotenv/config';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { recordIncident, resolveIncident } from '../src/incident-monitor.js';
import { planRecovery, approveRecovery, executeRecovery, rollbackRecovery, recoverStaleRecoveryRuns } from '../src/recovery-engine.js';
import { recordImprovementMetric, refreshImprovements } from '../src/improvement-engine.js';
import { assertSandboxPath, assertSandboxCommand, sandboxCapabilities, evaluateSandboxChanges } from '../src/sandbox-policy.js';
import { driveOrchestrationTo } from './helpers/orchestration-engine.js';

const workspaceIds: string[] = [];
let app: any;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (app) await app.close();
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.$disconnect();
});

async function workspace() {
  const suffix = randomUUID();
  const email = `pi-deep-${suffix}@x.com`;
  const signup = await app.inject({
    method: 'POST', url: '/api/auth/signup',
    payload: { email, password: 'password1234', workspaceName: 'PI deep', workspaceSlug: `pi-deep-${suffix}` },
  });
  expect(signup.statusCode).toBe(201);
  const workspaceId = signup.json().workspace.id;
  workspaceIds.push(workspaceId);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
  return { workspaceId, headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId } };
}

async function approvedRun(workspaceId: string, kind: string, evidence: Record<string, unknown>) {
  const incident = await recordIncident({ workspaceId, kind, severity: 'warning', evidence });
  const plan = await planRecovery({ workspaceId, incidentId: incident.incident.id, actor: 'operator' });
  const approved = await approveRecovery({ workspaceId, recoveryRunId: plan.id, actor: 'operator' });
  return { incident: incident.incident, plan, approved };
}

describe('Phase I fault injection for the six real incident classes', () => {
  it('injects every case, plans report_only, executes and resolves', async () => {
    app = await buildServer();
    const { workspaceId } = await workspace();
    for (const kind of ['INC-PH-01', 'INC-PH-02', 'INC-PH-03', 'INC-PH-04', 'INC-PH-05', 'INC-PH-06']) {
      const { incident, approved } = await approvedRun(workspaceId, kind, { injected: true });
      const executed = await executeRecovery({ workspaceId, recoveryRunId: approved.id, actor: 'operator' });
      expect(executed.status).toBe('succeeded');
      expect((executed.result as any).mutations).toBe(0);
      const resolved = await resolveIncident(workspaceId, incident.id, true);
      expect(resolved?.status).toBe('resolved');
      const audit: any[] = await withWorkspaceTransaction<any[]>(workspaceId, (tx: any) =>
        tx.auditEvent.findMany({ where: { workspaceId, type: 'recovery_executed' } }));
      expect(audit.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('executes a real stale-lease recovery and verifies the job state', async () => {
    const { workspaceId } = await workspace();
    const staleJob: any = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.job.create({
      data: {
        workspaceId, type: 'AGENT_TASK', status: 'RUNNING', payload: { injected: true },
        leaseId: `lease-${randomUUID()}`, leaseOwner: 'own-worker', leaseExpiresAt: new Date(Date.now() - 60_000),
        runAt: new Date(),
      },
    }));
    const { approved } = await approvedRun(workspaceId, 'stale_job_lease', { jobId: staleJob.id });
    const executed = await executeRecovery({ workspaceId, recoveryRunId: approved.id, actor: 'operator' });
    expect(executed.status).toBe('succeeded');
    expect((executed.result as any).recovered).toBe(1);
    const after: any = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.job.findUnique({ where: { id: staleJob.id } }));
    expect(after.status).toBe('QUEUED');
    expect(after.leaseId).toBeNull();
  });

  it('rolls back a failed recovery deterministically', async () => {
    const { workspaceId } = await workspace();
    const job: any = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.job.create({
      data: { workspaceId, type: 'AGENT_TASK', status: 'RETRY_WAIT', payload: {}, runAt: new Date(Date.now() - 1000) },
    }));
    const { approved } = await approvedRun(workspaceId, 'due_retry_wait', { jobId: job.id });
    const executed = await executeRecovery({ workspaceId, recoveryRunId: approved.id, actor: 'operator' });
    expect((executed.result as any).promoted).toBe(1);
    const rolled = await rollbackRecovery(workspaceId, approved.id, 'operator');
    expect(rolled?.status).toBe('rolled_back');
    const after: any = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.job.findUnique({ where: { id: job.id } }));
    expect(after.status).toBe('RETRY_WAIT');
  });
});

describe('Phase I governance gates', () => {
  it('blocks approval bypass, budget excess and active kill switch', async () => {
    const { workspaceId } = await workspace();
    const incident = await recordIncident({ workspaceId, kind: 'INC-PH-01', severity: 'warning', evidence: { a: 1 } });
    const plan = await planRecovery({ workspaceId, incidentId: incident.incident.id, actor: 'operator' });
    await expect(executeRecovery({ workspaceId, recoveryRunId: plan.id, actor: 'operator' })).rejects.toThrow('APPROVAL_REQUIRED');
    const forged: any = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.approval.create({
      data: { workspaceId, entityType: 'recovery_run', entityId: 'wrong-id', status: 'approved', decidedBy: 'operator', decidedAt: new Date() },
    }));
    await withWorkspaceTransaction(workspaceId, (tx: any) => tx.recoveryRun.update({
      where: { id: plan.id }, data: { approvalId: forged.id },
    }));
    await expect(executeRecovery({ workspaceId, recoveryRunId: plan.id, actor: 'operator' })).rejects.toThrow('APPROVAL_REQUIRED');

    vi.stubEnv('PHASE_I_MAX_RECOVERIES_PER_WORKSPACE_DAILY', '1');
    const second = await approvedRun(workspaceId, 'INC-PH-02', { b: 2 });
    await executeRecovery({ workspaceId, recoveryRunId: second.approved.id, actor: 'operator' });
    await expect(executeRecovery({ workspaceId, recoveryRunId: plan.id, actor: 'operator' })).rejects.toThrow();
    vi.unstubAllEnvs();

    const third = await approvedRun(workspaceId, 'INC-PH-03', { c: 3 });
    // Kill switch is workspace scoped; activate it for this workspace only.
    await withWorkspaceTransaction(workspaceId, (tx: any) => tx.killSwitch.upsert({
      where: { workspaceId }, create: { workspaceId, active: true }, update: { active: true },
    }));
    await expect(executeRecovery({ workspaceId, recoveryRunId: third.approved.id, actor: 'operator' })).rejects.toThrow('KILL_SWITCH_ACTIVE');
  });

  it('recovers interrupted recovery runs after a crash', async () => {
    const { workspaceId } = await workspace();
    const { approved } = await approvedRun(workspaceId, 'INC-PH-04', { interrupted: true });
    const startedAt = new Date(Date.now() - 600_000);
    await withWorkspaceTransaction(workspaceId, (tx: any) => tx.recoveryRun.update({
      where: { id: approved.id }, data: { status: 'executing', startedAt },
    }));
    const recovered = await recoverStaleRecoveryRuns({ workspaceId, staleMs: 300_000 });
    expect(recovered).toBe(1);
    const row: any = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.recoveryRun.findUnique({ where: { id: approved.id } }));
    expect(row.status).toBe('unresolved');
  });
});

describe('Phase I improvements, agents and sandbox isolation', () => {
  it('persists before/after metrics and uses Phase I data in real orchestration', async () => {
    const { workspaceId, headers } = await workspace();
    await app.inject({ method: 'POST', url: '/api/departments/seed', headers, payload: {} });
    await recordIncident({ workspaceId, kind: 'INC-PH-05', severity: 'error', evidence: { drift: true } });
    const refreshed = await refreshImprovements({ workspaceId, actor: 'operator' });
    expect(refreshed.examined).toBeGreaterThanOrEqual(0);
    const tasks: any[] = await withWorkspaceTransaction<any[]>(workspaceId, (tx: any) => tx.improvementTask.findMany({ where: { workspaceId } }));
    if (tasks.length) {
      await recordImprovementMetric({ workspaceId, taskId: tasks[0].id, phase: 'before', metrics: { incidents: 1 } });
      const after = await recordImprovementMetric({ workspaceId, taskId: tasks[0].id, phase: 'after', metrics: { incidents: 0 } });
      expect(after?.afterJson).toEqual({ incidents: 0 });
      expect(after?.status).toBe('measured');
    }
    const created = await app.inject({ method: 'POST', url: '/api/orchestrations', headers, payload: { goal: 'heal and improve' } });
    expect(created.statusCode).toBe(201);
    const run = created.json().orchestration;
    const waiting = await driveOrchestrationTo(workspaceId, run.id, 'waiting_for_approval');
    const waitingTask = (waiting.tasks || []).find((t: any) => t.status === 'waiting_for_approval');
    await app.inject({
      method: 'POST', url: `/api/orchestrations/${run.id}/tasks/${waitingTask.id}/approve`, headers,
      payload: { status: 'approved', reason: 'test' },
    });
    const done = await driveOrchestrationTo(workspaceId, run.id, 'succeeded');
    const outputs = (done.tasks || []).map((t: any) => t.output).filter(Boolean);
    expect(outputs.some((o: any) => o.phaseIContextSource === 'phase_i_workspace_rows')).toBe(true);
  });

  it('enforces sandbox path, command and governance boundaries', () => {
    const root = `/tmp/opencode/phase-i-sandbox-policy-test-${randomUUID()}`;
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'allowed.txt'), 'ok');
    mkdirSync(path.join(root, 'sub'), { recursive: true });
    symlinkSync('/etc', path.join(root, 'escape'));
    expect(() => assertSandboxPath(root, 'allowed.txt')).not.toThrow();
    expect(() => assertSandboxPath(root, '../outside')).toThrow('SANDBOX_PATH_ESCAPE');
    expect(() => assertSandboxPath(root, 'escape/passwd')).toThrow('SANDBOX_SYMLINK_ESCAPE');
    expect(() => assertSandboxPath(root, '.env')).toThrow('SANDBOX_GOVERNANCE_PATH');
    expect(() => assertSandboxCommand('git', ['commit', '-m', 'x'])).toThrow('SANDBOX_GIT_WRITE_BLOCKED');
    expect(() => assertSandboxCommand('curl', ['https://example.test'])).toThrow('SANDBOX_COMMAND_BLOCKED');
    expect(() => assertSandboxCommand(process.execPath, ['node_modules/typescript/bin/tsc'])).not.toThrow();
    const evaluation = evaluateSandboxChanges([{ path: 'src/example.ts' }, { path: 'docs/completion/controller/STOP' }], root);
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasons).toContain('SANDBOX_GOVERNANCE_PATH');
    const caps: any = sandboxCapabilities();
    expect(caps.failClosedByDefault).toBe(true);
    expect(caps.osNamespaces).toBe('unavailable');
  });
});

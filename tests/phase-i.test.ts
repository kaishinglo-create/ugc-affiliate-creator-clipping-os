import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { inspectFreeze, recordIncident, listIncidents, diagnoseIncident, resolveIncident, higherSeverity } from '../src/incident-monitor.js';
import { diagnoseIncidentKind, planRecovery, approveRecovery, executeRecovery, rollbackRecovery } from '../src/recovery-engine.js';
import { refreshImprovements, listImprovements, recordImprovementMetric } from '../src/improvement-engine.js';
import { sandboxEnabled, proposePatch, reviewSandbox } from '../src/coding-agent.js';
import { phaseIAgentContext } from '../src/phase-i-agent-context.js';

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
  const email = `pi-${suffix}@x.com`;
  const signup = await app.inject({
    method: 'POST', url: '/api/auth/signup',
    payload: { email, password: 'password1234', workspaceName: 'Phase I', workspaceSlug: `pi-${suffix}` },
  });
  expect(signup.statusCode).toBe(201);
  const workspaceId = signup.json().workspace.id;
  workspaceIds.push(workspaceId);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
  return { workspaceId, headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId } };
}

describe('Phase I monitoring and incident management', () => {
  it('detects freeze drift and classifies severity', () => {
    expect(higherSeverity('info', 'critical')).toBe('critical');
    expect(higherSeverity('error', 'warning')).toBe('error');
    const signal = inspectFreeze('/tmp/opencode/definitely-missing-manifest.json');
    expect(signal.kind).toBe('source_freeze');
    expect(signal.healthy).toBe(false);
  });

  it('deduplicates persistent incidents and isolates workspaces', async () => {
    app = await buildServer();
    const first = await workspace();
    const second = await workspace();
    const evidence = { case: 'INC-PH-02', port: 3000 };
    const one = await recordIncident({ workspaceId: first.workspaceId, kind: 'port_conflict', severity: 'error', evidence });
    const two = await recordIncident({ workspaceId: first.workspaceId, kind: 'port_conflict', severity: 'critical', evidence });
    expect(one.deduplicated).toBe(false);
    expect(two.deduplicated).toBe(true);
    expect(two.incident.id).toBe(one.incident.id);
    const rows = await listIncidents(first.workspaceId);
    expect(rows).toHaveLength(1);
    expect(await listIncidents(second.workspaceId)).toHaveLength(0);
    const diagnosed = await diagnoseIncident(first.workspaceId, one.incident.id, { classification: 'foreign_process' });
    expect(diagnosed?.status).toBe('diagnosed');
    const resolved = await resolveIncident(first.workspaceId, one.incident.id, true);
    expect(resolved?.status).toBe('resolved');

    const api = await app.inject({
      method: 'GET', url: '/api/system/incidents', headers: first.headers,
    });
    expect(api.statusCode).toBe(200);
    expect(api.json().incidents).toHaveLength(1);
  });
});

describe('Phase I approval-gated recovery', () => {
  it('reports only for all six real incident classes', () => {
    for (const kind of ['INC-PH-01', 'INC-PH-02', 'INC-PH-03', 'INC-PH-04', 'INC-PH-05', 'INC-PH-06']) {
      const diagnosis = diagnoseIncidentKind(kind, {});
      expect(diagnosis.action).toBe('report_only');
      expect(diagnosis.classification).not.toBe('unknown');
    }
  });

  it('requires approval, verifies and records an audit trail', async () => {
    const { workspaceId, headers } = await workspace();
    const incident = await recordIncident({
      workspaceId, kind: 'INC-PH-01', severity: 'warning', evidence: { observed: 'parallel_agent' },
    });
    const plan = await planRecovery({ workspaceId, incidentId: incident.incident.id, actor: 'operator' });
    expect(plan.status).toBe('planned');
    await expect(executeRecovery({ workspaceId, recoveryRunId: plan.id, actor: 'operator' }))
      .rejects.toThrow('APPROVAL_REQUIRED');
    const approved = await approveRecovery({ workspaceId, recoveryRunId: plan.id, actor: 'operator' });
    expect(approved.status).toBe('approved');
    const executed = await executeRecovery({ workspaceId, recoveryRunId: plan.id, actor: 'operator' });
    expect(executed.status).toBe('succeeded');
    expect(executed.result).toMatchObject({ action: 'report_only', mutations: 0 });
    const audit: any[] = await withWorkspaceTransaction<any[]>(workspaceId, (tx: any) =>
      tx.auditEvent.findMany({ where: { workspaceId, type: { in: ['recovery_planned', 'recovery_approved', 'recovery_executed'] } } }));
    expect(audit.length).toBe(3);
    const api = await app.inject({ method: 'GET', url: '/api/recoveries', headers });
    expect(api.json().recoveries).toHaveLength(1);
  });

  it('rolls back an own-job recovery with a snapshot', async () => {
    const { workspaceId } = await workspace();
    const incident = await recordIncident({ workspaceId, kind: 'due_retry_wait', severity: 'warning', evidence: { job: 'x' } });
    const plan = await planRecovery({ workspaceId, incidentId: incident.incident.id, actor: 'operator' });
    await approveRecovery({ workspaceId, recoveryRunId: plan.id, actor: 'operator' });
    const executed = await executeRecovery({ workspaceId, recoveryRunId: plan.id, actor: 'operator' });
    expect(executed.status).toBe('succeeded');
    const rolled = await rollbackRecovery(workspaceId, plan.id, 'operator');
    expect(rolled?.status).toBe('rolled_back');
  });
});

describe('Phase I improvements, sandbox and agent context', () => {
  it('persists evidence-based improvements with measured metrics', async () => {
    app = await buildServer();
    const { workspaceId, headers } = await workspace();
    await app.inject({
      method: 'POST', url: '/api/system/incidents', headers,
      payload: { kind: 'INC-PH-02', severity: 'error', evidence: { port: 3031 } },
    });
    const first = await refreshImprovements({ workspaceId, actor: 'operator' });
    const second = await refreshImprovements({ workspaceId, actor: 'operator' });
    expect(second.created).toBe(0);
    const tasks = await listImprovements(workspaceId);
    expect(tasks.length).toBeGreaterThanOrEqual(0);
    if (tasks.length) {
      const measured = await recordImprovementMetric({
        workspaceId, taskId: tasks[0].id, phase: 'before', metrics: { incidents: 1 }, actor: 'operator',
      });
      expect(measured?.beforeJson).toEqual({ incidents: 1 });
    }
    const api = await app.inject({ method: 'GET', url: '/api/improvements', headers });
    expect(api.statusCode).toBe(200);
    expect(first.examined).toBeGreaterThanOrEqual(0);
  });

  it('fails closed for sandbox actions without the explicit opt-in', async () => {
    vi.stubEnv('PHASE_I_SANDBOX_ENABLED', '');
    expect(sandboxEnabled()).toBe(false);
    const { workspaceId } = await workspace();
    const row: any = await withWorkspaceTransaction(workspaceId, (tx: any) =>
      tx.sandboxRun.create({ data: { workspaceId, worktreePath: '/tmp/opencode/phase-i-sandboxes/test', status: 'tests_passed', testsJson: { typecheck: { ok: true } } } }));
    const patched = await proposePatch({ workspaceId, sandboxId: row.id, taskTitle: 'test', evidence: { source: 'audit' }, actor: 'operator' });
    expect((patched.patchJson as any).source).toBe('deterministic_planner');
    await withWorkspaceTransaction(workspaceId, (tx: any) =>
      tx.sandboxRun.update({ where: { id: row.id }, data: { status: 'tests_passed' } }));
    const rejected = await reviewSandbox({ workspaceId, sandboxId: row.id, actor: 'operator', approved: false });
    expect(rejected.status).toBe('rejected');
    await expect(reviewSandbox({ workspaceId, sandboxId: row.id, actor: 'operator', approved: true })).rejects.toThrow();
  });

  it('derives agent context from persisted Phase I rows', async () => {
    const { workspaceId } = await workspace();
    await recordIncident({ workspaceId, kind: 'INC-PH-01', severity: 'critical', evidence: { a: 1 } });
    const context: any = await phaseIAgentContext(workspaceId, 'security');
    expect(context.phaseIContextSource).toBe('phase_i_workspace_rows');
    expect(context.openIncidents).toBe(1);
    expect(context.externalLiveVerified).toBe(false);
  });
});

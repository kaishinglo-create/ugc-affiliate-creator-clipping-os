import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { validateCeoSynthesis } from '../src/company-agents.js';
import { driveOrchestrationTo } from './helpers/orchestration-engine.js';

describe('CEO/COO company agents', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('validates synthesis only against real task evidence', () => {
    const now = new Date('2026-11-25T10:00:00.000Z');
    const tasks = [
      { id: 'root', departmentKey: 'ceo', action: 'orchestrate', status: 'succeeded', dependsOn: [] },
      { id: 'research', departmentKey: 'research', action: 'research_market', status: 'succeeded', dependsOn: ['root'] },
      { id: 'synth', departmentKey: 'ceo', action: 'synthesize', status: 'succeeded', dependsOn: ['research'] },
    ];
    const valid = validateCeoSynthesis({ id: 'run-1' }, tasks, now);
    expect(valid.status).toBe('valid');
    expect(valid.dependenciesResolved).toEqual(['research']);
    expect(valid.tasksSucceeded).toBe(3);
    expect(valid.checkedAt).toBe(now.toISOString());

    const invalid = validateCeoSynthesis({ id: 'run-1' }, tasks.map((task) => task.id === 'research' ? { ...task, status: 'failed' } : task), now);
    expect(invalid.status).toBe('invalid');
    expect(invalid.unresolvedDependencies).toEqual(['research']);
    expect(invalid.tasksFailed).toBe(1);

    const empty = validateCeoSynthesis({ id: 'run-2' }, [], now);
    expect(empty.status).toBe('invalid');
    expect(empty.evidence).toEqual([]);
  });

  it('persists COO routing/escalation and CEO validation from a real run', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `company-${suffix}@x.com`;
    const slug = `company-${suffix}`;
    const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'CO', workspaceSlug: slug } });
    expect(signup.statusCode).toBe(201);
    const ws = signup.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const headers = { cookie, 'x-workspace-id': ws };

    const created = await app.inject({ method: 'POST', url: '/api/orchestrations', headers, payload: { goal: 'company agent verification' } });
    expect(created.statusCode).toBe(201);
    const runId = created.json().orchestration.id;

    const initial = await app.inject({ method: 'GET', url: `/api/orchestrations/${runId}/company-agents`, headers });
    expect(initial.statusCode).toBe(200);
    const initialRecord = initial.json().companyAgents;
    expect(initialRecord.runId).toBe(runId);
    expect(initialRecord.coo.delegations.length).toBeGreaterThanOrEqual(1);
    expect(initialRecord.coo.delegations.every((d: any) => d.reason.startsWith('route:'))).toBe(true);
    expect(initialRecord.coo.operations.routed).toBeGreaterThanOrEqual(1);
    expect(initialRecord.ceo.validation).toBeNull();

    const waiting = await driveOrchestrationTo(ws, runId, 'waiting_for_approval');
    const waitingTask = (waiting.tasks || []).find((task: any) => task.status === 'waiting_for_approval');
    expect(waitingTask).toBeTruthy();

    const approval = await app.inject({ method: 'POST', url: `/api/orchestrations/${runId}/tasks/${waitingTask.id}/approve`, headers, payload: { status: 'approved', reason: 'automated verification' } });
    expect(approval.statusCode).toBe(200);

    const succeeded = await driveOrchestrationTo(ws, runId, 'succeeded');
    expect(succeeded.result.ceoValidation.status).toBe('valid');
    expect(succeeded.result.ceoValidation.tasksTotal).toBe(succeeded.tasks.length);

    const finalRecord = await app.inject({ method: 'GET', url: `/api/orchestrations/${runId}/company-agents`, headers });
    expect(finalRecord.statusCode).toBe(200);
    const record = finalRecord.json().companyAgents;
    expect(record.ceo.validation.status).toBe('valid');
    expect(record.ceo.insightId).toBeTruthy();
    expect(record.coo.delegations.some((d: any) => d.reason.startsWith('approval_gate:'))).toBe(true);
    expect(record.coo.delegations.some((d: any) => d.reason.startsWith('route:'))).toBe(true);

    await withWorkspaceTransaction(ws, (tx: any) => tx.job.deleteMany({ where: { workspaceId: ws } }));
    await withWorkspaceTransaction(ws, (tx: any) => tx.orchestrationRun.deleteMany({ where: { workspaceId: ws } }));
  }, 180_000);
});

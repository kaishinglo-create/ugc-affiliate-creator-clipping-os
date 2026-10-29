import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { executeRun } from '../src/workflows.js';

describe('workflows', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('create and run workflow', async () => {
    const email = `wf-${Date.now()}@x.com`;
    const slug = `wf-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'WF', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const def = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Echo flow', steps: [{ name: 'step1', action: 'echo' }] } });
    expect(def.statusCode).toBe(201);
    const run = await app.inject({ method: 'POST', url: `/api/workflows/${def.json().workflow.id}/run`, headers: { cookie, 'x-workspace-id': ws }, payload: { input: { hello: 'world' } } });
    expect(run.statusCode).toBe(200);
    expect(run.json().run.status).toBe('succeeded');
  });

  it('idempotency returns same run', async () => {
    const email = `wf2-${Date.now()}@x.com`;
    const slug = `wf2-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'WF2', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const def = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Echo flow2', steps: [{ name: 'step1', action: 'echo' }] } });
    const key = `key-${Date.now()}`;
    const run1 = await app.inject({ method: 'POST', url: `/api/workflows/${def.json().workflow.id}/run`, headers: { cookie, 'x-workspace-id': ws }, payload: { input: { a: 1 }, idempotencyKey: key } });
    const run2 = await app.inject({ method: 'POST', url: `/api/workflows/${def.json().workflow.id}/run`, headers: { cookie, 'x-workspace-id': ws }, payload: { input: { a: 1 }, idempotencyKey: key } });
    expect(run1.json().run.id).toBe(run2.json().run.id);
  });

  it('kill switch blocks workflow execution and writes audit event', async () => {
    const email = `wfb-${Date.now()}@x.com`;
    const slug = `wfb-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'WFB', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const def = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Kill flow', steps: [{ name: 'step1', action: 'echo' }] } });
    const run1 = await app.inject({ method: 'POST', url: `/api/workflows/${def.json().workflow.id}/run`, headers: { cookie, 'x-workspace-id': ws }, payload: { input: { hello: 'block' } } });
    expect(run1.json().run.status).toBe('succeeded');
    const act = await app.inject({ method: 'POST', url: '/api/security/kill-switch/activate', headers: { cookie, 'x-workspace-id': ws }, payload: { reason: 'test-kill' } });
    expect(act.statusCode).toBe(200);
    const run2 = await app.inject({ method: 'POST', url: `/api/workflows/${def.json().workflow.id}/run`, headers: { cookie, 'x-workspace-id': ws }, payload: { input: { hello: 'block2' } } });
    expect(run2.json().run.status).toBe('cancelled');
    expect(run2.json().run.error).toBe('KILL_SWITCH_ACTIVE');
    const events = await prisma.auditEvent.findMany({ where: { type: 'workflow_run_blocked' }, orderBy: { createdAt: 'desc' }, take: 10 });
    expect(events.length).toBeGreaterThan(0);
    const de = await app.inject({ method: 'POST', url: '/api/security/kill-switch/deactivate', headers: { cookie, 'x-workspace-id': ws } });
    expect(de.statusCode).toBe(200);
  });

  it('approval pending blocks workflow execution until approved', async () => {
    const email = `wfa-${Date.now()}@x.com`;
    const slug = `wfa-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'WFA', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const def = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Approval flow', steps: [{ name: 'step1', action: 'echo' }] } });
    const run: any = await withWorkspaceTransaction(ws, (tx) => tx.workflowRun.create({ data: { workspaceId: ws, definitionId: def.json().workflow.id, status: 'queued', input: {}, startedAt: new Date() } }));
    const approval = await app.inject({ method: 'POST', url: '/api/approvals', headers: { cookie, 'x-workspace-id': ws }, payload: { entityType: 'workflow_step', entityId: `${run.id}#echo` } });
    expect(approval.statusCode).toBe(201);
    const blocked = await executeRun(ws, run.id);
    expect(blocked).toBeTruthy();
    expect(blocked?.status).toBe('waiting_for_approval');
    const decide = await app.inject({ method: 'POST', url: `/api/approvals/${approval.json().approval.id}/decide`, headers: { cookie, 'x-workspace-id': ws }, payload: { status: 'approved', reason: 'approved-in-test' } });
    expect(decide.statusCode).toBe(200);
    const allowed = await executeRun(ws, run.id);
    expect(allowed).toBeTruthy();
    expect(allowed?.status).toBe('succeeded');
  });

  it('rejects workflow execution when approval is rejected', async () => {
    const email = `wfr-${Date.now()}@x.com`;
    const slug = `wfr-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'WFR', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const def = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Reject flow', steps: [{ name: 'step1', action: 'echo' }] } });
    const run: any = await withWorkspaceTransaction(ws, (tx) => tx.workflowRun.create({ data: { workspaceId: ws, definitionId: def.json().workflow.id, status: 'queued', input: {}, startedAt: new Date() } }));
    const approval = await app.inject({ method: 'POST', url: '/api/approvals', headers: { cookie, 'x-workspace-id': ws }, payload: { entityType: 'workflow_step', entityId: `${run.id}#echo` } });
    const blocked = await executeRun(ws, run.id);
    expect(blocked).toBeTruthy();
    expect(blocked?.status).toBe('waiting_for_approval');
    const decide = await app.inject({ method: 'POST', url: `/api/approvals/${approval.json().approval.id}/decide`, headers: { cookie, 'x-workspace-id': ws }, payload: { status: 'rejected', reason: 'rejected-in-test' } });
    expect(decide.statusCode).toBe(200);
    const rejected = await executeRun(ws, run.id);
    expect(rejected).toBeTruthy();
    expect(rejected?.status).toBe('failed');
    expect(rejected?.error).toBe('APPROVAL_REJECTED');
  });
});

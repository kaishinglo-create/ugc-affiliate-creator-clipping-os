import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { driveOrchestrationTo } from './helpers/orchestration-engine.js';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';

describe('orchestration', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('runs CEO orchestration and returns a valid hierarchy', async () => {
    const email = `or-${Date.now()}@x.com`;
    const slug = `or-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'OR', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const seed = await app.inject({ method: 'POST', url: '/api/departments/seed', headers: { cookie, 'x-workspace-id': ws } });
    expect(seed.statusCode).toBe(201);
    expect(seed.json().departments.length).toBe(9);

    const run = await app.inject({ method: 'POST', url: '/api/orchestrations', headers: { cookie, 'x-workspace-id': ws }, payload: { goal: 'Create a clipping campaign' } });
    expect(run.statusCode).toBe(201);
    const body = run.json().orchestration;
    expect(body.status).toBe('queued');
    expect(body.tasks.every((task: any) => task.status === 'queued' && !task.jobId)).toBe(true);
    const executed = await driveOrchestrationTo(ws, body.id, 'waiting_for_approval');
    expect(executed.tasks.some((task: any) => task.status === 'succeeded')).toBe(true);
    expect(body.tasks.length).toBeGreaterThanOrEqual(10);
    expect(body.tasks.some((task: any) => task.departmentKey === 'research')).toBe(true);
    expect(body.tasks.some((task: any) => task.departmentKey === 'security')).toBe(true);
    expect(body.tasks.some((task: any) => task.dependsOn.length > 0)).toBe(true);
  });

  it('blocks orchestration under kill switch', async () => {
    const email = `ork-${Date.now()}@x.com`;
    const slug = `ork-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'ORK', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    await app.inject({ method: 'POST', url: '/api/security/kill-switch/activate', headers: { cookie, 'x-workspace-id': ws }, payload: { reason: 'test' } });
    const run = await app.inject({ method: 'POST', url: '/api/orchestrations', headers: { cookie, 'x-workspace-id': ws }, payload: { goal: 'x' } });
    expect(run.statusCode).toBe(201);
    expect(run.json().orchestration.status).toBe('queued');
    const cancelled = await driveOrchestrationTo(ws, run.json().orchestration.id, 'cancelled');
    expect(cancelled.error).toBe('KILL_SWITCH_ACTIVE');
  });

  it('approves a waiting task through the API', async () => {
    const email = `ora-${Date.now()}@x.com`;
    const slug = `ora-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'ORA', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const run = await app.inject({ method: 'POST', url: '/api/orchestrations', headers: { cookie, 'x-workspace-id': ws }, payload: { goal: 'approval test' } });
    expect(run.statusCode).toBe(201);
    const orchestration = await driveOrchestrationTo(ws, run.json().orchestration.id, 'waiting_for_approval');
    const waiting = (orchestration.tasks || []).find((task: any) => task.status === 'waiting_for_approval');
    expect(waiting).toBeTruthy();
    const invalid = await app.inject({ method: 'POST', url: `/api/orchestrations/${orchestration.id}/tasks/${waiting.id}/approve`, headers: { cookie, 'x-workspace-id': ws }, payload: {} });
    expect(invalid.statusCode).toBe(400);
    const approved = await app.inject({ method: 'POST', url: `/api/orchestrations/${orchestration.id}/tasks/${waiting.id}/approve`, headers: { cookie, 'x-workspace-id': ws }, payload: { status: 'approved', reason: 'test' } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().orchestration.status).toBe('waiting_for_approval');
    await driveOrchestrationTo(ws, orchestration.id, 'succeeded');
    await withWorkspaceTransaction(ws, (tx: any) => tx.job.deleteMany({ where: { workspaceId: ws } }));
    await withWorkspaceTransaction(ws, (tx) => tx.orchestrationRun.deleteMany({ where: { workspaceId: ws } }));
  });

  it('persists department data', async () => {
    const email = `ord-${Date.now()}@x.com`;
    const slug = `ord-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'ORD', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const res = await app.inject({ method: 'GET', url: '/api/departments', headers: { cookie, 'x-workspace-id': ws } });
    expect(res.statusCode).toBe(200);
    expect(res.json().departments.length).toBe(9);
  });
});

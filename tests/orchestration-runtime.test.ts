import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('orchestration runtime integration', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('idempotent duplicate returns same run', async () => {
    const email = `id-${Date.now()}@x.com`;
    const slug = `id-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'ID', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const a = await app.inject({ method: 'POST', url: '/api/orchestrations', headers: { cookie, 'x-workspace-id': ws, 'x-idempotency-key': 'idem-1' }, payload: { goal: 'x', maxConcurrency: 2, budgetUnits: 100 } });
    const b = await app.inject({ method: 'POST', url: '/api/orchestrations', headers: { cookie, 'x-workspace-id': ws, 'x-idempotency-key': 'idem-1' }, payload: { goal: 'x', maxConcurrency: 2, budgetUnits: 100 } });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().orchestration.id).toBe(b.json().orchestration.id);
  });

  it('idempotent conflicting payload returns 409', async () => {
    const email = `idf-${Date.now()}@x.com`;
    const slug = `idf-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'IDF', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    await app.inject({ method: 'POST', url: '/api/orchestrations', headers: { cookie, 'x-workspace-id': ws, 'x-idempotency-key': 'idem-2' }, payload: { goal: 'x', maxConcurrency: 2, budgetUnits: 100 } });
    const b = await app.inject({ method: 'POST', url: '/api/orchestrations', headers: { cookie, 'x-workspace-id': ws, 'x-idempotency-key': 'idem-2' }, payload: { goal: 'y', maxConcurrency: 2, budgetUnits: 100 } });
    expect(b.statusCode).toBe(409);
  });

  it('idempotency is isolated across workspaces', async () => {
    const emailA = `ida-${Date.now()}@x.com`;
    const slugA = `ida-${Date.now()}`;
    const rA = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: emailA, password: 'password1234', workspaceName: 'IDA', workspaceSlug: slugA } });
    const wsA = rA.json().workspace.id;
    const emailB = `idb-${Date.now()}@x.com`;
    const slugB = `idb-${Date.now()}`;
    const rB = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: emailB, password: 'password1234', workspaceName: 'IDB', workspaceSlug: slugB } });
    const wsB = rB.json().workspace.id;
    const loginA = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: emailA, password: 'password1234' } });
    const cookieA = loginA.headers['set-cookie'];
    const loginB = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: emailB, password: 'password1234' } });
    const cookieB = loginB.headers['set-cookie'];
    const a = await app.inject({ method: 'POST', url: '/api/orchestrations', headers: { cookie: cookieA, 'x-workspace-id': wsA, 'x-idempotency-key': 'same-key' }, payload: { goal: 'goal-a', maxConcurrency: 2, budgetUnits: 100 } });
    const b = await app.inject({ method: 'POST', url: '/api/orchestrations', headers: { cookie: cookieB, 'x-workspace-id': wsB, 'x-idempotency-key': 'same-key' }, payload: { goal: 'goal-b', maxConcurrency: 2, budgetUnits: 100 } });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().orchestration.id).not.toBe(b.json().orchestration.id);
    expect(a.json().orchestration.goal).toBe('goal-a');
    expect(b.json().orchestration.goal).toBe('goal-b');
  });
});

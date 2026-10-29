import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('orchestration recovery', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('cancels a queued orchestration run', async () => {
    const email = `cancel-${Date.now()}@x.com`;
    const slug = `cancel-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'CAN', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const run = await app.inject({ method: 'POST', url: '/api/orchestrations', headers: { cookie, 'x-workspace-id': ws, 'x-idempotency-key': 'cancel-1' }, payload: { goal: 'cancel me' } });
    const id = run.json().orchestration.id;
    const canceled = await app.inject({ method: 'POST', url: `/api/orchestrations/${id}/cancel`, headers: { cookie, 'x-workspace-id': ws } });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().orchestration.status).toBe('cancelled');
    const again = await app.inject({ method: 'POST', url: `/api/orchestrations/${id}/cancel`, headers: { cookie, 'x-workspace-id': ws } });
    expect(again.statusCode).toBe(200);
    expect(again.json().orchestration.status).toBe('cancelled');
  });

  it('defers federation access derived from workflow inputs', async () => {
    const email = `acc-${Date.now()}@x.com`;
    const slug = `acc-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'ACC', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const se = await app.inject({ method: 'POST', url: '/api/departments/seed', headers: { cookie, 'x-workspace-id': ws } });
    expect(se.statusCode).toBe(201);
  });
});

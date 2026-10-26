import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('operations', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('records policy and lifecycle event, summary', async () => {
    const email = `op-${Date.now()}@x.com`;
    const slug = `op-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'OP', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const p = await app.inject({ method: 'POST', url: '/api/policies', headers: { cookie, 'x-workspace-id': ws }, payload: { key: 'maxCost', value: { amount: 100 } } });
    expect(p.statusCode).toBe(201);
    const e = await app.inject({ method: 'POST', url: '/api/lifecycle-events', headers: { cookie, 'x-workspace-id': ws }, payload: { entityType: 'content', entityId: 'c1', toStatus: 'approved' } });
    expect(e.statusCode).toBe(201);
    const s = await app.inject({ method: 'GET', url: '/api/operations/summary', headers: { cookie, 'x-workspace-id': ws } });
    expect(s.statusCode).toBe(200);
    expect(s.json().summary).toHaveProperty('pendingApprovals');
  });
});

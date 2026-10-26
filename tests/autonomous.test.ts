import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('autonomous', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('creates approval and decides', async () => {
    const email = `au-${Date.now()}@x.com`;
    const slug = `au-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'AU', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const a = await app.inject({ method: 'POST', url: '/api/approvals', headers: { cookie, 'x-workspace-id': ws }, payload: { entityType: 'content', entityId: '123' } });
    expect(a.statusCode).toBe(201);
    const d = await app.inject({ method: 'POST', url: `/api/approvals/${a.json().approval.id}/decide`, headers: { cookie, 'x-workspace-id': ws }, payload: { status: 'approved' } });
    expect(d.statusCode).toBe(200);
    expect(d.json().approval.status).toBe('approved');
  });

  it('orchestrator summary', async () => {
    const email = `au2-${Date.now()}@x.com`;
    const slug = `au2-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'AU2', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const s = await app.inject({ method: 'GET', url: '/api/orchestrator/summary', headers: { cookie, 'x-workspace-id': ws } });
    expect(s.statusCode).toBe(200);
    expect(s.json().summary).toHaveProperty('pendingApprovals');
  });
});

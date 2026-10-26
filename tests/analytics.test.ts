import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('analytics', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('records snapshot and returns summary', async () => {
    const email = `an-${Date.now()}@x.com`;
    const slug = `an-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'AN', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const snap = await app.inject({ method: 'POST', url: '/api/analytics/snapshots', headers: { cookie, 'x-workspace-id': ws }, payload: { metric: 'views', value: 100 } });
    expect(snap.statusCode).toBe(201);
    const summary = await app.inject({ method: 'GET', url: '/api/analytics/summary', headers: { cookie, 'x-workspace-id': ws } });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().summary.metrics.views).toBe(100);
  });

  it('idempotent click', async () => {
    const email = `an2-${Date.now()}@x.com`;
    const slug = `an2-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'AN2', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const key = `k-${Date.now()}`;
    const c1 = await app.inject({ method: 'POST', url: '/api/analytics/clicks', headers: { cookie, 'x-workspace-id': ws }, payload: { idempotencyKey: key } });
    const c2 = await app.inject({ method: 'POST', url: '/api/analytics/clicks', headers: { cookie, 'x-workspace-id': ws }, payload: { idempotencyKey: key } });
    expect(c1.json().click.id).toBe(c2.json().click.id);
  });
});

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('security', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('kill switch activate/deactivate + events', async () => {
    const email = `sec-${Date.now()}@x.com`;
    const slug = `sec-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'SEC', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const act = await app.inject({ method: 'POST', url: '/api/security/kill-switch/activate', headers: { cookie, 'x-workspace-id': ws }, payload: { reason: 'test' } });
    expect(act.statusCode).toBe(200);
    const st = await app.inject({ method: 'GET', url: '/api/security/kill-switch', headers: { cookie, 'x-workspace-id': ws } });
    expect(st.json().active).toBe(true);
    const de = await app.inject({ method: 'POST', url: '/api/security/kill-switch/deactivate', headers: { cookie, 'x-workspace-id': ws } });
    expect(de.statusCode).toBe(200);
    const ev = await app.inject({ method: 'GET', url: '/api/security/events', headers: { cookie, 'x-workspace-id': ws } });
    expect(ev.json().events.length).toBeGreaterThan(0);
  });
});

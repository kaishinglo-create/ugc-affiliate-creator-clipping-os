import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('reliability', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('creates and resolves incident', async () => {
    const email = `rel-${Date.now()}@x.com`;
    const slug = `rel-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'REL', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const c = await app.inject({ method: 'POST', url: '/api/incidents', headers: { cookie, 'x-workspace-id': ws }, payload: { title: 'DB timeout', severity: 'high' } });
    expect(c.statusCode).toBe(201);
    const res = await app.inject({ method: 'POST', url: `/api/incidents/${c.json().incident.id}/resolve`, headers: { cookie, 'x-workspace-id': ws }, payload: { details: 'fixed' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().incident.status).toBe('resolved');
  });
});

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('release verification', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('records checks and computes decision', async () => {
    const email = `rel-${Date.now()}@x.com`;
    const slug = `rel-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'REL', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    await app.inject({ method: 'POST', url: '/api/release-checks', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'build', status: 'passed' } });
    const d = await app.inject({ method: 'GET', url: '/api/release-decision', headers: { cookie, 'x-workspace-id': ws } });
    expect(d.statusCode).toBe(200);
    expect(d.json().decision).toBe('GO');
  });
});

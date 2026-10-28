import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('items pagination', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('rejects invalid limit/offset', async () => {
    const email = `it-${Date.now()}@x.com`;
    const slug = `it-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'IT', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const bad1 = await app.inject({ method: 'GET', url: '/api/items?limit=abc', headers: { cookie, 'x-workspace-id': ws } });
    expect(bad1.statusCode).toBe(400);
    const bad2 = await app.inject({ method: 'GET', url: '/api/items?offset=-1', headers: { cookie, 'x-workspace-id': ws } });
    expect(bad2.statusCode).toBe(400);
    const ok = await app.inject({ method: 'GET', url: '/api/items?limit=10&offset=0', headers: { cookie, 'x-workspace-id': ws } });
    expect(ok.statusCode).toBe(200);
  });
});

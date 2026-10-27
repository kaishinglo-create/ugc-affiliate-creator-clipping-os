import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('install', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('records install check', async () => {
    const email = `in-${Date.now()}@x.com`;
    const slug = `in-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'IN', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const c = await app.inject({ method: 'POST', url: '/api/install-checks', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'db', status: 'passed' } });
    expect(c.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/api/install-checks', headers: { cookie, 'x-workspace-id': ws } });
    expect(list.json().checks.length).toBe(1);
  });
});

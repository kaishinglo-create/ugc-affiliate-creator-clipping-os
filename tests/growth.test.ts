import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('growth engine', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('creates experiment and insight', async () => {
    const email = `g-${Date.now()}@x.com`;
    const slug = `g-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'G', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const e = await app.inject({ method: 'POST', url: '/api/experiments', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Hook test', hypothesis: 'Shorter hooks improve retention' } });
    expect(e.statusCode).toBe(201);
    const i = await app.inject({ method: 'POST', url: '/api/insights', headers: { cookie, 'x-workspace-id': ws }, payload: { title: 'Hook pattern', body: 'Short hooks performed better', confidence: 0.7 } });
    expect(i.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/api/insights', headers: { cookie, 'x-workspace-id': ws } });
    expect(list.json().insights.length).toBe(1);
  });
});

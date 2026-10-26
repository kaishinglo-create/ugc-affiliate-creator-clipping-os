import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('business hub', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('creates brand, creator, campaign, task', async () => {
    const email = `bh-${Date.now()}@x.com`;
    const slug = `bh-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'BH', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const b = await app.inject({ method: 'POST', url: '/api/brands', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Brand1' } });
    expect(b.statusCode).toBe(201);
    const c = await app.inject({ method: 'POST', url: '/api/creators', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Creator1' } });
    expect(c.statusCode).toBe(201);
    const camp = await app.inject({ method: 'POST', url: '/api/campaigns', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Camp1', brandId: b.json().brand.id } });
    expect(camp.statusCode).toBe(201);
    const t = await app.inject({ method: 'POST', url: '/api/tasks', headers: { cookie, 'x-workspace-id': ws }, payload: { title: 'Task1', campaignId: camp.json().campaign.id } });
    expect(t.statusCode).toBe(201);
  });
});

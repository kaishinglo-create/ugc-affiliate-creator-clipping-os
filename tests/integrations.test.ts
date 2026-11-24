import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('integrations', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('lists providers', async () => {
    const email = `int-${Date.now()}@x.com`;
    const slug = `int-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'INT', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const list = await app.inject({ method: 'GET', url: '/api/integrations', headers: { cookie, 'x-workspace-id': ws } });
    expect(list.statusCode).toBe(200);
    expect(list.json().integrations.length).toBe(4);
  });

  it('configure provider stores status without key', async () => {
    const email = `int2-${Date.now()}@x.com`;
    const slug = `int2-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'INT2', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const cfg = await app.inject({ method: 'POST', url: '/api/integrations/klap', headers: { cookie, 'x-workspace-id': ws }, payload: { apiKey: 'secret' } });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json().integration.status).toBe('CREDENTIALS_ONLY');
    expect(cfg.json().integration.liveAdapter).toBe(false);
    expect(JSON.stringify(cfg.json().integration.config)).not.toContain('secret');
  });

  it('reports stored credentials without claiming a live adapter', async () => {
    const email = `int3-${Date.now()}@x.com`;
    const slug = `int3-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'INT3', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    await app.inject({ method: 'POST', url: '/api/integrations/klap', headers: { cookie, 'x-workspace-id': ws }, payload: { apiKey: 'secret' } });
    const list = await app.inject({ method: 'GET', url: '/api/integrations', headers: { cookie, 'x-workspace-id': ws } });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.integrations).toHaveLength(4);
    expect(body.integrations.every((i: any) => i.liveAdapter === false)).toBe(true);
    expect(body.integrations.every((i: any) => ['NOT_CONFIGURED', 'CREDENTIALS_ONLY'].includes(i.status))).toBe(true);
    expect(body.integrations.find((i: any) => i.provider === 'klap').status).toBe('CREDENTIALS_ONLY');
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});

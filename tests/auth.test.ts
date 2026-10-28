import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('auth + workspace isolation', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('signup creates user + workspace', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/signup',
      payload: { email: `u-${Date.now()}@x.com`, password: 'password1234', workspaceName: 'WS', workspaceSlug: `ws-${Date.now()}` },
    });
    expect(res.statusCode).toBe(201);
  });

  it('login + me + logout', async () => {
    const email = `u2-${Date.now()}@x.com`;
    const slug = `ws2-${Date.now()}`;
    await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'WS2', workspaceSlug: slug } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().workspaces.length).toBe(1);
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    const me2 = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me2.statusCode).toBe(401);
  });

  it('items isolated by workspace', async () => {
    const emailA = `a-${Date.now()}@x.com`;
    const emailB = `b-${Date.now()}@x.com`;
    const slugA = `wsa-${Date.now()}`;
    const slugB = `wsb-${Date.now()}`;
    const rA = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: emailA, password: 'password1234', workspaceName: 'WA', workspaceSlug: slugA } });
    const rB = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: emailB, password: 'password1234', workspaceName: 'WB', workspaceSlug: slugB } });
    const wsA = rA.json().workspace.id;
    const _wsB = rB.json().workspace.id;
    const loginA = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: emailA, password: 'password1234' } });
    const cookieA = loginA.headers['set-cookie'];
    await app.inject({ method: 'POST', url: '/api/items', headers: { cookie: cookieA, 'x-workspace-id': wsA }, payload: { title: 'itemA' } });
    // B tries to read A's workspace -> forbidden
    const loginB = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: emailB, password: 'password1234' } });
    const cookieB = loginB.headers['set-cookie'];
    const resB = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: cookieB, 'x-workspace-id': wsA } });
    expect(resB.statusCode).toBe(403);
  });
});

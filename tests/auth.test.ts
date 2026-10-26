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

  it('login + me', async () => {
    const email = `u2-${Date.now()}@x.com`;
    const slug = `ws2-${Date.now()}`;
    await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'WS2', workspaceSlug: slug } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().workspaces.length).toBe(1);
  });
});

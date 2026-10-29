import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';

describe('input validation', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });

  it('rejects signup with invalid email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'not-an-email', password: 'password1234', workspaceName: 'WS', workspaceSlug: 'ws-valid' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'INVALID_INPUT' });
  });

  it('rejects signup with short password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: `v-${Date.now()}@x.com`, password: 'short', workspaceName: 'WS', workspaceSlug: `v-${Date.now()}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'INVALID_INPUT' });
  });

  it('rejects login with invalid email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'not-an-email', password: 'password1234' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'INVALID_INPUT' });
  });
});

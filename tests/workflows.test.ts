import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('workflows', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('create and run workflow', async () => {
    const email = `wf-${Date.now()}@x.com`;
    const slug = `wf-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'WF', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const def = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Echo flow', steps: [{ name: 'step1', action: 'echo' }] } });
    expect(def.statusCode).toBe(201);
    const run = await app.inject({ method: 'POST', url: `/api/workflows/${def.json().workflow.id}/run`, headers: { cookie, 'x-workspace-id': ws }, payload: { input: { hello: 'world' } } });
    expect(run.statusCode).toBe(200);
    expect(run.json().run.status).toBe('succeeded');
  });

  it('idempotency returns same run', async () => {
    const email = `wf2-${Date.now()}@x.com`;
    const slug = `wf2-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'WF2', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const def = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Echo flow2', steps: [{ name: 'step1', action: 'echo' }] } });
    const key = `key-${Date.now()}`;
    const run1 = await app.inject({ method: 'POST', url: `/api/workflows/${def.json().workflow.id}/run`, headers: { cookie, 'x-workspace-id': ws }, payload: { input: { a: 1 }, idempotencyKey: key } });
    const run2 = await app.inject({ method: 'POST', url: `/api/workflows/${def.json().workflow.id}/run`, headers: { cookie, 'x-workspace-id': ws }, payload: { input: { a: 1 }, idempotencyKey: key } });
    expect(run1.json().run.id).toBe(run2.json().run.id);
  });
});

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('multi-agent', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('registers agent and runs task', async () => {
    const email = `ma-${Date.now()}@x.com`;
    const slug = `ma-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'MA', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const a = await app.inject({ method: 'POST', url: '/api/agents', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Research', role: 'research', capabilities: ['search'] } });
    expect(a.statusCode).toBe(201);
    const t = await app.inject({ method: 'POST', url: '/api/agent-tasks', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'task1', agentId: a.json().agent.id, input: { q: 'test' } } });
    expect(t.statusCode).toBe(201);
    const run = await app.inject({ method: 'POST', url: `/api/agent-tasks/${t.json().task.id}/run`, headers: { cookie, 'x-workspace-id': ws } });
    expect(run.statusCode).toBe(200);
    expect(run.json().task.status).toBe('completed');
  });
});

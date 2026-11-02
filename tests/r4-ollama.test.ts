import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';

vi.mock('../src/ollama.js', () => ({ ollamaChat: vi.fn(async () => ({ model: 'test-model', content: 'hello' })) }));

describe('R4 gap Ollama controls', () => {
  let app: any;
  let workspaceA: any, workspaceB: any, cookieA: any, cookieB: any;
  const originalKey = process.env.OLLAMA_API_KEY;
  const originalBudget = process.env.OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE;

  beforeAll(async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    process.env.OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE = '1';
    app = await buildServer();

    const make = async () => {
      const email = `r4-${Date.now()}@x.com`;
      const slug = `r4-${Date.now()}`;
      const response = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'R4', workspaceSlug: slug } });
      const ws = response.json().workspace.id;
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
      const cookie = login.headers['set-cookie'];
      return { ws, cookie };
    };

    const a = await make();
    workspaceA = a.ws;
    cookieA = a.cookie;
    const b = await make();
    workspaceB = b.ws;
    cookieB = b.cookie;
  });

  beforeEach(async () => {
    await withWorkspaceTransaction(workspaceA, (tx: any) => tx.auditEvent.deleteMany({ where: { workspaceId: workspaceA } }));
    await withWorkspaceTransaction(workspaceB, (tx: any) => tx.auditEvent.deleteMany({ where: { workspaceId: workspaceB } }));
  });

  afterAll(async () => {
    if (originalKey === undefined) delete process.env.OLLAMA_API_KEY; else process.env.OLLAMA_API_KEY = originalKey;
    if (originalBudget === undefined) delete process.env.OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE; else process.env.OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE = originalBudget;
    await app.close();
    await prisma.$disconnect();
  });

  it('rejects when workspace kill switch active', async () => {
    await app.inject({ method: 'POST', url: '/api/security/kill-switch/activate', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: { reason: 'r4' } });
    const res = await app.inject({ method: 'POST', url: '/api/ollama/chat', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: { prompt: 'kill-switch-prompt' } });
    expect(res.statusCode).toBe(423);
    await app.inject({ method: 'POST', url: '/api/security/kill-switch/deactivate', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: {} });
  });

  it('allows one request then blocks the next (budget cap 1)', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/ollama/chat', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: { prompt: 'alpha' } });
    const second = await app.inject({ method: 'POST', url: '/api/ollama/chat', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: { prompt: 'beta' } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toBe('OLLAMA_BUDGET_EXCEEDED');

    const events: any[] = await withWorkspaceTransaction(workspaceA, (tx: any) => tx.auditEvent.findMany({ where: { workspaceId: workspaceA, type: 'ollama_request' }, orderBy: { createdAt: 'asc' } }));
    expect(events).toHaveLength(2);
    const successful = events.find((event) => event.data?.outcome === 'success');
    expect(successful).toBeTruthy();
    expect(JSON.stringify(successful.data)).not.toContain('alpha');
    expect(successful.data).not.toHaveProperty('prompt');
    expect(successful.data).not.toHaveProperty('body');
  });

  it('enforces budget isolation between workspaces', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/ollama/chat', headers: { cookie: cookieB, 'x-workspace-id': workspaceB }, payload: { prompt: 'gamma' } });
    expect(first.statusCode).toBe(200);
    const events = await withWorkspaceTransaction(workspaceB, (tx: any) => tx.auditEvent.count({ where: { workspaceId: workspaceB, type: 'ollama_request' } }));
    expect(events).toBe(1);
  });
});
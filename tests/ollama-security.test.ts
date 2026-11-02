import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

vi.mock('../src/ollama.js', () => ({
  ollamaChat: vi.fn(async () => ({ model: 'test-model', content: 'hello' })),
}));

describe('ollama security', () => {
  let app: any;
  let workspace: string;
  let cookie: string;
  const originalKey = process.env.OLLAMA_API_KEY;

  beforeAll(async () => {
    app = await buildServer();
    const email = `ollama-${Date.now()}@x.com`;
    const slug = `ollama-${Date.now()}`;
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'OLLAMA', workspaceSlug: slug } });
    workspace = res.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    cookie = login.headers['set-cookie'];
  });

  afterAll(async () => {
    if (originalKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalKey;
    await app.close();
    await prisma.$disconnect();
  });

  it('returns 401 without session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ollama/chat', headers: { 'x-workspace-id': workspace }, payload: { prompt: 'hi' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('NOT_AUTHENTICATED');
  });

  it('returns 400 without workspace context', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ollama/chat', headers: { cookie }, payload: { prompt: 'hi' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('WORKSPACE_ID_REQUIRED');
  });

  it('rejects non-string prompt without coercion', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ollama/chat', headers: { cookie, 'x-workspace-id': workspace }, payload: { prompt: { nested: 'value' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_INPUT');
  });

  it('rejects missing prompt', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ollama/chat', headers: { cookie, 'x-workspace-id': workspace }, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 when not configured', async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    const { ollamaChat } = await import('../src/ollama.js');
    (ollamaChat as any).mockRejectedValueOnce(new Error('OLLAMA_NOT_CONFIGURED'));
    const res = await app.inject({ method: 'POST', url: '/api/ollama/chat', headers: { cookie, 'x-workspace-id': workspace }, payload: { prompt: 'hi' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('OLLAMA_NOT_CONFIGURED');
  });

  it('returns 504 on timeout', async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    const { ollamaChat } = await import('../src/ollama.js');
    (ollamaChat as any).mockRejectedValueOnce(new Error('OLLAMA_TIMEOUT'));
    const res = await app.inject({ method: 'POST', url: '/api/ollama/chat', headers: { cookie, 'x-workspace-id': workspace }, payload: { prompt: 'hi' } });
    expect(res.statusCode).toBe(504);
    expect(res.json().error).toBe('OLLAMA_TIMEOUT');
  });

  it('does not leak upstream error details', async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    const { ollamaChat } = await import('../src/ollama.js');
    (ollamaChat as any).mockRejectedValueOnce(new Error('OLLAMA_HTTP_402: secret upstream billing body'));
    const res = await app.inject({ method: 'POST', url: '/api/ollama/chat', headers: { cookie, 'x-workspace-id': workspace }, payload: { prompt: 'hi' } });
    expect(res.statusCode).toBe(402);
    const bodyText = res.body;
    expect(bodyText).not.toContain('secret upstream billing body');
    expect(res.json().message).not.toContain('secret');
  });

  it('successful path returns sanitized model response', async () => {
    process.env.OLLAMA_API_KEY = 'test-key';
    const { ollamaChat } = await import('../src/ollama.js');
    (ollamaChat as any).mockResolvedValueOnce({ model: 'test-model', content: 'hello' });
    const res = await app.inject({ method: 'POST', url: '/api/ollama/chat', headers: { cookie, 'x-workspace-id': workspace }, payload: { prompt: 'hi' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ model: 'test-model', content: 'hello' });
  });
});

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('browser gateway', () => {
  let app: any;
  let cookieA: string;
  let cookieB: string;
  let workspaceA: string;
  let workspaceB: string;
  let sessionId: string;
  let agentId: string;
  beforeAll(async () => {
    app = await buildServer();
    const emailA = `bg-a-${Date.now()}@x.com`;
    const slugA = `bg-a-${Date.now()}`;
    const resA = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: emailA, password: 'password1234', workspaceName: 'BGA', workspaceSlug: slugA } });
    workspaceA = resA.json().workspace.id;
    const loginA = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: emailA, password: 'password1234' } });
    cookieA = loginA.headers['set-cookie'];

    const emailB = `bg-b-${Date.now()}@x.com`;
    const slugB = `bg-b-${Date.now()}`;
    const resB = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: emailB, password: 'password1234', workspaceName: 'BGB', workspaceSlug: slugB } });
    workspaceB = resB.json().workspace.id;
    const loginB = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: emailB, password: 'password1234' } });
    cookieB = loginB.headers['set-cookie'];

    const agentRes = await app.inject({ method: 'POST', url: '/api/agents', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: { name: 'browser-agent', role: 'frontend-auditor', capabilities: {} } });
    agentId = agentRes.json().agent.id;

    const sessionRes = await app.inject({ method: 'POST', url: '/api/browser/sessions', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: { initialUrl: 'https://example.com' } });
    sessionId = sessionRes.json().session.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('isolates sessions by workspace', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/browser/sessions/'+sessionId, headers: { cookie: cookieB, 'x-workspace-id': workspaceB } });
    expect(res.statusCode).toBe(404);
  });

  it('blocks SSRF targets', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/browser/sessions/'+sessionId+'/navigate', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: { url: 'http://127.0.0.1/secret', actorType: 'human' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('URL_HOST_NOT_ALLOWED');
  });

  it('lists MCP tools', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/browser/mcp/tools', headers: { cookie: cookieA, 'x-workspace-id': workspaceA } });
    expect(res.statusCode).toBe(200);
    expect(res.json().tools.length).toBeGreaterThanOrEqual(17);
  });

  it('supports control request, approval, takeover and release', async () => {
    const reqRes = await app.inject({ method: 'POST', url: '/api/browser/sessions/'+sessionId+'/control/request', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: { agentId } });
    expect(reqRes.statusCode).toBe(200);
    expect(reqRes.json().session.controllerState).toBe('AGENT_REQUESTED');

    const approveRes = await app.inject({ method: 'POST', url: '/api/browser/sessions/'+sessionId+'/control/approve', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: { agentId, durationMs: 10000 } });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().session.controllerState).toBe('AGENT_CONTROL');

    const releaseRes = await app.inject({ method: 'POST', url: '/api/browser/sessions/'+sessionId+'/control/release', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: { actorId: agentId } });
    expect(releaseRes.statusCode).toBe(200);
    expect(releaseRes.json().session.controllerState).toBe('HUMAN_CONTROL');

    await app.inject({ method: 'POST', url: '/api/browser/sessions/'+sessionId+'/control/request', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: { agentId } });
    await app.inject({ method: 'POST', url: '/api/browser/sessions/'+sessionId+'/control/approve', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: { agentId, durationMs: 10000 } });
    const takeoverRes = await app.inject({ method: 'POST', url: '/api/browser/sessions/'+sessionId+'/control/takeover', headers: { cookie: cookieA, 'x-workspace-id': workspaceA }, payload: {} });
    expect(takeoverRes.statusCode).toBe(200);
    expect(takeoverRes.json().session.controllerState).toBe('HUMAN_CONTROL');
  });

  it('runtime status is honest about unavailability', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/browser/status', headers: { cookie: cookieA, 'x-workspace-id': workspaceA } });
    expect(res.statusCode).toBe(200);
    expect(res.json().runtime.available).toBe(false);
  });
});

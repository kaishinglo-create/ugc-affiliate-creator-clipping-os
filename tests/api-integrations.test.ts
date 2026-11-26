import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';
import {
  PROVIDER_DEFINITIONS,
  CONNECTION_STATUSES,
  getProviderDefinition,
} from '../src/api-integration-center/catalog.js';
import { setProbeContextOverride, classifyProviderFailure } from '../src/api-integration-center/service.js';
import { resolveMasterKey, resetMasterKeyCache } from '../src/api-integration-center/crypto.js';

async function signup(app: any, label: string, role: 'OWNER' | 'MEMBER' = 'OWNER') {
  const slug = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `${slug}@x.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email, password: 'password1234', workspaceName: label.toUpperCase(), workspaceSlug: slug },
  });
  const workspaceId = res.json().workspace.id as string;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
  const cookie = login.headers['set-cookie'];
  if (role === 'MEMBER') {
    const user = await prisma.user.findUnique({ where: { email } });
    await prisma.membership.updateMany({ where: { workspaceId, userId: user!.id }, data: { role: 'MEMBER' } });
  }
  return { workspaceId, email, cookie, headers: { cookie, 'x-workspace-id': workspaceId } };
}

async function dropWorkspace(workspaceId: string) {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
}

describe('phase F api integration center', () => {
  let app: any;
  const workspaces: string[] = [];
  const originalMasterKey = process.env.API_INTEGRATIONS_MASTER_KEY;

  beforeAll(async () => {
    app = await buildServer();
  });
  afterAll(async () => {
    setProbeContextOverride(null);
    resetMasterKeyCache();
    if (originalMasterKey === undefined) delete process.env.API_INTEGRATIONS_MASTER_KEY;
    else process.env.API_INTEGRATIONS_MASTER_KEY = originalMasterKey;
    for (const id of workspaces) await dropWorkspace(id);
    await app.close();
    await prisma.$disconnect();
  });
  beforeEach(() => {
    setProbeContextOverride({
      fetchImpl: (async (input: any, _init: any) => {
        const url = String(input);
        if (url.includes('/oauth/token')) {
          return new Response(JSON.stringify({ access_token: 'probe-access', refresh_token: 'probe-refresh', expires_in: 3600, scope: 'read' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ items: [], rows: [], models: [], data: { user: { open_id: 'probe-user' } }, id: 'probe-id' }), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '42' } });
      }) as typeof fetch,
      sleep: async () => undefined,
      now: new Date('2026-11-26T12:00:00.000Z'),
      freeModelsFile: new URL('../scripts/free-models.json', import.meta.url).pathname,
    } as any);
  });
  afterEach(() => setProbeContextOverride(null));

  it('publishes a complete official provider registry with no fake CONNECTED state', async () => {
    const ws = await signup(app, 'aic-registry');
    workspaces.push(ws.workspaceId);
    const res = await app.inject({ method: 'GET', url: '/api/api-integrations', headers: ws.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.providers.map((p: any) => p.key)).toEqual(PROVIDER_DEFINITIONS.map((p) => p.key));
    expect(body.providers.length).toBeGreaterThanOrEqual(14);
    expect(body.credentialStoreAvailable).toBe(true);
    for (const provider of body.providers) {
      expect(CONNECTION_STATUSES).toContain(provider.connection.status);
      expect(provider.connection.status).not.toBe('CONNECTED');
      expect(provider.connection.status).not.toContain('sk-');
      expect(JSON.stringify(provider)).not.toMatch(/probe-access|probe-refresh|apiKey=|client_secret=/i);
    }
    const oauth = body.providers.find((p: any) => p.key === 'youtube_google');
    expect(oauth.oauth.pkce).toBe(false);
    expect(oauth.oauth.authorizeUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(oauth.oauth.authorizeParams.access_type).toBe('offline');
    const tiktok = body.providers.find((p: any) => p.key === 'tiktok');
    expect(tiktok.oauth.pkce).toBe(false);
    expect(tiktok.oauth.authorizeUrl).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(tiktok.oauth.clientIdParam).toBe('client_key');
    expect(tiktok.oauth.scopeSeparator).toBe(',');
    const meta = body.providers.find((p: any) => p.key === 'instagram_meta');
    expect(meta.oauth.pkce).toBe(false);
    expect(meta.manualSteps.join(' ')).toMatch(/facebook|instagram/i);
  });

  it('keeps the legacy integrations endpoint untouched', async () => {
    const ws = await signup(app, 'aic-legacy');
    workspaces.push(ws.workspaceId);
    const res = await app.inject({ method: 'GET', url: '/api/integrations', headers: ws.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().integrations).toHaveLength(4);
    expect(res.json().integrations.every((p: any) => p.liveAdapter === false)).toBe(true);
  });

  it('sets CONNECTED only after a real probe succeeds and records quota/audit history', async () => {
    const ws = await signup(app, 'aic-probe');
    workspaces.push(ws.workspaceId);
    const saved = await app.inject({
      method: 'POST',
      url: '/api/api-integrations/ollama_cloud/credentials',
      headers: ws.headers,
      payload: { apiKey: 'sk-integration-regression-value' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().connection.status).toBe('CONFIGURED');
    expect(JSON.stringify(saved.body)).not.toContain('sk-integration-regression-value');

    const tested = await app.inject({
      method: 'POST',
      url: '/api/api-integrations/ollama_cloud/test',
      headers: ws.headers,
      payload: {},
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json().status).toBe('CONNECTED');
    const detail = await app.inject({ method: 'GET', url: '/api/api-integrations/ollama_cloud', headers: ws.headers });
    expect(detail.json().connection.status).toBe('CONNECTED');
    expect(detail.json().connection.quota.source).toBe('provider_response_headers');
    expect(detail.json().connection.quota.remaining).toBe(42);
    expect(detail.json().history.some((e: any) => e.type === 'test_succeeded')).toBe(true);
    const history = await app.inject({ method: 'GET', url: '/api/api-integrations/ollama_cloud/history', headers: ws.headers });
    expect(history.statusCode).toBe(200);
    expect(history.json().events.length).toBeGreaterThanOrEqual(2);
  });

  it('classifies upstream errors and opens a circuit breaker after repeated failures', async () => {
    expect(classifyProviderFailure({ status: 402, body: 'insufficient quota' }).status).toBe('QUOTA_EXHAUSTED');
    expect(classifyProviderFailure({ status: 403 }).status).toBe('PERMISSION_MISSING');
    expect(classifyProviderFailure({ status: 429 }).status).toBe('RATE_LIMITED');
    expect(classifyProviderFailure({ status: 500 }).status).toBe('PROVIDER_UNAVAILABLE');
    expect(classifyProviderFailure({ status: 401 }).status).toBe('TOKEN_EXPIRED');

    setProbeContextOverride({
      fetchImpl: (async () => new Response('rate limited', { status: 429 })) as typeof fetch,
      sleep: async () => undefined,
      now: new Date('2026-11-26T12:00:00.000Z'),
    } as any);
    const ws = await signup(app, 'aic-circuit');
    workspaces.push(ws.workspaceId);
    await app.inject({
      method: 'POST',
      url: '/api/api-integrations/ollama_cloud/credentials',
      headers: ws.headers,
      payload: { apiKey: 'sk-circuit-test-value' },
    });
    for (let i = 0; i < 3; i += 1) {
      const failed = await app.inject({ method: 'POST', url: '/api/api-integrations/ollama_cloud/test', headers: ws.headers, payload: {} });
      expect(failed.json().status).toBe('RATE_LIMITED');
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/api-integrations/ollama_cloud/test', headers: ws.headers, payload: {} });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('PROVIDER_COOLDOWN');
    const detail = await app.inject({ method: 'GET', url: '/api/api-integrations/ollama_cloud', headers: ws.headers });
    expect(detail.json().connection.circuitState).toBe('OPEN');
    expect(detail.json().connection.consecutiveFailures).toBeGreaterThanOrEqual(3);
  });

  it('never reports CONNECTED for unimplemented adapters or disabled providers', async () => {
    const ws = await signup(app, 'aic-adapter');
    workspaces.push(ws.workspaceId);
    const legacy = await app.inject({ method: 'POST', url: '/api/api-integrations/yaps/test', headers: ws.headers, payload: {} });
    expect(legacy.json().status).toBe('ADAPTER_NOT_IMPLEMENTED');

    await app.inject({ method: 'POST', url: '/api/api-integrations/ollama_cloud/credentials', headers: ws.headers, payload: { apiKey: 'sk-disabled-test' } });
    await app.inject({ method: 'POST', url: '/api/api-integrations/ollama_cloud/test', headers: ws.headers, payload: {} });
    const disabled = await app.inject({ method: 'PATCH', url: '/api/api-integrations/ollama_cloud', headers: ws.headers, payload: { enabled: false } });
    expect(disabled.json().connection.status).toBe('DISABLED');
    const tested = await app.inject({ method: 'POST', url: '/api/api-integrations/ollama_cloud/test', headers: ws.headers, payload: {} });
    expect(tested.json().status).toBe('DISABLED');
  });

  it('enforces operator role and rejects missing fields', async () => {
    const owner = await signup(app, 'aic-role-owner');
    const member = await signup(app, 'aic-role-member');
    workspaces.push(owner.workspaceId, member.workspaceId);
    await prisma.membership.create({ data: { userId: (await prisma.user.findUnique({ where: { email: member.email } }))!.id, workspaceId: owner.workspaceId, role: 'MEMBER' } });
    const memberHeaders = { cookie: member.cookie, 'x-workspace-id': owner.workspaceId };
    expect((await app.inject({ method: 'POST', url: '/api/api-integrations/ollama_cloud/credentials', headers: memberHeaders, payload: { apiKey: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/api-integrations/ollama_cloud/test', headers: memberHeaders, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/api-integrations/ollama_cloud', headers: memberHeaders })).statusCode).toBe(403);
    const ownerHeaders = owner.headers;
    expect((await app.inject({ method: 'POST', url: '/api/api-integrations/ollama_cloud/credentials', headers: ownerHeaders, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/api-integrations/ollama_cloud', headers: ownerHeaders, payload: { enabled: 'yes' } })).statusCode).toBe(400);
  });

  it('fails closed when the credential master key is missing', async () => {
    const ws = await signup(app, 'aic-nokey');
    workspaces.push(ws.workspaceId);
    delete process.env.API_INTEGRATIONS_MASTER_KEY;
    delete process.env.API_INTEGRATIONS_MASTER_KEY_FILE;
    resetMasterKeyCache();
    expect(resolveMasterKey()).toBeNull();
    const res = await app.inject({
      method: 'POST',
      url: '/api/api-integrations/ollama_cloud/credentials',
      headers: ws.headers,
      payload: { apiKey: 'sk-fail-closed' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('CREDENTIAL_STORE_NOT_CONFIGURED');
  });

  it('validates provider definitions and official endpoints', () => {
    for (const def of PROVIDER_DEFINITIONS) {
      expect(getProviderDefinition(def.key)).toBe(def);
      expect(def.manualSteps.length).toBeGreaterThan(0);
      expect(def.freeTier.length).toBeGreaterThan(0);
      if (def.liveAdapter) {
        expect(def.officialEndpoints.length).toBeGreaterThan(0);
        expect(def.adapterNote.length).toBeGreaterThan(0);
      }
    }
  });
});

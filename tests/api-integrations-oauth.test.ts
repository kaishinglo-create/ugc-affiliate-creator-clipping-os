import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { setProbeContextOverride } from '../src/api-integration-center/service.js';

async function signup(app: any, label: string) {
  const slug = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `${slug}@x.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email, password: 'password1234', workspaceName: label.toUpperCase(), workspaceSlug: slug },
  });
  const workspaceId = res.json().workspace.id as string;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
  return { workspaceId, email, cookie: login.headers['set-cookie'], headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId } };
}

describe('phase F oauth lifecycle security', () => {
  let app: any;
  const workspaces: string[] = [];
  const originalBaseUrl = process.env.API_INTEGRATIONS_OAUTH_BASE_URL;
  let tokenCalls: Array<{ url: string; init: any }> = [];

  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => {
    setProbeContextOverride(null);
    if (originalBaseUrl === undefined) delete process.env.API_INTEGRATIONS_OAUTH_BASE_URL;
    else process.env.API_INTEGRATIONS_OAUTH_BASE_URL = originalBaseUrl;
    for (const id of workspaces) await prisma.workspace.deleteMany({ where: { id } });
    await app.close();
    await prisma.$disconnect();
  });
  beforeEach(() => {
    tokenCalls = [];
    delete process.env.API_INTEGRATIONS_OAUTH_BASE_URL;
    setProbeContextOverride({
      fetchImpl: (async (input: any, init: any) => {
        const url = String(input);
        if (url.includes('/token')) tokenCalls.push({ url, init });
        return new Response(JSON.stringify({ access_token: 'oauth-secret-value', refresh_token: 'oauth-refresh-value', expires_in: 3600, scope: 'youtube.readonly' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
      sleep: async () => undefined,
    } as any);
  });
  afterEach(() => {
    setProbeContextOverride(null);
    delete process.env.API_INTEGRATIONS_OAUTH_BASE_URL;
  });

  async function saveCredentials(ws: any, provider: string, payload: Record<string, string>) {
    const saved = await app.inject({
      method: 'POST',
      url: `/api/api-integrations/${provider}/credentials`,
      headers: ws.headers,
      payload,
    });
    expect(saved.statusCode).toBe(200);
  }

  async function prepare(ws: any) {
    await saveCredentials(ws, 'youtube_google', { clientId: 'client-regression-id', clientSecret: 'client-regression-secret' });
  }

  function cookiePair(setCookie: any): string {
    const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
    return raw.split(';')[0];
  }

  it('starts OAuth with state, an absolute registered redirect and an HttpOnly cookie', async () => {
    const ws = await signup(app, 'oauth-start');
    workspaces.push(ws.workspaceId);
    await prepare(ws);
    const res = await app.inject({
      method: 'GET',
      url: '/api/api-integrations/oauth/youtube_google/start?redirectUri=https%3A%2F%2Fevil.example%2Fcatch',
      headers: ws.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const url = new URL(body.authorizationUrl);
    expect(url.searchParams.get('state')).toBe(body.state);
    expect(url.searchParams.get('client_id')).toBe('client-regression-id');
    expect(url.searchParams.get('access_type')).toBe('offline');
    // Documented Google web-server flow uses state + confidential client, not PKCE.
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(body.redirectUri).toMatch(/^http:\/\/localhost(?::\d+)?\/api\/api-integrations\/oauth\/youtube_google\/callback$/);
    expect(url.searchParams.get('redirect_uri')).toBe(body.redirectUri);
    expect(url.searchParams.get('redirect_uri')).not.toContain('evil.example');
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(JSON.stringify(body)).not.toContain('client-regression-secret');
  });

  it('uses a configured absolute base URL and rejects untrusted request origins', async () => {
    const ws = await signup(app, 'oauth-origin');
    workspaces.push(ws.workspaceId);
    await prepare(ws);

    process.env.API_INTEGRATIONS_OAUTH_BASE_URL = 'https://ugc.example.com';
    const configured = await app.inject({ method: 'GET', url: '/api/api-integrations/oauth/youtube_google/start', headers: ws.headers });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().redirectUri).toBe('https://ugc.example.com/api/api-integrations/oauth/youtube_google/callback');

    delete process.env.API_INTEGRATIONS_OAUTH_BASE_URL;
    const injected = await app.inject({ method: 'GET', url: '/api/api-integrations/oauth/youtube_google/start', headers: { ...ws.headers, host: 'evil.example' } });
    expect(injected.statusCode).toBe(503);
    expect(injected.json().error).toBe('INVALID_OAUTH_REDIRECT_BASE_URL');
  });

  it('rejects wrong state, missing cookie and cross-provider callbacks without consuming state', async () => {
    const ws = await signup(app, 'oauth-state');
    workspaces.push(ws.workspaceId);
    await prepare(ws);
    const started = await app.inject({ method: 'GET', url: '/api/api-integrations/oauth/youtube_google/start', headers: ws.headers });
    const { state } = started.json();
    const oauthCookie = cookiePair(started.headers['set-cookie']);

    const wrongState = await app.inject({
      method: 'GET',
      url: `/api/api-integrations/oauth/youtube_google/callback?workspaceId=${ws.workspaceId}&state=not-the-state&code=auth-code`,
      headers: { cookie: `${cookiePair(ws.cookie)}; ${oauthCookie}`, 'x-workspace-id': ws.workspaceId },
    });
    expect(wrongState.statusCode).toBe(403);
    expect(wrongState.json().error).toBe('INVALID_OAUTH_STATE');

    const noCookie = await app.inject({
      method: 'GET',
      url: `/api/api-integrations/oauth/youtube_google/callback?state=${state}&code=auth-code`,
      headers: { cookie: ws.cookie, 'x-workspace-id': ws.workspaceId },
    });
    expect(noCookie.statusCode).toBe(403);
    expect(noCookie.json().error).toBe('OAUTH_COOKIE_MISMATCH');

    const tamperedCookie = oauthCookie.replace(/.$/, (last) => (last === 'A' ? 'B' : 'A'));
    const tampered = await app.inject({
      method: 'GET',
      url: `/api/api-integrations/oauth/youtube_google/callback?state=${state}&code=auth-code`,
      headers: { cookie: `${cookiePair(ws.cookie)}; ${tamperedCookie}`, 'x-workspace-id': ws.workspaceId },
    });
    expect(tampered.statusCode).toBe(403);
    expect(tampered.json().error).toBe('OAUTH_COOKIE_MISMATCH');
    expect(tokenCalls).toHaveLength(0);

    const wrongProvider = await app.inject({
      method: 'GET',
      url: `/api/api-integrations/oauth/tiktok/callback?state=${state}&code=auth-code`,
      headers: { cookie: `${cookiePair(ws.cookie)}; ${oauthCookie}`, 'x-workspace-id': ws.workspaceId },
    });
    expect(wrongProvider.statusCode).toBe(403);
    expect(wrongProvider.json().error).toBe('INVALID_OAUTH_STATE');
    expect(JSON.stringify(wrongProvider.body)).not.toContain('oauth-secret-value');

    const rows = await withWorkspaceTransaction(ws.workspaceId, (tx: any) => tx.oAuthAuthorization.findMany({ where: { workspaceId: ws.workspaceId, providerKey: 'youtube_google' } })) as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.consumedAt === null)).toBe(true);
  });

  it('completes a real-provider-style callback without a workspace query and refreshes tokens securely', async () => {
    const ws = await signup(app, 'oauth-valid');
    workspaces.push(ws.workspaceId);
    await prepare(ws);
    const started = await app.inject({ method: 'GET', url: '/api/api-integrations/oauth/youtube_google/start', headers: ws.headers });
    const { state, redirectUri } = started.json();
    expect(redirectUri).toContain('/api/api-integrations/oauth/youtube_google/callback');
    const callback = await app.inject({
      method: 'GET',
      url: `/api/api-integrations/oauth/youtube_google/callback?state=${state}&code=valid-auth-code`,
      headers: { cookie: `${cookiePair(ws.cookie)}; ${cookiePair(started.headers['set-cookie'])}` },
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.json().status).toBe('CONFIGURED');
    expect(JSON.stringify(callback.body)).not.toContain('oauth-secret-value');
    expect(JSON.stringify(callback.body)).not.toContain('oauth-refresh-value');
    expect(tokenCalls).toHaveLength(1);
    expect(String(tokenCalls[0].init.body)).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);

    const detail = await app.inject({ method: 'GET', url: '/api/api-integrations/youtube_google', headers: ws.headers });
    expect(detail.json().connection.tokenExpiresAt).toBeTruthy();
    expect(JSON.stringify(detail.body)).not.toContain('oauth-secret-value');

    const consumed = await app.inject({
      method: 'GET',
      url: `/api/api-integrations/oauth/youtube_google/callback?state=${state}&code=valid-auth-code`,
      headers: { cookie: `${cookiePair(ws.cookie)}; ${cookiePair(started.headers['set-cookie'])}` },
    });
    expect(consumed.statusCode).toBe(403);
    expect(consumed.json().error).toBe('INVALID_OAUTH_STATE');

    const refresh = await app.inject({ method: 'POST', url: '/api/api-integrations/youtube_google/refresh', headers: ws.headers, payload: {} });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().status).toBe('CONFIGURED');
    expect(JSON.stringify(refresh.body)).not.toContain('oauth-secret-value');
  });

  it('uses the documented TikTok web parameters and tokens never appear in responses', async () => {
    const ws = await signup(app, 'oauth-tiktok-web');
    workspaces.push(ws.workspaceId);
    await saveCredentials(ws, 'tiktok', { clientKey: 'client-key-regression', clientSecret: 'client-secret-regression' });
    const started = await app.inject({ method: 'GET', url: '/api/api-integrations/oauth/tiktok/start', headers: ws.headers });
    expect(started.statusCode).toBe(200);
    const { state, redirectUri, authorizationUrl } = started.json();
    const authorize = new URL(authorizationUrl);
    expect(authorize.origin + authorize.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(authorize.searchParams.get('client_key')).toBe('client-key-regression');
    expect(authorize.searchParams.get('client_id')).toBeNull();
    expect(authorize.searchParams.get('scope')).toBe('user.info.basic,video.publish');
    expect(authorize.searchParams.get('code_challenge')).toBeNull();
    expect(authorize.searchParams.get('redirect_uri')).toBe(redirectUri);

    const callback = await app.inject({
      method: 'GET',
      url: `/api/api-integrations/oauth/tiktok/callback?state=${state}&code=tiktok-code`,
      headers: { cookie: `${cookiePair(ws.cookie)}; ${cookiePair(started.headers['set-cookie'])}` },
    });
    expect(callback.statusCode).toBe(200);
    expect(tokenCalls).toHaveLength(1);
    const tokenBody = String(tokenCalls[0].init.body);
    expect(tokenBody).toContain('client_key=client-key-regression');
    expect(tokenBody).toContain('client_secret=client-secret-regression');
    expect(tokenBody).not.toContain('client_id=');
    expect(JSON.stringify(callback.body)).not.toContain('oauth-secret-value');
    expect(JSON.stringify(callback.body)).not.toContain('client-secret-regression');
  });

  it('rejects OAuth start/callback for foreign workspace and missing credentials', async () => {
    const owner = await signup(app, 'oauth-foreign-owner');
    const other = await signup(app, 'oauth-foreign-other');
    workspaces.push(owner.workspaceId, other.workspaceId);
    const start = await app.inject({ method: 'GET', url: '/api/api-integrations/oauth/youtube_google/start', headers: { cookie: other.cookie, 'x-workspace-id': owner.workspaceId } });
    expect(start.statusCode).toBe(403);
    const callback = await app.inject({
      method: 'GET',
      url: `/api/api-integrations/oauth/youtube_google/callback?workspaceId=${owner.workspaceId}&state=x&code=y`,
      headers: { cookie: other.cookie },
    });
    expect(callback.statusCode).toBe(403);

    const noClient = await app.inject({ method: 'GET', url: '/api/api-integrations/oauth/tiktok/start', headers: owner.headers });
    expect(noClient.statusCode).toBe(502);
    expect(noClient.json().error).toBe('OAUTH_CLIENT_ID_REQUIRED');
    const unsupported = await app.inject({ method: 'GET', url: '/api/api-integrations/oauth/yaps/start', headers: owner.headers });
    expect(unsupported.statusCode).toBe(400);
  });
});

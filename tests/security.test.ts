import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../lib/db.js';

describe('security', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('kill switch activate/deactivate + events', async () => {
    const email = `sec-${Date.now()}@x.com`;
    const slug = `sec-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'SEC', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const act = await app.inject({ method: 'POST', url: '/api/security/kill-switch/activate', headers: { cookie, 'x-workspace-id': ws }, payload: { reason: 'test' } });
    expect(act.statusCode).toBe(200);
    const st = await app.inject({ method: 'GET', url: '/api/security/kill-switch', headers: { cookie, 'x-workspace-id': ws } });
    expect(st.json().active).toBe(true);
    const de = await app.inject({ method: 'POST', url: '/api/security/kill-switch/deactivate', headers: { cookie, 'x-workspace-id': ws } });
    expect(de.statusCode).toBe(200);
    const ev = await app.inject({ method: 'GET', url: '/api/security/events', headers: { cookie, 'x-workspace-id': ws } });
    expect(ev.json().events.length).toBeGreaterThan(0);
  });

  it('serves restrictive content security policy', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(String(csp)).toContain("default-src 'self'");
    expect(String(csp)).toContain("script-src 'self'");
    expect(String(csp)).toContain("style-src 'self'");
    expect(String(csp)).toContain("object-src 'none'");
    expect(String(csp)).toContain("base-uri 'self'");
    expect(String(csp)).toContain("frame-ancestors 'none'");
    expect(String(csp)).not.toContain('unsafe-inline');
  });

  it('rejects production start without valid jwt secret', () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/ugc_os_ci');
    vi.stubEnv('SESSION_JWT_SECRET', '');
    expect(() => loadConfig()).toThrow(/SESSION_JWT_SECRET/);
    vi.stubEnv('SESSION_JWT_SECRET', 'shortsecret');
    expect(() => loadConfig()).toThrow(/SESSION_JWT_SECRET/);
  });

  it('rejects production start without database url', () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('SESSION_JWT_SECRET', 'a'.repeat(40));
    expect(() => loadConfig()).toThrow(/DATABASE_URL/);
  });

  it('starts production with valid configuration', () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/ugc_os_ci');
    vi.stubEnv('SESSION_JWT_SECRET', 'a'.repeat(40));
    const cfg = loadConfig();
    expect(cfg.appEnv).toBe('production');
    expect(cfg.databaseUrl).toContain('postgresql://');
    expect(cfg.sessionSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('uses dev fallback only outside production', () => {
    vi.stubEnv('APP_ENV', 'development');
    vi.stubEnv('SESSION_JWT_SECRET', '');
    const cfg = loadConfig();
    expect(cfg.sessionSecret.length).toBeGreaterThanOrEqual(32);
  });
});

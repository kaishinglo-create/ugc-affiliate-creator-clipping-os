import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';

async function signup(app: any, label: string) {
  const slug = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `${slug}@x.com`;
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: label.toUpperCase(), workspaceSlug: slug } });
  const workspaceId = res.json().workspace.id as string;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
  return { workspaceId, email, headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId } };
}

describe('phase F api integration workspace isolation and RLS', () => {
  let app: any;
  let a: any;
  let b: any;

  beforeAll(async () => {
    app = await buildServer();
    a = await signup(app, 'aic-iso-a');
    b = await signup(app, 'aic-iso-b');
    await app.inject({ method: 'POST', url: '/api/api-integrations/ollama_cloud/credentials', headers: a.headers, payload: { apiKey: 'sk-workspace-a-secret' } });
  });
  afterAll(async () => {
    await app.close();
    await prisma.workspace.deleteMany({ where: { id: { in: [a.workspaceId, b.workspaceId] } } });
    await prisma.$disconnect();
  });

  it('rejects foreign workspace header and cross-workspace provider access', async () => {
    const foreign = await app.inject({ method: 'GET', url: '/api/api-integrations', headers: { cookie: b.headers.cookie, 'x-workspace-id': a.workspaceId } });
    expect(foreign.statusCode).toBe(403);
    const detail = await app.inject({ method: 'GET', url: '/api/api-integrations/ollama_cloud', headers: b.headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().connection.credentialHint).toBeNull();
    expect(detail.json().connection.credentialSource).toBe('environment');
    const history = await app.inject({ method: 'GET', url: '/api/api-integrations/ollama_cloud/history', headers: b.headers });
    expect(history.json().events.some((e: any) => e.actor && String(e.actor).includes(a.workspaceId))).toBe(false);
  });

  it('RLS hides workspace A rows under workspace B transaction', async () => {
    const rows = await withWorkspaceTransaction(b.workspaceId, async (tx: any) => ({
      credentials: await tx.apiCredential.findMany(),
      connections: await tx.apiConnection.findMany(),
      events: await tx.apiIntegrationEvent.findMany(),
      oauth: await tx.oAuthAuthorization.findMany(),
    }));
    expect(rows.credentials).toHaveLength(0);
    expect(rows.connections.every((row: any) => row.workspaceId === b.workspaceId)).toBe(true);
    expect(rows.events.every((row: any) => row.workspaceId === b.workspaceId)).toBe(true);
    expect(rows.oauth).toHaveLength(0);

    const own = await withWorkspaceTransaction(a.workspaceId, async (tx: any) => tx.apiCredential.findMany());
    expect(own).toHaveLength(1);
    expect(own[0].workspaceId).toBe(a.workspaceId);
  });

  it('RLS prevents direct cross-workspace writes for non-superuser roles', async () => {
    const roles: any[] = await prisma.$queryRawUnsafe("select rolsuper from pg_roles where rolname = current_user");
    // Local dev uses a superuser that bypasses FORCE RLS; CI/qa:full uses the
    // non-superuser ugc_os_app role where this assertion is meaningful.
    if (roles[0]?.rolsuper === true) return;
    await expect(withWorkspaceTransaction(b.workspaceId, async (tx: any) => tx.apiConnection.create({
      data: { workspaceId: a.workspaceId, providerKey: 'tiktok', status: 'CONNECTED' },
    }))).rejects.toThrow();
  });
});

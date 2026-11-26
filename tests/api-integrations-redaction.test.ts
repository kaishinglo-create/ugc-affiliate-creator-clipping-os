import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { decryptCredential, encryptCredential } from '../src/api-integration-center/crypto.js';
import { setProbeContextOverride } from '../src/api-integration-center/service.js';
import { redactData, redactText } from '../lib/redaction.js';

async function signup(app: any, label: string) {
  const slug = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `${slug}@x.com`;
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: label.toUpperCase(), workspaceSlug: slug } });
  const workspaceId = res.json().workspace.id as string;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
  return { workspaceId, headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId } };
}

describe('phase F credential redaction and encryption', () => {
  let app: any;
  const workspaces: string[] = [];

  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => {
    setProbeContextOverride(null);
    for (const id of workspaces) await prisma.workspace.deleteMany({ where: { id } });
    await app.close();
    await prisma.$disconnect();
  });
  beforeEach(() => setProbeContextOverride({
    fetchImpl: (async () => new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
    sleep: async () => undefined,
  } as any));
  afterEach(() => setProbeContextOverride(null));

  it('encrypts payloads with workspace/provider AAD and rejects tampering or context reuse', () => {
    const secret = 'super-secret-token-value-1234567890';
    const encrypted = encryptCredential({ apiKey: secret }, 'workspace-a', 'ollama_cloud');
    expect(encrypted.ciphertext).not.toContain(secret);
    expect(encrypted.iv).not.toContain(secret);
    expect(decryptCredential(encrypted, 'workspace-a', 'ollama_cloud')).toEqual({ apiKey: secret });
    expect(() => decryptCredential(encrypted, 'workspace-b', 'ollama_cloud')).toThrow('CREDENTIAL_DECRYPT_FAILED');
    expect(() => decryptCredential(encrypted, 'workspace-a', 'tiktok')).toThrow('CREDENTIAL_DECRYPT_FAILED');
    expect(() => decryptCredential({ ...encrypted, tag: encrypted.tag.slice(0, -4) + 'AAAA' }, 'workspace-a', 'ollama_cloud')).toThrow('CREDENTIAL_DECRYPT_FAILED');
    expect(encrypted.hint).toMatch(/^sha256:[a-f0-9]{12}$/);
  });

  it('never returns or audits a stored secret through any API surface', async () => {
    const ws = await signup(app, 'redaction-ws');
    workspaces.push(ws.workspaceId);
    const secret = 'sk-very-sensitive-regression-secret';
    const saved = await app.inject({
      method: 'POST',
      url: '/api/api-integrations/ollama_cloud/credentials',
      headers: ws.headers,
      payload: { apiKey: secret },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(secret);

    const stored = await withWorkspaceTransaction(ws.workspaceId, (tx: any) => tx.apiCredential.findUnique({ where: { workspaceId_providerKey: { workspaceId: ws.workspaceId, providerKey: 'ollama_cloud' } } })) as any;
    expect(stored.ciphertext).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(secret);

    await app.inject({ method: 'POST', url: '/api/api-integrations/ollama_cloud/test', headers: ws.headers, payload: {} });
    for (const url of ['/api/api-integrations', '/api/api-integrations/ollama_cloud', '/api/api-integrations/ollama_cloud/history', '/api/api-integrations/health']) {
      const res = await app.inject({ method: 'GET', url, headers: ws.headers });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(secret);
      expect(res.body).not.toContain('Bearer');
    }
    const audits = await withWorkspaceTransaction(ws.workspaceId, (tx: any) => tx.auditEvent.findMany({ where: { workspaceId: ws.workspaceId } }));
    expect(JSON.stringify(audits)).not.toContain(secret);
    const events = await withWorkspaceTransaction(ws.workspaceId, (tx: any) => tx.apiIntegrationEvent.findMany({ where: { workspaceId: ws.workspaceId } }));
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('redacts credentials embedded in error messages and nested payloads', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature-value';
    const text = redactText(`Authorization: Bearer ${jwt} failed for api_key=sk-secret-1234`);
    expect(text).not.toContain('sk-secret-1234');
    expect(text).not.toContain(jwt);
    const nested = redactData({ message: 'token=secret-value-9876', nested: { password: 'hunter2', safe: 'ok' } });
    expect(JSON.stringify(nested)).not.toContain('secret-value-9876');
    expect(JSON.stringify(nested)).not.toContain('hunter2');
    expect((nested as any).nested.safe).toBe('ok');
  });

  it('disconnect removes stored credential and resets connection', async () => {
    const ws = await signup(app, 'redaction-disconnect');
    workspaces.push(ws.workspaceId);
    await app.inject({ method: 'POST', url: '/api/api-integrations/ollama_cloud/credentials', headers: ws.headers, payload: { apiKey: 'sk-to-be-removed' } });
    const removed = await app.inject({ method: 'DELETE', url: '/api/api-integrations/ollama_cloud', headers: ws.headers });
    expect(removed.json().connection.status).toBe('NOT_CONFIGURED');
    const stored = await withWorkspaceTransaction(ws.workspaceId, (tx: any) => tx.apiCredential.findMany({ where: { workspaceId: ws.workspaceId } }));
    expect(stored).toHaveLength(0);
  });
});

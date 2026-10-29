import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../lib/audit.js', () => ({ writeAuditEvent: vi.fn(async () => { throw new Error('AUDIT_WRITE_FAILED'); }) }));

import { buildServer } from '../src/index.js';
import { executeRun } from '../src/workflows.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';

describe('security audit fail-closed', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('does not execute workflow when audit write fails', async () => {
    const email = `afc-${Date.now()}@x.com`;
    const slug = `afc-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'AFC', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const def = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'AuditFail flow', steps: [{ name: 'step1', action: 'echo' }] } });
    const run: any = await withWorkspaceTransaction(ws, (tx) => tx.workflowRun.create({ data: { workspaceId: ws, definitionId: def.json().workflow.id, status: 'queued', input: {}, startedAt: new Date() } }));
    await expect(executeRun(ws, run.id)).rejects.toThrow('AUDIT_WRITE_FAILED');
    const updated: any = await withWorkspaceTransaction(ws, (tx) => tx.workflowRun.findUnique({ where: { id: run.id } }));
    expect(updated?.status).toBe('queued');
  });
});

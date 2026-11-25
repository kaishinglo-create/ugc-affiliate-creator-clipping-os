import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { writeAuditEvent } from '../lib/audit.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';

describe('self-healing proposals API', () => {
  let app: any;

  beforeAll(async () => { app = await buildServer(); }, 180_000);
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  async function signupSession(label: string) {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const email = `${label}-${suffix}@x.test`;
    const workspaceSlug = `${label}-${suffix}`;
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email, password: 'password1234', workspaceName: label, workspaceSlug },
    });
    expect(signup.statusCode).toBe(201);
    const workspaceId = signup.json().workspace.id as string;
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'password1234' },
    });
    expect(login.statusCode).toBe(200);
    return {
      workspaceId,
      headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId },
    };
  }

  it('returns read-only proposals from real audit rows and never marks them applied', async () => {
    const ctx = await signupSession('selfheal');
    await withWorkspaceTransaction(ctx.workspaceId, async (tx: any) => {
      for (let index = 0; index < 2; index += 1) {
        await writeAuditEvent({
          workspaceId: ctx.workspaceId,
          type: 'publishing_attempt_failed',
          actor: 'self-healing-api-test',
          data: { code: 'NOT_CONFIGURED', platform: 'youtube', index },
          tx,
        });
      }
    });

    const unauth = await app.inject({ method: 'GET', url: '/api/self-healing/proposals' });
    expect(unauth.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: '/api/self-healing/proposals?windowMs=3600000',
      headers: ctx.headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.applied).toBe(false);
    expect(body.report.workspaceId).toBe(ctx.workspaceId);
    expect(body.report.eventsExamined).toBeGreaterThanOrEqual(2);
    expect(body.report.proposals.every((proposal: any) => proposal.applied === false)).toBe(true);

    const external = body.report.proposals.find((proposal: any) => proposal.rule === 'external_setup_required');
    expect(external).toBeDefined();
    expect(external.action).toBeNull();
    expect(external.classification.category).toBe('configuration');
    expect(external.classification.requiresExternalSetup).toBe(true);
    expect(external.classification.manualApproval).toBe(true);

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/self-healing/proposals?limit=0',
      headers: ctx.headers,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('INVALID_LIMIT');
  });
});

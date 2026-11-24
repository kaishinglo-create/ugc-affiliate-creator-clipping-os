import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { claimDueJobs, completeJob, createJob, getJob, markWaitingForApproval } from '../src/jobs.js';

async function signup(app: any, prefix: string) {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@x.com`;
  const slug = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: prefix.toUpperCase(), workspaceSlug: slug } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
  return { email, workspaceId: r.json().workspace.id, cookie: login.headers['set-cookie'] };
}

describe('job approval bypass regression', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('cannot complete a job waiting for approval, and resumes only through the approval decision', async () => {
    const owner = await signup(app, 'apr');
    const headers = { cookie: owner.cookie, 'x-workspace-id': owner.workspaceId };

    const definition = await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.workflowDefinition.create({ data: { workspaceId: owner.workspaceId, name: 'Approval gate', steps: [{ name: 'gate', action: 'notify' }] } })
    ) as any;
    const run = await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.workflowRun.create({ data: { workspaceId: owner.workspaceId, definitionId: definition.id, status: 'queued', input: {} } })
    ) as any;
    const created = await createJob({
      workspaceId: owner.workspaceId,
      type: 'WORKFLOW_RUN',
      category: 'workflow',
      payload: {},
      workflowRunId: run.id,
      idempotencyKey: `apr-job-${Date.now()}`,
    });
    const [claimed] = await claimDueJobs(owner.workspaceId, 'worker-1', { leaseTtlMs: 60000 });
    expect(claimed.id).toBe(created.id);
    const waiting = await markWaitingForApproval(created.id, { workspaceId: owner.workspaceId, leaseId: claimed.leaseId, workerId: 'worker-1' });
    expect(waiting.status).toBe('WAITING_FOR_APPROVAL');

    // A helper caller cannot mark a gated job succeeded directly.
    const direct = await completeJob(created.id, { workspaceId: owner.workspaceId });
    expect(direct.status).toBe('WAITING_FOR_APPROVAL');

    // An operator cannot use the raw completion route to skip the gate either.
    const forced = await app.inject({ method: 'POST', url: `/api/jobs/${created.id}/complete`, headers, payload: {} });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().job.status).toBe('WAITING_FOR_APPROVAL');

    // A plain member cannot use operator-only job routes at all.
    const member = await signup(app, 'aprmember');
    const memberUser = await prisma.user.findUnique({ where: { email: member.email } });
    await prisma.membership.create({ data: { userId: String(memberUser?.id), workspaceId: owner.workspaceId, role: 'MEMBER' } });
    const memberHeaders = { cookie: member.cookie, 'x-workspace-id': owner.workspaceId };
    const memberCreate = await app.inject({ method: 'POST', url: '/api/jobs', headers: memberHeaders, payload: { type: 'WORKFLOW_RUN' } });
    expect(memberCreate.statusCode).toBe(403);
    const memberComplete = await app.inject({ method: 'POST', url: `/api/jobs/${created.id}/complete`, headers: memberHeaders, payload: {} });
    expect(memberComplete.statusCode).toBe(403);
    const memberResume = await app.inject({ method: 'POST', url: `/api/jobs/${created.id}/resume`, headers: memberHeaders, payload: {} });
    expect(memberResume.statusCode).toBe(403);
    expect((await getJob(created.id, owner.workspaceId)).status).toBe('WAITING_FOR_APPROVAL');

    // The approved decision releases the gate to QUEUED, never to SUCCEEDED.
    const approval = await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.approval.create({ data: { workspaceId: owner.workspaceId, entityType: 'workflow_step', entityId: `${run.id}#0`, requestedBy: null } })
    ) as any;
    const decided = await app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/decide`, headers, payload: { status: 'approved', reason: 'regression' } });
    expect(decided.statusCode).toBe(200);
    expect((await getJob(created.id, owner.workspaceId)).status).toBe('QUEUED');
  });
});

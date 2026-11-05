import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { isKillSwitchActive } from '../lib/security.js';
import { ACTION_REGISTRY, createDefinition, startRun } from '../src/workflows.js';
import { runEngineTick } from '../src/engine.js';

/**
 * Phase 22 regression tests. Each test below reproduces a defect that was
 * confirmed on the autonomous engine / approval / kill-switch surface.
 */

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
  return { workspaceId, email, cookie: login.headers['set-cookie'] };
}

async function dropWorkspace(workspaceId: string) {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
}

function readSource(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(rel);
    return entry.name.endsWith('.ts') ? [rel] : [];
  });
}

describe('phase 22 engine hardening', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('does not let a plain member run the scheduler', async () => {
    const owner = await signup(app, 'hg-role');
    const member = await signup(app, 'hg-member');
    const memberUser = await prisma.user.findUnique({ where: { email: member.email } });
    await prisma.membership.create({ data: { userId: String(memberUser?.id), workspaceId: owner.workspaceId, role: 'MEMBER' } });

    const memberHeaders = { cookie: member.cookie, 'x-workspace-id': owner.workspaceId };
    const memberScheduler = await app.inject({ method: 'POST', url: '/api/scheduler/run', headers: memberHeaders, payload: {} });
    expect(memberScheduler.statusCode).toBe(403);
    const memberJobsScheduler = await app.inject({ method: 'POST', url: '/api/jobs/scheduler/run', headers: memberHeaders, payload: {} });
    expect(memberJobsScheduler.statusCode).toBe(403);
    const memberTick = await app.inject({ method: 'POST', url: '/api/engine/tick', headers: memberHeaders, payload: {} });
    expect(memberTick.statusCode).toBe(403);

    const ownerScheduler = await app.inject({ method: 'POST', url: '/api/scheduler/run', headers: { cookie: owner.cookie, 'x-workspace-id': owner.workspaceId }, payload: {} });
    expect(ownerScheduler.statusCode).toBe(200);

    await dropWorkspace(owner.workspaceId);
    await dropWorkspace(member.workspaceId);
  });

  it('rejects an invalid tick timestamp instead of silently ignoring it', async () => {
    const { workspaceId, cookie } = await signup(app, 'hg-now');
    const res = await app.inject({
      method: 'POST',
      url: '/api/engine/tick',
      headers: { cookie, 'x-workspace-id': workspaceId },
      payload: { now: 'not-a-date' },
    });
    expect(res.statusCode).toBe(400);
    await dropWorkspace(workspaceId);
  });

  it('reads the kill switch through a workspace-scoped client only', async () => {
    const { workspaceId } = await signup(app, 'hg-killscope');
    await withWorkspaceTransaction(workspaceId, (tx: any) =>
      tx.killSwitch.create({ data: { workspaceId, active: true, reason: 'test', activatedBy: 'test', activatedAt: new Date() } })
    );

    // RLS protects KillSwitch, so an unscoped client cannot see the row at all.
    const scoped = await withWorkspaceTransaction(workspaceId, (tx: any) => isKillSwitchActive(workspaceId, tx));
    expect(scoped).toBe(true);

    // Every call site must therefore pass a workspace-scoped transaction.
    const offenders: string[] = [];
    for (const file of [...sourceFiles('src'), ...sourceFiles('lib')]) {
      const source = readSource(file);
      for (const match of source.matchAll(/isKillSwitchActive\(\s*([^)]*)\)/g)) {
        const args = match[1].split(',');
        if (args.length < 2) offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);

    await dropWorkspace(workspaceId);
  });

  it('stops a workflow run when the kill switch is activated mid-execution', async () => {
    const { workspaceId } = await signup(app, 'hg-midkill');
    let armed = true;
    ACTION_REGISTRY['__test_activate_kill_switch'] = async () => {
      if (!armed) return { armed: false };
      armed = false;
      await withWorkspaceTransaction(workspaceId, (tx: any) =>
        tx.killSwitch.upsert({
          where: { workspaceId },
          create: { workspaceId, active: true, reason: 'mid-run', activatedBy: 'test', activatedAt: new Date() },
          update: { active: true, reason: 'mid-run', activatedBy: 'test', activatedAt: new Date() },
        })
      );
      return { armed: true };
    };

    try {
      const def = await createDefinition(workspaceId, 'mid kill', [
        { name: 'arm', action: '__test_activate_kill_switch' },
        { name: 'after', action: 'echo' },
      ]);
      const run = await startRun(workspaceId, def.id, { hello: 'midkill' });

      await runEngineTick({ workspaceId, workerId: 'hardening-test' });

      const finished: any = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.workflowRun.findUnique({ where: { id: run.id } }));
      expect(finished?.status).toBe('cancelled');
      expect(finished?.error).toBe('KILL_SWITCH_ACTIVE');
      const steps: any[] = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.workflowStepRun.findMany({ where: { runId: run.id } }));
      expect(steps.map((step: any) => step.name)).toEqual(['arm']);
      const job: any = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.job.findFirst({ where: { workspaceId, workflowRunId: run.id } }));
      expect(job?.status).toBe('CANCELLED');
    } finally {
      delete ACTION_REGISTRY['__test_activate_kill_switch'];
      await dropWorkspace(workspaceId);
    }
  });

  it('decides an approval once and never flips a rejection into an approval', async () => {
    const { workspaceId, cookie } = await signup(app, 'hg-decide');
    const headers = { cookie, 'x-workspace-id': workspaceId };
    const created = await app.inject({ method: 'POST', url: '/api/approvals', headers, payload: { entityType: 'publish_clip', entityId: 'clip-1' } });
    const approvalId = created.json().approval.id;

    const rejected = await app.inject({ method: 'POST', url: `/api/approvals/${approvalId}/decide`, headers, payload: { status: 'rejected', reason: 'not now' } });
    expect(rejected.statusCode).toBe(200);

    const flip = await app.inject({ method: 'POST', url: `/api/approvals/${approvalId}/decide`, headers, payload: { status: 'approved' } });
    expect(flip.statusCode).toBe(409);

    const stored: any = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.approval.findUnique({ where: { id: approvalId } }));
    expect(stored?.status).toBe('rejected');
    await dropWorkspace(workspaceId);
  });

  it('resumes the orchestration run after its approval is granted on the approvals API', async () => {
    const { workspaceId, cookie } = await signup(app, 'hg-orch-approve');
    const headers = { cookie, 'x-workspace-id': workspaceId };

    const created = await app.inject({ method: 'POST', url: '/api/orchestrations', headers, payload: { goal: 'ship a clipping campaign' } });
    expect(created.statusCode).toBe(201);
    const orchestration = created.json().orchestration;
    expect(orchestration.status).toBe('waiting_for_approval');
    const waiting = (orchestration.tasks ?? []).find((task: any) => task.status === 'waiting_for_approval');
    expect(waiting?.approvalId).toBeTruthy();

    const decided = await app.inject({ method: 'POST', url: `/api/approvals/${waiting.approvalId}/decide`, headers, payload: { status: 'approved', reason: 'go' } });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().resumed).toBeTruthy();

    // Nothing drives the run inside the request anymore: the engine must pick it up.
    await runEngineTick({ workspaceId, workerId: 'hardening-test', resumeOrchestrations: true });

    let run: any = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      run = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.orchestrationRun.findUnique({ where: { id: orchestration.id }, include: { tasks: true } }));
      if (run?.status === 'succeeded' || run?.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (attempt % 5 === 4) await runEngineTick({ workspaceId, workerId: 'hardening-test', resumeOrchestrations: true });
    }
    expect(run?.status).toBe('succeeded');
    await dropWorkspace(workspaceId);
  });
});

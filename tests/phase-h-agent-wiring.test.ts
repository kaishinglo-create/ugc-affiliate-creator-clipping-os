import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { driveOrchestrationTo } from './helpers/orchestration-engine.js';
import { phaseHAgentContext } from '../src/phase-h-agent-context.js';
import { runAgentTask } from '../src/ai/agent-runtime.js';

const workspaceIds: string[] = [];
let app: any;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (app) await app.close();
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.$disconnect();
});

async function workspace() {
  const suffix = randomUUID();
  const email = `h5wire-${suffix}@x.com`;
  const signup = await app.inject({
    method: 'POST', url: '/api/auth/signup',
    payload: { email, password: 'password1234', workspaceName: 'H5 wiring', workspaceSlug: `h5wire-${suffix}` },
  });
  expect(signup.statusCode).toBe(201);
  const workspaceId = signup.json().workspace.id;
  workspaceIds.push(workspaceId);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
  return { workspaceId, headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId } };
}

describe('Phase H agent workflow wiring', () => {
  it('uses persisted workspace data in REAL orchestration task outputs', async () => {
    app = await buildServer();
    const { workspaceId, headers } = await workspace();
    await app.inject({ method: 'POST', url: '/api/departments/seed', headers, payload: {} });
    await app.inject({
      method: 'POST', url: '/api/publishing/accounts', headers,
      payload: { platform: 'youtube', accountKey: 'yt-live-agent', displayName: 'Agent account' },
    });
    await app.inject({
      method: 'POST', url: '/api/affiliate/links', headers,
      payload: { token: 'agent-link', offerId: 'agent-offer', destinationUrl: 'https://example.test/agent' },
    });
    const created = await app.inject({
      method: 'POST', url: '/api/orchestrations', headers,
      payload: { goal: 'Publish and measure a creator clip' },
    });
    expect(created.statusCode).toBe(201);
    const run = created.json().orchestration;
    const waitingRun = await driveOrchestrationTo(workspaceId, run.id, 'waiting_for_approval');
    const waitingTask = (waitingRun.tasks || []).find((task: any) => task.status === 'waiting_for_approval');
    expect(waitingTask).toBeTruthy();
    const approved = await app.inject({
      method: 'POST',
      url: `/api/orchestrations/${run.id}/tasks/${waitingTask.id}/approve`,
      headers,
      payload: { status: 'approved', reason: 'phase H wiring test' },
    });
    expect(approved.statusCode).toBe(200);
    await driveOrchestrationTo(workspaceId, run.id, 'succeeded');

    const tasks: any[] = await withWorkspaceTransaction<any[]>(workspaceId, (tx: any) =>
      tx.orchestrationTask.findMany({ where: { runId: run.id } }));
    const succeeded = tasks.filter((task) => task.status === 'succeeded');
    expect(succeeded.length).toBeGreaterThan(0);
    // Every succeeded department task must carry live workspace context.
    for (const task of succeeded) {
      const output = task.output as any;
      expect(output?.contextSource).toBe('workspace_rows');
      expect(output?.externalLiveVerified).toBe(false);
    }
    const publishing = succeeded.find((task) => task.departmentKey === 'publishing');
    expect(publishing).toBeTruthy();
    expect(Number((publishing!.output as any).publishingAccounts)).toBeGreaterThanOrEqual(1);
    const growth = succeeded.find((task) => task.departmentKey === 'growth');
    expect(growth).toBeTruthy();
    expect(Number((growth!.output as any).affiliateLinks)).toBeGreaterThanOrEqual(1);
  });

  it('feeds all eight logical roles through the agent runtime', async () => {
    vi.stubEnv('AGENT_AI_MODE', 'off');
    const { workspaceId } = await workspace();
    for (const role of ['publishing', 'affiliate', 'analytics', 'api_integration', 'research', 'security', 'ceo', 'coo']) {
      const output: any = await runAgentTask({
        workspaceId,
        departmentKey: role === 'coo' ? 'strategy' : role === 'api_integration' ? 'strategy' : role === 'affiliate' ? 'growth' : role,
        action: 'plan',
        goal: 'phase h wiring check',
        timeoutMs: 5_000,
        deterministic: () => phaseHAgentContext(workspaceId, role),
      });
      expect(output._meta.source).toBe('deterministic_planner');
      expect(output.contextSource).toBe('workspace_rows');
      expect(output.externalLiveVerified).toBe(false);
    }
  });
});

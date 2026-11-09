import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { enqueueDiscovery, enqueueDueDiscovery, getDiscoverySchedule, listDiscoveryCandidates, setDiscoverySchedule } from '../src/discovery.js';
import { runEngineTick } from '../src/engine.js';

it('queues discovery, keeps candidates workspace-scoped, and distinguishes provider failures', async () => {
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'ugc-discovery-test-'));
  try {
    for (const id of [workspaceId, otherWorkspaceId]) {
      await prisma.workspace.create({ data: { id, name: 'Discovery test', slug: id } });
    }
    const client = join(directory, 'client.mjs');
    await writeFile(client, `console.log(JSON.stringify(process.argv[2] === 'blocked'
      ? { ok: false, class: 'blocked' }
      : { ok: true, tier: 1, candidates: process.argv[2] === 'empty'
        ? [] : [{ id: 'abc123xyz01', title: 'A video' }] }));`);
    vi.stubEnv('DISCOVERY_MCP_CLIENT', client);

    const queued = await enqueueDiscovery(workspaceId, { query: 'search' });
    expect(queued.status).toBe('QUEUED');
    expect((await enqueueDiscovery(workspaceId, { query: 'search' })).id).toBe(queued.id);
    await enqueueDiscovery(workspaceId, { query: 'duplicate video' });
    const empty = await enqueueDiscovery(workspaceId, { query: 'empty' });
    const blocked = await enqueueDiscovery(workspaceId, { query: 'blocked' });

    const firstTick = await runEngineTick({ workspaceId, batchSize: 10, concurrency: 1 });
    expect(firstTick.jobs).toContainEqual(expect.objectContaining({ id: queued.id, outcome: 'succeeded' }));
    const candidates = await listDiscoveryCandidates(workspaceId);
    expect(candidates).toEqual([expect.objectContaining({ externalId: 'abc123xyz01', title: 'A video' })]);
    expect(await listDiscoveryCandidates(otherWorkspaceId)).toEqual([]);
    const jobs: any[] = await withWorkspaceTransaction(workspaceId, (tx) => tx.job.findMany({ where: { workspaceId } }));
    expect(jobs.find((job) => job.id === empty.id)?.status).toBe('SUCCEEDED');
    expect(jobs.find((job) => job.id === blocked.id)?.lastError).toBe('DISCOVERY_PROVIDER_BLOCKED');

    await withWorkspaceTransaction(workspaceId, (tx) => tx.auditEvent.createMany({
      data: Array.from({ length: 10 }, () => ({ workspaceId, type: 'content_discovery_request_reserved' })),
    }));
    const limited = await enqueueDiscovery(workspaceId, { query: 'over budget' });
    const tick = await runEngineTick({ workspaceId });
    expect(tick.jobs).toContainEqual(expect.objectContaining({ id: limited.id, outcome: 'failed', error: 'DISCOVERY_DAILY_BUDGET_EXCEEDED' }));
  } finally {
    vi.unstubAllEnvs();
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await rm(directory, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}, 20_000);

it('queues one scheduled search under competing ticks and skips downtime and paused schedules', async () => {
  const workspaceId = randomUUID();
  await prisma.workspace.create({ data: { id: workspaceId, name: 'Discovery schedule test', slug: workspaceId } });
  try {
    const config = { query: 'creator workflow', intervalMinutes: 180, enabled: true };
    const schedule: any = await setDiscoverySchedule(workspaceId, config, 'test-operator');
    const afterDowntime = new Date(schedule.nextRunAt.getTime() + 24 * 60 * 60_000);
    const jobs = await Promise.all([
      enqueueDueDiscovery(workspaceId, afterDowntime),
      enqueueDueDiscovery(workspaceId, afterDowntime),
    ]);
    expect(jobs.filter(Boolean)).toHaveLength(1);
    expect(jobs.find(Boolean)?.payload).toEqual({ query: config.query });
    const advanced: any = await getDiscoverySchedule(workspaceId);
    expect(advanced.nextRunAt).toEqual(new Date(afterDowntime.getTime() + 180 * 60_000));
    expect(await enqueueDueDiscovery(workspaceId, afterDowntime)).toBeNull();

    await setDiscoverySchedule(workspaceId, { ...config, enabled: false }, 'test-operator');
    expect(await enqueueDueDiscovery(workspaceId, advanced.nextRunAt)).toBeNull();
    const count = await withWorkspaceTransaction(workspaceId, (tx) => tx.job.count({ where: { workspaceId } }));
    expect(count).toBe(1);
  } finally {
    await prisma.workspace.delete({ where: { id: workspaceId } });
    await prisma.$disconnect();
  }
}, 20_000);

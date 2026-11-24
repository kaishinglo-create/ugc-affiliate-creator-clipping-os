import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import {
  createDiscoverySchedule,
  enqueueDiscovery,
  listDiscoveryCandidates,
  listDiscoverySchedules,
} from '../src/discovery.js';
import { runEngineTick } from '../src/engine.js';

const fakeServer = (marker: string) => `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(marker)}, message.method + '\\n');
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'fake-api-anything', version: '0.1.0' },
    } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'youtube_search', inputSchema: { type: 'object' } }] } });
  } else if (message.method === 'tools/call') {
    const query = message.params.arguments.query;
    const payload = { ok: true, tier: 1, candidates: [{ id: 'mcp123xyz01', title: 'mcp result for ' + query }] };
    send({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload,
    } });
  }
});
`;

it('connects to the discovery provider as an MCP client and calls its search tool', async () => {
  const workspaceId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'ugc-discovery-mcp-'));
  try {
    await prisma.workspace.create({ data: { id: workspaceId, name: 'MCP test', slug: workspaceId } });
    const marker = join(directory, 'handshake.log');
    const server = join(directory, 'server.mjs');
    await writeFile(server, fakeServer(marker));
    vi.stubEnv('DISCOVERY_MCP_CLIENT', '');
    vi.stubEnv('DISCOVERY_MCP_SERVER', server);

    const queued = await enqueueDiscovery(workspaceId, { query: 'mcp query' });
    const tick = await runEngineTick({ workspaceId, batchSize: 5, concurrency: 1 });
    expect(tick.jobs).toContainEqual(expect.objectContaining({ id: queued.id, outcome: 'succeeded' }));
    expect(await listDiscoveryCandidates(workspaceId)).toEqual([
      expect.objectContaining({ externalId: 'mcp123xyz01', title: 'mcp result for mcp query' }),
    ]);

    const methods = (await readFile(marker, 'utf8')).trim().split('\n');
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  } finally {
    vi.unstubAllEnvs();
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await rm(directory, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}, 20_000);

it('queues due recurring searches exactly once and advances the schedule', async () => {
  const workspaceId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'ugc-discovery-schedule-'));
  try {
    await prisma.workspace.create({ data: { id: workspaceId, name: 'Schedule test', slug: workspaceId } });
    const client = join(directory, 'client.mjs');
    await writeFile(client, `console.log(JSON.stringify({ ok: true, tier: 1, candidates: [{ id: 'sched123xy1', title: 'scheduled result' }] }));`);
    vi.stubEnv('DISCOVERY_MCP_CLIENT', client);
    vi.stubEnv('DISCOVERY_MCP_SERVER', '');

    const dueAt = new Date(Date.now() - 60_000).toISOString();
    const schedule = await createDiscoverySchedule(workspaceId, { query: 'scheduled query', intervalMinutes: 60, runAt: dueAt });
    expect((await listDiscoverySchedules(workspaceId)).map((row: any) => row.id)).toEqual([schedule.id]);

    const now = new Date();
    const firstTick = await runEngineTick({ workspaceId, now, batchSize: 5, concurrency: 1 });
    expect(firstTick.scheduledSearchesQueued).toBe(1);
    expect(firstTick.jobs).toContainEqual(expect.objectContaining({ outcome: 'succeeded' }));
    expect(await listDiscoveryCandidates(workspaceId)).toEqual([
      expect.objectContaining({ externalId: 'sched123xy1', title: 'scheduled result' }),
    ]);

    const [advanced] = await listDiscoverySchedules(workspaceId);
    expect(new Date(advanced.nextRunAt).getTime()).toBeGreaterThan(now.getTime());
    expect(advanced.lastRunAt?.toISOString()).toBe(new Date(dueAt).toISOString());

    const secondTick = await runEngineTick({ workspaceId, now, batchSize: 5, concurrency: 1 });
    expect(secondTick.scheduledSearchesQueued).toBe(0);
    expect(secondTick.jobs).toEqual([]);
    const jobs: any[] = await withWorkspaceTransaction(workspaceId, (tx) => tx.job.findMany({ where: { workspaceId } }));
    expect(jobs).toHaveLength(1);
  } finally {
    vi.unstubAllEnvs();
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await rm(directory, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}, 20_000);

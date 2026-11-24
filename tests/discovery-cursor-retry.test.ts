import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import {
  discoveryBackoffMs,
  discoveryCursorKey,
  enqueueDiscovery,
  getDiscoveryCursor,
} from '../src/discovery.js';
import { runEngineTick } from '../src/engine.js';

/** Explicit test double for the MCP peer, not a production data source. */
const cursorServer = (marker: string) => `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'fake-cursor-server', version: '0.1.0' },
    } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'youtube_search', inputSchema: { type: 'object' } }] } });
  } else if (message.method === 'tools/call') {
    const args = message.params.arguments;
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify(args) + '\\n');
    const payload = { ok: true, tier: 1, candidates: [{ id: 'cursor1234a', title: 'cursor result' }], nextCursor: 'cursor-2' };
    send({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload,
    } });
  }
});
`;

it('uses bounded exponential backoff and stable cursor keys', () => {
  expect(discoveryBackoffMs(1)).toBe(30_000);
  expect(discoveryBackoffMs(2)).toBe(60_000);
  expect(discoveryBackoffMs(3)).toBe(120_000);
  expect(discoveryBackoffMs(99)).toBe(300_000);
  expect(discoveryCursorKey('same query')).toBe(discoveryCursorKey('same query'));
  expect(discoveryCursorKey('a')).not.toBe(discoveryCursorKey('b'));
});

it('persists a provider cursor and sends it on the next queued search', async () => {
  const workspaceId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'ugc-discovery-cursor-'));
  try {
    await prisma.workspace.create({ data: { id: workspaceId, name: 'Cursor test', slug: workspaceId } });
    const marker = join(directory, 'calls.log');
    const server = join(directory, 'server.mjs');
    await writeFile(server, cursorServer(marker));
    vi.stubEnv('DISCOVERY_MCP_CLIENT', '');
    vi.stubEnv('DISCOVERY_MCP_SERVER', server);

    expect(await getDiscoveryCursor(workspaceId, 'cursor query')).toBeNull();
    const first = await enqueueDiscovery(workspaceId, { query: 'cursor query' });
    const tick = await runEngineTick({ workspaceId, batchSize: 5, concurrency: 1 });
    expect(tick.jobs).toContainEqual(expect.objectContaining({ id: first.id, outcome: 'succeeded' }));
    expect(await getDiscoveryCursor(workspaceId, 'cursor query')).toBe('cursor-2');

    const calls = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls).toEqual([{ query: 'cursor query' }]);

    const laterRunAt = new Date(Date.now() + 3_600_000).toISOString();
    const second = await enqueueDiscovery(workspaceId, { query: 'cursor query', runAt: laterRunAt });
    const stored: any = await withWorkspaceTransaction(workspaceId, (tx) => tx.job.findUnique({ where: { id: second.id } }));
    expect(stored.payload).toEqual({ query: 'cursor query', cursor: 'cursor-2' });
    expect(second.id).not.toBe(first.id);
  } finally {
    vi.unstubAllEnvs();
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await rm(directory, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}, 25_000);

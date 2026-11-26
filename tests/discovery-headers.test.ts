import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { enqueueDiscovery } from '../src/discovery.js';
import { runEngineTick } from '../src/engine.js';

const pilotModuleUrl = new URL('../pilots/api-anything/server.mjs', import.meta.url).href;
const undiciModuleUrl = new URL('../pilots/api-anything/node_modules/undici/index.js', import.meta.url).href;
const sdkBaseUrl = new URL('../pilots/api-anything/node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url).href;

const { createPilotServer, createYouTubeFetch } = (await import(pilotModuleUrl)) as any;
const { fetch: undiciFetch } = (await import(undiciModuleUrl)) as any;
const { Client } = (await import(`${sdkBaseUrl}client/index.js`)) as any;
const { InMemoryTransport } = (await import(`${sdkBaseUrl}inMemory.js`)) as any;

type HeaderBag = Record<string, string | string[] | undefined>;

async function withOversizedHeaderServer(
  run: (url: string, received: () => HeaderBag) => Promise<void>,
): Promise<void> {
  let received: HeaderBag = {};
  const server = createServer((request, response) => {
    received = request.headers as HeaderBag;
    response.writeHead(200, { 'content-type': 'text/plain', 'x-pad': 'p'.repeat(20_000) });
    response.end('ok');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('NO_LOCAL_ADDRESS');
  try {
    await run(`http://127.0.0.1:${address.port}/results`, () => received);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

it('shows the default fetch header overflow locally', async () => {
  await withOversizedHeaderServer(async (url) => {
    await expect(fetch(url)).rejects.toMatchObject({
      name: 'TypeError',
      message: 'fetch failed',
      cause: expect.objectContaining({ code: 'UND_ERR_HEADERS_OVERFLOW' }),
    });
  });
});

it('raises the header limit in the pilot fetch wrapper without widening its policy', async () => {
  await withOversizedHeaderServer(async (url, received) => {
    // Rewrite only the transport target; the wrapper still validates the
    // original YouTube URL and supplies the raised-limit dispatcher.
    const wrapper = createYouTubeFetch((_requestUrl: string, init: any) => undiciFetch(url, init));
    const response = await wrapper('https://www.youtube.com/results?search_query=offline', {
      method: 'GET',
      headers: {
        accept: 'text/html',
        cookie: 'session=should-not-leak',
        authorization: 'Bearer should-not-leak',
        'x-secret': 'should-not-leak',
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');

    const headers = received();
    expect(headers.accept).toBe('text/html');
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-secret']).toBeUndefined();

    expect(() => wrapper('https://www.youtube.com/watch?v=abc123xyz01')).toThrow('PILOT_REQUEST_NOT_ALLOWED');
    expect(() => wrapper('https://evil.example/results')).toThrow('PILOT_REQUEST_NOT_ALLOWED');
    expect(() => wrapper('https://www.youtube.com/results', { method: 'POST' })).toThrow('PILOT_REQUEST_NOT_ALLOWED');
  });
});

it('completes the pilot MCP handshake and returns structuredContent without live network', async () => {
  const server = createPilotServer({
    planCall: () => ({ ok: true, readOnly: true, signedIn: false, tier: 1 }),
    callPlanned: async () => ({ ok: true, tier: 1, data: [{ id: 'offline1234', title: 'Offline result' }] }),
    fetchImpl: () => { throw new Error('network disabled'); },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'offline-test', version: '1.0.0' });
  try {
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(['youtube_search']);
    expect((tools[0] as any).inputSchema.properties).toHaveProperty('cursor');

    const result = await client.callTool({
      name: 'youtube_search',
      arguments: { query: 'offline query', cursor: 'noop' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      tier: 1,
      candidates: [expect.objectContaining({ id: 'offline1234', title: 'Offline result' })],
    });
  } finally {
    await client.close();
    await server.close();
  }
});

it('records redacted blocked and transport diagnostics without leaking secrets', async () => {
  const workspaceId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'ugc-discovery-headers-'));
  try {
    await prisma.workspace.create({ data: { id: workspaceId, name: 'Discovery diagnostics test', slug: workspaceId } });
    const client = join(directory, 'client.mjs');
    await writeFile(client, `const query = process.argv.slice(2)[1];
if (query === 'transport failure') {
  console.error('MCP_SERVER_EXITED (1): SESSION_JWT_SECRET=super-secret-value');
  process.exit(1);
}
console.log(JSON.stringify({ ok: false, class: 'blocked', reason: 'headers overflow UND_ERR_HEADERS_OVERFLOW SESSION_JWT_SECRET=super-secret-value' }));
`);
    vi.stubEnv('DISCOVERY_MCP_CLIENT', client);
    vi.stubEnv('DISCOVERY_MCP_SERVER', '');

    const blocked = await enqueueDiscovery(workspaceId, { query: 'blocked diagnostic' });
    const transport = await enqueueDiscovery(workspaceId, { query: 'transport failure' });
    await runEngineTick({ workspaceId, batchSize: 5, concurrency: 1 });

    const rows: any[] = await withWorkspaceTransaction(workspaceId, (tx) => tx.job.findMany({ where: { workspaceId } }));
    const blockedRow = rows.find((row) => row.id === blocked.id);
    const transportRow = rows.find((row) => row.id === transport.id);
    expect(blockedRow.lastError).toBe('DISCOVERY_PROVIDER_BLOCKED');
    expect(blockedRow.status).toBe('FAILED');
    expect(transportRow.lastError).toContain('DISCOVERY_MCP_UNAVAILABLE');
    expect(transportRow.lastError).toContain('[REDACTED]');
    expect(['RETRY_WAIT', 'DEAD_LETTER']).toContain(transportRow.status);

    const audits: any[] = await withWorkspaceTransaction(workspaceId, (tx) => tx.auditEvent.findMany({
      where: { workspaceId, type: 'content_discovery_failed' },
    }));
    const blockedAudit = audits.find((audit) => (audit.data as any)?.jobId === blocked.id);
    const transportAudit = audits.find((audit) => (audit.data as any)?.jobId === transport.id);

    expect(blockedAudit.data).toMatchObject({ class: 'DISCOVERY_PROVIDER_BLOCKED', retryable: false });
    expect(blockedAudit.data.message).toContain('UND_ERR_HEADERS_OVERFLOW');
    expect(transportAudit.data).toMatchObject({ class: 'DISCOVERY_MCP_UNAVAILABLE', retryable: true });
    expect(transportAudit.data.message).toContain('[REDACTED]');
    for (const audit of [blockedAudit, transportAudit]) {
      expect(JSON.stringify(audit.data)).not.toContain('super-secret-value');
    }
  } finally {
    vi.unstubAllEnvs();
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await rm(directory, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}, 25_000);

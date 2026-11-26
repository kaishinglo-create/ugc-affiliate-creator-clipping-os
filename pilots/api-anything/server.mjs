import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, fetch as undiciFetch } from 'undici';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/** YouTube's /results response carries ~19 KB of headers; Node's fetch default is 16 KB. */
export const RESPONSE_HEADER_LIMIT = 32_768;
export const ALLOWED_ORIGIN = 'https://www.youtube.com';
export const ALLOWED_PATH = '/results';

const ALLOWED_REQUEST_HEADERS = ['accept', 'accept-language', 'user-agent'];
const responseAgent = new Agent({ maxHeaderSize: RESPONSE_HEADER_LIMIT });

function allowListedHeaders(init) {
  const incoming = new Headers(init?.headers);
  const outgoing = new Headers();
  for (const name of ALLOWED_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value !== null) outgoing.set(name, value);
  }
  return outgoing;
}

/**
 * Tier 1 fetch wrapper. The base fetch is injectable for offline tests; the
 * origin/method/header policy below always applies, including on redirect hops
 * (api-anything follows them by calling this wrapper again).
 */
export function createYouTubeFetch(baseFetch = undiciFetch) {
  return function fetchYouTube(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = String(init.method ?? (typeof input === 'string' ? undefined : input.method) ?? 'GET').toUpperCase();
    if (url.origin !== ALLOWED_ORIGIN || url.pathname !== ALLOWED_PATH ||
        url.username || url.password || method !== 'GET') {
      throw new Error('PILOT_REQUEST_NOT_ALLOWED');
    }
    const headers = allowListedHeaders(init);
    if (headers.has('cookie') || headers.has('authorization')) {
      throw new Error('PILOT_REQUEST_NOT_ALLOWED');
    }
    return baseFetch(url, {
      ...init,
      method: 'GET',
      headers,
      redirect: 'manual',
      credentials: 'omit',
      dispatcher: responseAgent,
    });
  };
}

export const fetchYouTube = createYouTubeFetch();

const videoSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  title: z.string().trim().min(1).max(500),
  channel: z.string().max(250).optional(),
});

function reply(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

/** Build the MCP server with injected host functions; no environment side effects. */
export function createPilotServer({ planCall, callPlanned, fetchImpl = fetchYouTube } = {}) {
  if (typeof planCall !== 'function' || typeof callPlanned !== 'function') {
    throw new Error('PILOT_HOST_REQUIRED');
  }
  const server = new McpServer({ name: 'ugc-api-anything-pilot', version: '0.1.0' });
  server.registerTool('youtube_search', {
    description: 'Read public YouTube video search results over HTTP.',
    inputSchema: {
      query: z.string().trim().min(1).max(200),
      // Accepted for cursor capability parity. Tier 1 /results has no stable
      // continuation parameter, so the value is intentionally a no-op.
      cursor: z.string().min(1).max(512).optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ query }) => {
    const plan = planCall('youtube', 'search', { q: query }, { maxTier: 1 });
    if (!plan.ok) return reply({ ok: false, class: plan.result.class });
    if (!plan.readOnly || plan.signedIn || plan.tier !== 1) {
      return reply({ ok: false, class: 'refused' });
    }
    const result = await callPlanned(plan, { maxTier: 1, allowWrites: false, timeoutMs: 12_000, fetchImpl });
    if (!result.ok) return reply({ ok: false, class: result.class, reason: result.reason });
    if (result.tier !== 1 || !Array.isArray(result.data)) {
      return reply({ ok: false, class: 'invalid_result' });
    }

    const candidates = new Map();
    const foundAt = new Date().toISOString();
    for (const value of result.data) {
      const video = videoSchema.safeParse(value);
      if (!video.success || candidates.has(video.data.id)) continue;
      const { id, title, channel } = video.data;
      candidates.set(id, { id, title, channel, source: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, foundAt });
      if (candidates.size === 20) break;
    }
    if (result.data.length > 0 && candidates.size === 0) return reply({ ok: false, class: 'invalid_result' });
    return reply({ ok: true, tier: 1, candidates: [...candidates.values()] });
  });
  return server;
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && fileURLToPath(import.meta.url) === resolve(entry);
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'ugc-api-anything-'));
  process.env.API_ANYTHING_HOME = home;
  process.env.API_ANYTHING_LOCAL_ONLY = '1';
  process.once('exit', () => rmSync(home, { recursive: true, force: true }));

  const { planCall, callPlanned } = await import('api-anything/host');
  const server = createPilotServer({ planCall, callPlanned, fetchImpl: fetchYouTube });
  await server.connect(new StdioServerTransport());
}

if (isMainModule()) await main();

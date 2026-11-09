import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const home = mkdtempSync(join(tmpdir(), 'ugc-api-anything-'));
process.env.API_ANYTHING_HOME = home;
process.env.API_ANYTHING_LOCAL_ONLY = '1';
process.once('exit', () => rmSync(home, { recursive: true, force: true }));

const { planCall, callPlanned } = await import('api-anything/host');
const videoSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  title: z.string().trim().min(1).max(500),
  channel: z.string().max(250).optional(),
});

function reply(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function fetchYouTube(input, init) {
  const url = new URL(input);
  const headers = new Headers(init?.headers);
  if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/results' ||
      url.username || url.password || (init?.method ?? 'GET') !== 'GET' ||
      headers.has('cookie') || headers.has('authorization')) {
    throw new Error('PILOT_REQUEST_NOT_ALLOWED');
  }
  return fetch(url, { ...init, redirect: 'manual', credentials: 'omit' });
}

const server = new McpServer({ name: 'ugc-api-anything-pilot', version: '0.1.0' });
server.registerTool('youtube_search', {
  description: 'Read public YouTube video search results over HTTP.',
  inputSchema: { query: z.string().trim().min(1).max(200) },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ query }) => {
  const plan = planCall('youtube', 'search', { q: query }, { maxTier: 1 });
  if (!plan.ok) return reply({ ok: false, class: plan.result.class });
  if (!plan.readOnly || plan.signedIn || plan.tier !== 1) {
    return reply({ ok: false, class: 'refused' });
  }
  const result = await callPlanned(plan, { maxTier: 1, allowWrites: false, timeoutMs: 12_000, fetchImpl: fetchYouTube });
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
await server.connect(new StdioServerTransport());

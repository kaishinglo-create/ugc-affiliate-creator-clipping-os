/**
 * Officially documented provider analytics/insights READ functions.
 *
 * Request construction, response parsing and bounded transport are implemented
 * locally. Without credentials the status is honestly NOT_CONFIGURED; no value
 * is invented and no paid service is used.
 */
import { Buffer } from 'node:buffer';
import { fetch as undiciFetch, type Agent } from 'undici';
import { createPinnedAgent, resolvePinnedTarget } from './media-download.js';
import { assertPublicHttpsUrl, type PublishingLookup } from './publishing-adapters.js';

const MAX_RESPONSE_BYTES = 256 * 1024;

export type AnalyticsPlatform = 'youtube' | 'tiktok' | 'instagram';

export interface AnalyticsRequest {
  url: string;
  init: { method: 'GET'; headers: Record<string, string> };
}

const YOUTUBE_ANALYTICS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';
const TIKTOK_CREATOR_URL = 'https://open.tiktokapis.com/v2/user/info/';
const INSTAGRAM_GRAPH_BASE = 'https://graph.facebook.com/v21.0';

function requireToken(token: unknown): string {
  const value = String(token ?? '').trim();
  if (!value) throw new Error('NOT_CONFIGURED');
  return value;
}

export function buildYouTubeAnalyticsRequest(input: {
  accessToken: string;
  startDate: string;
  endDate: string;
  metrics?: string;
  dimensions?: string;
  filters?: string;
}): AnalyticsRequest {
  const token = requireToken(input.accessToken);
  const params = new URLSearchParams({
    ids: 'channel==MINE',
    startDate: input.startDate,
    endDate: input.endDate,
    metrics: input.metrics ?? 'views,likes,comments,shares',
  });
  if (input.dimensions) params.set('dimensions', input.dimensions);
  if (input.filters) params.set('filters', input.filters);
  return {
    url: `${YOUTUBE_ANALYTICS_URL}?${params.toString()}`,
    init: { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
  };
}

/** Parse only documented YouTube Analytics column/row values. */
export function parseYouTubeAnalyticsResponse(json: any): Array<Record<string, string | number>> {
  const columns: string[] = Array.isArray(json?.columnHeaders)
    ? json.columnHeaders.map((entry: any) => String(entry?.name ?? '')).filter(Boolean)
    : [];
  const rows = Array.isArray(json?.rows) ? json.rows : [];
  if (!columns.length) return [];
  return rows.filter((row: any) => Array.isArray(row)).map((row: any[]) =>
    Object.fromEntries(columns.map((key, index) => [key, row[index] as string | number])));
}

export function buildTikTokCreatorInfoRequest(accessToken: string): AnalyticsRequest {
  const token = requireToken(accessToken);
  const params = new URLSearchParams({ fields: 'open_id,union_id,avatar_url,display_name' });
  return {
    url: `${TIKTOK_CREATOR_URL}?${params.toString()}`,
    init: { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
  };
}

export function parseTikTokCreatorInfoResponse(json: any): Record<string, unknown> | null {
  const data = json?.data?.user;
  if (!data || typeof data !== 'object') return null;
  return {
    openId: typeof data.open_id === 'string' ? data.open_id : null,
    displayName: typeof data.display_name === 'string' ? data.display_name : null,
    avatarUrl: typeof data.avatar_url === 'string' ? data.avatar_url : null,
  };
}

export function buildInstagramInsightsRequest(input: {
  accessToken: string;
  igUserId: string;
  metric: string;
  period?: string;
}): AnalyticsRequest {
  const token = requireToken(input.accessToken);
  const userId = encodeURIComponent(String(input.igUserId ?? '').slice(0, 100));
  if (!userId || userId === '%22%22') throw new Error('INVALID_INPUT');
  const params = new URLSearchParams({
    metric: String(input.metric ?? '').slice(0, 200),
    period: input.period ?? 'day',
    access_token: token,
  });
  return { url: `${INSTAGRAM_GRAPH_BASE}/${userId}/insights?${params.toString()}`, init: { method: 'GET', headers: {} } };
}

export function parseInstagramInsightsResponse(json: any): Array<Record<string, unknown>> {
  const data = Array.isArray(json?.data) ? json.data : [];
  return data.filter((entry: any) => entry && typeof entry === 'object').map((entry: any) => ({
    name: String(entry.name ?? ''),
    period: String(entry.period ?? ''),
    values: Array.isArray(entry.values)
      ? entry.values.map((value: any) => ({ value: value?.value ?? null, endTime: value?.end_time ?? null }))
      : [],
  }));
}

const PARSERS: Record<AnalyticsPlatform, (json: any) => unknown> = {
  youtube: parseYouTubeAnalyticsResponse,
  tiktok: parseTikTokCreatorInfoResponse,
  instagram: parseInstagramInsightsResponse,
};

/** Bounded read against an official endpoint; never logs or returns tokens. */
export async function fetchProviderAnalytics(input: {
  platform: AnalyticsPlatform;
  request: AnalyticsRequest;
  /** Controlled test double only; production pins the socket to a validated IP. */
  fetchImpl?: typeof fetch;
  lookup?: PublishingLookup;
  timeoutMs?: number;
}): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  let url = await assertPublicHttpsUrl(input.request.url, input.lookup);
  if (!url) return { ok: false, error: 'SSRF_BLOCKED' };
  let agent: Agent | null = null;
  let fetchImpl = input.fetchImpl;
  if (!fetchImpl) {
    try {
      const target = await resolvePinnedTarget(url, input.lookup
        ? { lookup: async (hostname: string) => input.lookup!(hostname) }
        : {});
      if (new URL(target.url).protocol !== 'https:') return { ok: false, error: 'SSRF_BLOCKED' };
      agent = createPinnedAgent(target);
      url = target.url;
      fetchImpl = ((requestUrl: string, options: any) =>
        undiciFetch(requestUrl, { ...options, dispatcher: agent } as any) as unknown as Promise<Response>) as typeof fetch;
    } catch {
      return { ok: false, error: 'SSRF_BLOCKED' };
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(30_000, input.timeoutMs ?? 15_000)));
  timer.unref?.();
  try {
    const response = await fetchImpl!(url, {
      method: input.request.init.method,
      headers: input.request.init.headers,
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!response.ok) return { ok: false, error: `PROVIDER_HTTP_${response.status}` };
    // Bounded streaming: stop reading as soon as the cap is exceeded.
    const reader = response.body?.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, error: 'PROVIDER_RESPONSE_TOO_LARGE' };
        }
        chunks.push(Buffer.from(value));
      }
    }
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { ok: true, data: PARSERS[input.platform](json) };
  } catch {
    return { ok: false, error: 'PROVIDER_REQUEST_FAILED' };
  } finally {
    clearTimeout(timer);
    if (agent) await agent.close().catch(() => undefined);
  }
}

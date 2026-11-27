/**
 * YouTube Data API v3 adapter for Phase G live discovery.
 *
 * Uses only the operator-provided API key and the public free-tier endpoints.
 * No paid fallback, no scraping and no fabricated results: without a key every
 * function fails closed with NOT_CONFIGURED.
 */
import { redactError } from '../lib/redaction.js';

export const YOUTUBE_API_KEY_ENV = 'YOUTUBE_API_KEY';
export const YOUTUBE_API_BASE_ENV = 'YOUTUBE_API_BASE';

const DEFAULT_BASE = 'https://www.googleapis.com/youtube/v3';

export interface YouTubeVideo {
  externalId: string;
  title: string;
  channel: string;
  publishedAt: string;
  description?: string;
  nextCursor?: string;
}

export interface YouTubeChannel {
  externalId: string;
  title: string;
  description?: string;
}

function apiKey(): string {
  const key = String(process.env[YOUTUBE_API_KEY_ENV] ?? '').trim();
  if (!key) throw new Error('YOUTUBE_NOT_CONFIGURED');
  return key;
}

function baseUrl(): string {
  const value = String(process.env[YOUTUBE_API_BASE_ENV] ?? '').trim();
  return (value || DEFAULT_BASE).replace(/\/+$/, '');
}

async function getJson<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(`${baseUrl()}${path}`);
  url.searchParams.set('key', apiKey());
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(name, String(value));
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  if (!response.ok) {
    const detail = String(redactError(new Error(`YOUTUBE_HTTP_${response.status}`)).message ?? '');
    throw new Error(detail || `YOUTUBE_HTTP_${response.status}`);
  }
  return response.json() as Promise<T>;
}

/** Search videos by free-text query. Returns only real API rows. */
export async function youtubeSearch(query: string, cursor?: string, maxResults = 20): Promise<{ items: YouTubeVideo[]; nextCursor?: string }> {
  const data = await getJson<any>('/search', {
    part: 'snippet',
    type: 'video',
    q: query,
    maxResults: Math.min(50, Math.max(1, Math.trunc(maxResults))),
    pageToken: cursor,
  });
  const items: YouTubeVideo[] = (data.items ?? []).map((item: any) => ({
    externalId: String(item?.id?.videoId ?? ''),
    title: String(item?.snippet?.title ?? '').slice(0, 500),
    channel: String(item?.snippet?.channelTitle ?? '').slice(0, 250),
    publishedAt: String(item?.snippet?.publishedAt ?? ''),
    description: item?.snippet?.description ? String(item.snippet.description).slice(0, 2_000) : undefined,
  })).filter((item: YouTubeVideo) => item.externalId && item.title);
  return { items, ...(data.nextPageToken ? { nextCursor: String(data.nextPageToken) } : {}) };
}

/** Trending videos for a region; requires explicit region code. */
export async function youtubeTrending(regionCode: string, maxResults = 20): Promise<{ items: YouTubeVideo[]; nextCursor?: string }> {
  const data = await getJson<any>('/videos', {
    part: 'snippet,statistics',
    chart: 'mostPopular',
    regionCode,
    maxResults: Math.min(50, Math.max(1, Math.trunc(maxResults))),
  });
  const items: YouTubeVideo[] = (data.items ?? []).map((item: any) => ({
    externalId: String(item?.id ?? ''),
    title: String(item?.snippet?.title ?? '').slice(0, 500),
    channel: String(item?.snippet?.channelTitle ?? '').slice(0, 250),
    publishedAt: String(item?.snippet?.publishedAt ?? ''),
    description: item?.snippet?.description ? String(item.snippet.description).slice(0, 2_000) : undefined,
  })).filter((item: YouTubeVideo) => item.externalId && item.title);
  return { items, ...(data.nextPageToken ? { nextCursor: String(data.nextPageToken) } : {}) };
}

/** Discover channels relevant to a keyword. */
export async function youtubeCreators(query: string, maxResults = 20): Promise<{ items: YouTubeChannel[]; nextCursor?: string }> {
  const data = await getJson<any>('/search', {
    part: 'snippet',
    type: 'channel',
    q: query,
    maxResults: Math.min(50, Math.max(1, Math.trunc(maxResults))),
  });
  const items: YouTubeChannel[] = (data.items ?? []).map((item: any) => ({
    externalId: String(item?.id?.channelId ?? ''),
    title: String(item?.snippet?.title ?? '').slice(0, 500),
    description: item?.snippet?.description ? String(item.snippet.description).slice(0, 2_000) : undefined,
  })).filter((item: YouTubeChannel) => item.externalId && item.title);
  return { items, ...(data.nextPageToken ? { nextCursor: String(data.nextPageToken) } : {}) };
}

/** Derive keyword clusters only from real titles returned by the API. */
export async function youtubeKeywords(query: string, maxResults = 20): Promise<{ items: Array<{ keyword: string; count: number }> }> {
  const { items } = await youtubeSearch(query, undefined, maxResults);
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const token of item.title.toLowerCase().match(/[a-z0-9äöüß]{3,}/g) ?? []) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return { items: [...counts.entries()].map(([keyword, count]) => ({ keyword, count })).sort((a, b) => b.count - a.count).slice(0, 25) };
}

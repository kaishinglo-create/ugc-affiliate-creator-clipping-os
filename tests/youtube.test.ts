import 'dotenv/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { youtubeCreators, youtubeKeywords, youtubeSearch, youtubeTrending } from '../src/youtube.js';

const originalKey = process.env.YOUTUBE_API_KEY;
const originalBase = process.env.YOUTUBE_API_BASE;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = originalKey;
  if (originalBase === undefined) delete process.env.YOUTUBE_API_BASE;
  else process.env.YOUTUBE_API_BASE = originalBase;
});

function stubFetch(payload: unknown, calls: Array<URL> = []) {
  vi.stubEnv('YOUTUBE_API_KEY', 'ci-only-youtube-key');
  vi.stubEnv('YOUTUBE_API_BASE', 'https://youtube.example.test/v3');
  const fetchMock = vi.fn(async (input: any) => {
    calls.push(new URL(String(input)));
    return { ok: true, json: async () => payload } as any;
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('YouTube Data API adapter', () => {
  it('fails closed without an API key', async () => {
    delete process.env.YOUTUBE_API_KEY;
    await expect(youtubeSearch('creator workflow')).rejects.toThrow('YOUTUBE_NOT_CONFIGURED');
  });

  it('maps search results to real video rows and forwards cursors', async () => {
    const calls: URL[] = [];
    stubFetch({
      items: [{ id: { videoId: 'abc123xyz01' }, snippet: { title: 'Clip workflow', channelTitle: 'Creator', publishedAt: '2026-01-01T00:00:00Z' } }],
      nextPageToken: 'NEXT',
    }, calls);
    const result = await youtubeSearch('creator workflow', 'TOKEN');
    expect(result.items).toEqual([expect.objectContaining({ externalId: 'abc123xyz01', title: 'Clip workflow', channel: 'Creator' })]);
    expect(result.nextCursor).toBe('NEXT');
    expect(calls[0].searchParams.get('pageToken')).toBe('TOKEN');
    expect(calls[0].searchParams.get('key')).toBe('ci-only-youtube-key');
  });

  it('maps trending and creator searches', async () => {
    stubFetch({ items: [{ id: 'vid123', snippet: { title: 'Trending', channelTitle: 'News' } }] });
    const trending = await youtubeTrending('DE');
    expect(trending.items[0]).toMatchObject({ externalId: 'vid123', title: 'Trending' });
    stubFetch({ items: [{ id: { channelId: 'chan123' }, snippet: { title: 'Creator Channel' } }] });
    const creators = await youtubeCreators('clipping');
    expect(creators.items[0]).toMatchObject({ externalId: 'chan123', title: 'Creator Channel' });
  });

  it('derives keyword clusters only from returned titles', async () => {
    stubFetch({ items: [
      { id: { videoId: 'a' }, snippet: { title: 'Clip clipping workflow' } },
      { id: { videoId: 'b' }, snippet: { title: 'Clipping tools' } },
    ] });
    const result = await youtubeKeywords('clipping');
    expect(result.items).toContainEqual(expect.objectContaining({ keyword: 'clipping', count: 2 }));
  });
});

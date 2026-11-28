import 'dotenv/config';
import { describe, expect, it, vi } from 'vitest';
import {
  buildInstagramInsightsRequest,
  buildTikTokCreatorInfoRequest,
  buildYouTubeAnalyticsRequest,
  fetchProviderAnalytics,
  parseInstagramInsightsResponse,
  parseTikTokCreatorInfoResponse,
  parseYouTubeAnalyticsResponse,
} from '../src/provider-analytics.js';
import { listProviderCapabilities } from '../src/provider-capabilities.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('Phase H official provider analytics retrieval', () => {
  it('builds documented YouTube Analytics requests and parses real response rows', () => {
    const request = buildYouTubeAnalyticsRequest({
      accessToken: 'test-token', startDate: '2026-11-01', endDate: '2026-11-27', dimensions: 'video',
    });
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe('https://youtubeanalytics.googleapis.com/v2/reports');
    expect(url.searchParams.get('ids')).toBe('channel==MINE');
    expect(url.searchParams.get('dimensions')).toBe('video');
    expect(request.init.headers.Authorization).toBe('Bearer test-token');
    const rows = parseYouTubeAnalyticsResponse({
      columnHeaders: [{ name: 'video' }, { name: 'views' }],
      rows: [['abc', 42]],
    });
    expect(rows).toEqual([{ video: 'abc', views: 42 }]);
    expect(parseYouTubeAnalyticsResponse({})).toEqual([]);
  });

  it('builds TikTok creator-info and Instagram insights requests with parsers', () => {
    const tiktok = buildTikTokCreatorInfoRequest('tiktok-token');
    expect(tiktok.url).toContain('https://open.tiktokapis.com/v2/user/info/');
    expect(tiktok.init.headers.Authorization).toBe('Bearer tiktok-token');
    expect(parseTikTokCreatorInfoResponse({ data: { user: { open_id: 'o1', display_name: 'Creator' } } }))
      .toMatchObject({ openId: 'o1', displayName: 'Creator' });
    expect(parseTikTokCreatorInfoResponse({})).toBeNull();

    const instagram = buildInstagramInsightsRequest({ accessToken: 'ig-token', igUserId: '1784', metric: 'reach,impressions' });
    expect(instagram.url).toContain('https://graph.facebook.com/v21.0/1784/insights');
    expect(instagram.url).toContain('access_token=ig-token');
    const parsed = parseInstagramInsightsResponse({
      data: [{ name: 'reach', period: 'day', values: [{ value: 12, end_time: '2026-11-27' }] }],
    });
    expect(parsed[0]).toMatchObject({ name: 'reach', period: 'day' });
  });

  it('fetches through an injected fetch and fails closed on SSRF or huge responses', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ columnHeaders: [{ name: 'views' }], rows: [[7]] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const ok = await fetchProviderAnalytics({
      platform: 'youtube',
      request: buildYouTubeAnalyticsRequest({ accessToken: 't', startDate: '2026-01-01', endDate: '2026-01-02' }),
      fetchImpl: fakeFetch,
      lookup: publicLookup,
    });
    expect(ok).toEqual({ ok: true, data: [{ views: 7 }] });

    const blocked = await fetchProviderAnalytics({
      platform: 'youtube',
      request: { url: 'http://169.254.169.254/latest', init: { method: 'GET', headers: {} } },
      fetchImpl: fakeFetch,
      lookup: publicLookup,
    });
    expect(blocked).toEqual({ ok: false, error: 'SSRF_BLOCKED' });

    const huge = (async () => new Response(`{"data":"${'x'.repeat(300_000)}"}`, { status: 200 })) as unknown as typeof fetch;
    const tooLarge = await fetchProviderAnalytics({
      platform: 'instagram',
      request: buildInstagramInsightsRequest({ accessToken: 't', igUserId: '1', metric: 'reach' }),
      fetchImpl: huge,
      lookup: publicLookup,
    });
    expect(tooLarge).toEqual({ ok: false, error: 'PROVIDER_RESPONSE_TOO_LARGE' });
  });

  it('pins production sockets and rejects rebinding DNS answers', async () => {
    const blocked = await fetchProviderAnalytics({
      platform: 'youtube',
      request: buildYouTubeAnalyticsRequest({ accessToken: 't', startDate: '2026-01-01', endDate: '2026-01-02' }),
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(blocked).toEqual({ ok: false, error: 'SSRF_BLOCKED' });
    const blockedV6 = await fetchProviderAnalytics({
      platform: 'tiktok',
      request: buildTikTokCreatorInfoRequest('t'),
      lookup: async () => [{ address: '::1', family: 6 }],
    });
    expect(blockedV6).toEqual({ ok: false, error: 'SSRF_BLOCKED' });
  });

  it('reports local implementation honestly while live verification stays blocked', () => {
    vi.stubEnv('YOUTUBE_ACCESS_TOKEN', '');
    vi.stubEnv('TIKTOK_ACCESS_TOKEN', '');
    vi.stubEnv('INSTAGRAM_ACCESS_TOKEN', '');
    vi.stubEnv('AFFILIATE_WEBHOOK_SECRET', '');
    const capabilities = listProviderCapabilities();
    expect(capabilities).toHaveLength(4);
    for (const capability of capabilities) {
      expect(capability.localImplementation).toBe('IMPLEMENTED');
      expect(capability.status).toBe('NOT_CONFIGURED');
      expect(capability.externalLiveBlocked).toBe(true);
    }
    vi.unstubAllEnvs();
  });
});

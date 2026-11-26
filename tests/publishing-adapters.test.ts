import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { workspaceMediaPath } from '../src/media-workspace.js';
import {
  processPublishingJob,
  publishingApprovalEntityId,
  settleRealPublishingSuccess,
} from '../src/publishing.js';

const ENTITY_TYPE = 'asset_version';
const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

type Ctx = { workspaceId: string; headers: Record<string, string> };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function signup(app: any, prefix: string): Promise<Ctx> {
  const suffix = randomUUID().slice(0, 12);
  const email = `${prefix}-${suffix}@x.com`;
  const workspaceSlug = `${prefix}-${suffix}`;
  const created = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email, password: 'password1234', workspaceName: prefix, workspaceSlug },
  });
  expect(created.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'password1234' },
  });
  expect(login.statusCode).toBe(200);
  const workspaceId = created.json().workspace.id;
  return {
    workspaceId,
    headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId },
  };
}

describe('live publishing adapters (official APIs, injectable fetch)', () => {
  let app: any;
  let owner: Ctx;
  let outsider: Ctx;

  beforeAll(async () => {
    app = await buildServer();
    owner = await signup(app, 'publive');
    outsider = await signup(app, 'publiveout');
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    vi.stubEnv('PUBLISHING_LIVE_ADAPTERS', '0');
    vi.stubEnv('YOUTUBE_CLIENT_ID', 'yt-client-id');
    vi.stubEnv('YOUTUBE_CLIENT_SECRET', 'yt-client-secret');
    vi.stubEnv('YOUTUBE_REFRESH_TOKEN', 'yt-refresh-token');
    vi.stubEnv('TIKTOK_CLIENT_KEY', 'tt-client-key');
    vi.stubEnv('TIKTOK_CLIENT_SECRET', 'tt-client-secret');
    vi.stubEnv('TIKTOK_REFRESH_TOKEN', 'tt-refresh-token');
    vi.stubEnv('INSTAGRAM_ACCESS_TOKEN', 'ig-long-lived-token');
    vi.stubEnv('INSTAGRAM_USER_ID', '17841400000000001');
    vi.stubEnv('INSTAGRAM_APP_ID', 'ig-app-id');
    vi.stubEnv('INSTAGRAM_APP_SECRET', 'SUPER_SECRET_APP_SECRET');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function createApproval(
    ctx: Ctx,
    platform: string,
    entityId: string,
    key: string,
  ): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/approvals',
      headers: ctx.headers,
      payload: {
        entityType: 'publishing',
        entityId: publishingApprovalEntityId(platform as any, ENTITY_TYPE, entityId, key),
      },
    });
    expect(created.statusCode).toBe(201);
    const approvalId = created.json().approval.id;
    const decided = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approvalId}/decide`,
      headers: ctx.headers,
      payload: { status: 'approved', reason: 'live adapter test' },
    });
    expect(decided.statusCode).toBe(200);
    return approvalId;
  }

  async function createJob(
    ctx: Ctx,
    platform: string,
    options: Record<string, string> = {},
  ): Promise<{ jobId: string; key: string; entityId: string; approvalId: string }> {
    const key = `live-${randomUUID()}`;
    const entityId = `clip-${randomUUID()}`;
    const approvalId = await createApproval(ctx, platform, entityId, key);
    const created = await app.inject({
      method: 'POST',
      url: '/api/publishing/jobs',
      headers: ctx.headers,
      payload: { platform, entityType: ENTITY_TYPE, entityId, idempotencyKey: key, options },
    });
    expect(created.statusCode).toBe(201);
    return { jobId: created.json().job.id, key, entityId, approvalId };
  }

  function runLive(
    ctx: Ctx,
    jobId: string,
    fetchMock: any,
    extra: Record<string, unknown> = {},
  ) {
    return processPublishingJob(ctx.workspaceId, jobId, 'operator', {
      workerId: 'live-adapter-tester',
      fetch: fetchMock as any,
      lookup: PUBLIC_LOOKUP,
      pollIntervalMs: 0,
      timeoutMs: 2_000,
      ...extra,
    } as any);
  }

  async function contentPosts(workspaceId: string): Promise<any[]> {
    return withWorkspaceTransaction(workspaceId, (tx: any) =>
      tx.contentPost.findMany({ where: { workspaceId } })
    ) as Promise<any[]>;
  }

  async function auditEvents(workspaceId: string, type: string): Promise<any[]> {
    return withWorkspaceTransaction(workspaceId, (tx: any) =>
      tx.auditEvent.findMany({ where: { workspaceId, type } })
    ) as Promise<any[]>;
  }

  it('requires the explicit live opt-in and real credentials before any fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis as any, 'fetch');
    const { jobId } = await createJob(owner, 'youtube', { mediaName: 'unused.mp4' });

    const noOptIn = await app.inject({
      method: 'POST',
      url: `/api/publishing/jobs/${jobId}/process`,
      headers: owner.headers,
      payload: {},
    });
    expect(noOptIn.statusCode).toBe(501);
    expect(noOptIn.json().error.code).toBe('ADAPTER_NOT_IMPLEMENTED');
    expect(noOptIn.json().adapter.liveEnabled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.stubEnv('PUBLISHING_LIVE_ADAPTERS', '1');
    vi.stubEnv('YOUTUBE_CLIENT_ID', '');
    vi.stubEnv('YOUTUBE_CLIENT_SECRET', '');
    vi.stubEnv('YOUTUBE_REFRESH_TOKEN', '');
    const missing = await createJob(owner, 'youtube', { mediaName: 'unused.mp4' });
    const noCredentials = await runLive(owner, missing.jobId, vi.fn(async () => {
      throw new Error('no fetch expected');
    }));
    expect(noCredentials.statusCode).toBe(503);
    expect((noCredentials.body as any).error.code).toBe('NOT_CONFIGURED');
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 120_000);

  it('publishes a real YouTube video with a refreshed token and workspace-scoped bytes', async () => {
    vi.stubEnv('PUBLISHING_LIVE_ADAPTERS', 'true');
    const basename = `clip-${randomUUID().replace(/-/g, '').slice(0, 12)}.mp4`;
    const filePath = workspaceMediaPath(owner.workspaceId, basename);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from('real-youtube-video-bytes'));
    const beforePosts = await contentPosts(owner.workspaceId);

    const { jobId } = await createJob(owner, 'youtube', {
      title: 'Real clip',
      description: 'Uploaded through the official API',
      visibility: 'unlisted',
      mediaName: basename,
    });

    const calls: Array<{ url: string; init: any }> = [];
    const fetchMock = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return jsonResponse({ access_token: 'yt-access-token', token_type: 'Bearer', expires_in: 3600 });
      }
      if (url.includes('upload_id=session-1')) {
        expect(init.method).toBe('PUT');
        expect(String(init.body)).toContain('real-youtube-video-bytes');
        return jsonResponse({ id: 'yt-real-video-1' });
      }
      if (url.startsWith('https://www.googleapis.com/upload/youtube/v3/videos')) {
        expect(init.headers.Authorization).toBe('Bearer yt-access-token');
        expect(init.headers['X-Upload-Content-Type']).toBe('video/mp4');
        return new Response('', {
          status: 200,
          headers: { Location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session-1' },
        });
      }
      if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
        return jsonResponse({ items: [{ id: 'yt-real-video-1', status: { uploadStatus: 'uploaded' } }] });
      }
      throw new Error('unexpected YouTube fetch');
    });

    const result = await runLive(owner, jobId, fetchMock);
    expect(result.statusCode).toBe(200);
    expect(result.body.result).toMatchObject({
      ok: true,
      externalId: 'yt-real-video-1',
      url: null,
      publishedAt: null,
    });
    expect((result.body.job as any).status).toBe('SUCCEEDED');
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(result.body)).not.toContain('yt-access-token');
    expect(JSON.stringify(result.body)).not.toContain('yt-client-secret');
    const posts = await contentPosts(owner.workspaceId);
    expect(posts).toHaveLength(beforePosts.length + 1);
    expect(posts.some((post: any) => post.platform === 'youtube' && post.externalId === 'yt-real-video-1')).toBe(true);
  }, 120_000);

  it('publishes through TikTok direct post with status polling', async () => {
    vi.stubEnv('PUBLISHING_LIVE_ADAPTERS', '1');
    const beforePosts = await contentPosts(owner.workspaceId);
    const { jobId } = await createJob(owner, 'tiktok', {
      title: 'TikTok clip',
      visibility: 'public',
      mediaUrl: 'https://cdn.example.com/tiktok-clip.mp4',
    });

    let statusCalls = 0;
    const calls: Array<{ url: string; init: any }> = [];
    const fetchMock = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/v2/oauth/token/')) {
        return jsonResponse({ data: { access_token: 'tt-access-token', expires_in: 3600 } });
      }
      if (url.includes('/video/init/')) {
        const body = JSON.parse(init.body);
        expect(body.source_info).toEqual({
          source: 'PULL_FROM_URL',
          video_url: 'https://cdn.example.com/tiktok-clip.mp4',
        });
        expect(body.post_info.privacy_level).toBe('PUBLIC_TO_EVERYONE');
        return jsonResponse({ data: { publish_id: 'tt-publish-1' } });
      }
      if (url.includes('/status/fetch/')) {
        statusCalls += 1;
        expect(JSON.parse(init.body)).toEqual({ publish_id: 'tt-publish-1' });
        return statusCalls === 1
          ? jsonResponse({ data: { status: 'PROCESSING' } })
          : jsonResponse({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['tt-public-1'] } });
      }
      throw new Error('unexpected TikTok fetch');
    });

    const result = await runLive(owner, jobId, fetchMock);
    expect(result.statusCode).toBe(200);
    expect(result.body.result).toMatchObject({ ok: true, externalId: 'tt-public-1' });
    expect(statusCalls).toBe(2);
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(result.body)).not.toContain('tt-access-token');
    const posts = await contentPosts(owner.workspaceId);
    expect(posts).toHaveLength(beforePosts.length + 1);
    expect(posts.some((post: any) => post.platform === 'tiktok' && post.externalId === 'tt-public-1')).toBe(true);
  }, 120_000);

  it('publishes through Instagram Graph API only after the container is FINISHED', async () => {
    vi.stubEnv('PUBLISHING_LIVE_ADAPTERS', '1');
    const beforePosts = await contentPosts(owner.workspaceId);
    const { jobId } = await createJob(owner, 'instagram', {
      caption: 'Instagram clip',
      visibility: 'private',
      mediaUrl: 'https://cdn.example.com/instagram-clip.mp4',
    });

    let containerCalls = 0;
    const calls: Array<{ url: string; init: any }> = [];
    const fetchMock = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/oauth/access_token')) {
        return jsonResponse({ access_token: 'ig-refreshed-token', token_type: 'bearer' });
      }
      if (url.endsWith('/media')) {
        expect(init.body).toContain('media_type=VIDEO');
        expect(init.body).toContain('video_url=https%3A%2F%2Fcdn.example.com%2Finstagram-clip.mp4');
        expect(init.headers.Authorization).toBe('Bearer ig-refreshed-token');
        return jsonResponse({ id: 'ig-container-1' });
      }
      if (url.includes('ig-container-1')) {
        containerCalls += 1;
        return containerCalls === 1
          ? jsonResponse({ status: 'IN_PROGRESS', status_code: 200 })
          : jsonResponse({ status: 'FINISHED', status_code: 200 });
      }
      if (url.endsWith('/media_publish')) {
        expect(init.body).toContain('creation_id=ig-container-1');
        return jsonResponse({ id: 'ig-media-1', permalink_url: 'https://www.instagram.com/p/ig-media-1/' });
      }
      throw new Error('unexpected Instagram fetch');
    });

    const result = await runLive(owner, jobId, fetchMock);
    expect(result.statusCode).toBe(200);
    expect(result.body.result).toMatchObject({
      ok: true,
      externalId: 'ig-media-1',
      url: 'https://www.instagram.com/p/ig-media-1/',
    });
    expect(containerCalls).toBe(2);
    expect(calls).toHaveLength(5);
    expect(JSON.stringify(result.body)).not.toContain('ig-refreshed-token');
    const posts = await contentPosts(owner.workspaceId);
    expect(posts).toHaveLength(beforePosts.length + 1);
    expect(posts.some((post: any) => post.platform === 'instagram' && post.externalId === 'ig-media-1')).toBe(true);
  }, 120_000);

  it('refreshes the token once and retries a real 401 from the provider', async () => {
    vi.stubEnv('PUBLISHING_LIVE_ADAPTERS', '1');
    const { jobId } = await createJob(owner, 'tiktok', {
      mediaUrl: 'https://cdn.example.com/refresh-clip.mp4',
    });
    let tokenCalls = 0;
    let initCalls = 0;
    const calls: Array<{ url: string; init: any }> = [];
    const fetchMock = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/v2/oauth/token/')) {
        tokenCalls += 1;
        return jsonResponse({ data: { access_token: tokenCalls === 1 ? 'tt-old-token' : 'tt-new-token' } });
      }
      if (url.includes('/video/init/')) {
        initCalls += 1;
        expect(init.headers.Authorization).toBe(tokenCalls === 1 ? 'Bearer tt-old-token' : 'Bearer tt-new-token');
        if (initCalls === 1) return jsonResponse({ error: { code: 'invalid_token' } }, 401);
        return jsonResponse({ data: { publish_id: 'tt-refresh-publish' } });
      }
      if (url.includes('/status/fetch/')) {
        return jsonResponse({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['tt-refresh-public'] } });
      }
      throw new Error('unexpected TikTok fetch');
    });

    const result = await runLive(owner, jobId, fetchMock);
    expect(result.statusCode).toBe(200);
    expect(result.body.result).toMatchObject({ ok: true, externalId: 'tt-refresh-public' });
    expect(tokenCalls).toBe(2);
    expect(initCalls).toBe(2);
    expect(calls[3].init.headers.Authorization).toBe('Bearer tt-new-token');
  }, 120_000);

  it('never fabricates a post when a platform response is malformed', async () => {
    vi.stubEnv('PUBLISHING_LIVE_ADAPTERS', '1');
    const beforePosts = await contentPosts(owner.workspaceId);
    const { jobId } = await createJob(owner, 'tiktok', {
      mediaUrl: 'https://cdn.example.com/broken-clip.mp4',
    });
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('/v2/oauth/token/')) return jsonResponse({ data: { access_token: 'tt-token' } });
      if (url.includes('/video/init/')) return jsonResponse({ data: {} });
      throw new Error('unexpected TikTok fetch');
    });

    const result = await runLive(owner, jobId, fetchMock);
    expect(result.statusCode).toBe(502);
    expect((result.body as any).error.code).toBe('PLATFORM_RESPONSE_INVALID');
    expect(result.body.result).toMatchObject({ ok: false, externalId: null, url: null, publishedAt: null });
    expect((result.body.job as any).status).toBe('FAILED');
    expect(await contentPosts(owner.workspaceId)).toHaveLength(beforePosts.length);
  }, 120_000);

  it('redacts credentials from responses, job errors and audit data', async () => {
    vi.stubEnv('PUBLISHING_LIVE_ADAPTERS', '1');
    const secret = 'SUPER_SECRET_APP_SECRET';
    const { jobId } = await createJob(owner, 'instagram', {
      mediaUrl: 'https://cdn.example.com/redacted-clip.mp4',
    });
    const fetchMock = vi.fn(async (input: any) => {
      if (String(input).includes('/oauth/access_token')) {
        return jsonResponse({ error: { message: `invalid client_secret=${secret}` } }, 400);
      }
      throw new Error('unexpected Instagram fetch');
    });

    const result = await runLive(owner, jobId, fetchMock);
    expect(result.statusCode).toBe(502);
    expect((result.body as any).error.code).toBe('INVALID_CREDENTIALS');
    expect(JSON.stringify(result.body)).not.toContain(secret);

    const jobRow = await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.job.findFirst({ where: { id: jobId, workspaceId: owner.workspaceId } })
    ) as any;
    expect(jobRow.lastError).not.toContain(secret);

    for (const event of await auditEvents(owner.workspaceId, 'publishing_attempt_failed')) {
      expect(JSON.stringify(event.data ?? {})).not.toContain(secret);
    }
  }, 120_000);

  it('rejects private/loopback URLs and arbitrary filesystem paths before any fetch', async () => {
    vi.stubEnv('PUBLISHING_LIVE_ADAPTERS', '1');
    const noFetch = vi.fn(async () => { throw new Error('unexpected fetch'); });
    const beforePosts = await contentPosts(owner.workspaceId);

    const privateUrl = await createJob(owner, 'tiktok', {
      mediaUrl: 'http://127.0.0.1/internal.mp4',
    });
    const privateResult = await runLive(owner, privateUrl.jobId, noFetch);
    expect(privateResult.statusCode).toBe(400);
    expect((privateResult.body as any).error.code).toBe('INVALID_MEDIA_INPUT');

    const traversal = await createJob(owner, 'youtube', {
      mediaName: '../../etc/passwd',
    });
    const traversalResult = await runLive(owner, traversal.jobId, noFetch);
    expect(traversalResult.statusCode).toBe(400);
    expect((traversalResult.body as any).error.code).toBe('INVALID_MEDIA_INPUT');

    expect(noFetch).not.toHaveBeenCalled();
    expect(await contentPosts(owner.workspaceId)).toHaveLength(beforePosts.length);
  }, 120_000);

  it('re-checks approval after the network call and records no post if it was revoked', async () => {
    vi.stubEnv('PUBLISHING_LIVE_ADAPTERS', '1');
    const beforePosts = await contentPosts(owner.workspaceId);
    const { jobId, approvalId } = await createJob(owner, 'tiktok', {
      mediaUrl: 'https://cdn.example.com/revoked-clip.mp4',
    });
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('/v2/oauth/token/')) {
        await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
          tx.approval.update({
            where: { id: approvalId, workspaceId: owner.workspaceId },
            data: { status: 'rejected' },
          })
        );
        return jsonResponse({ data: { access_token: 'tt-token' } });
      }
      if (url.includes('/video/init/')) return jsonResponse({ data: { publish_id: 'tt-revoked' } });
      if (url.includes('/status/fetch/')) return jsonResponse({ data: { status: 'PUBLISH_COMPLETE' } });
      throw new Error('unexpected TikTok fetch');
    });

    const result = await runLive(owner, jobId, fetchMock);
    expect(result.statusCode).toBe(409);
    expect((result.body as any).error.code).toBe('APPROVAL_REQUIRED');
    expect((result.body.job as any).status).toBe('FAILED');
    expect(await contentPosts(owner.workspaceId)).toHaveLength(beforePosts.length);
  }, 120_000);

  it('keeps live publishing and settlement strictly workspace-scoped', async () => {
    vi.stubEnv('PUBLISHING_LIVE_ADAPTERS', '1');
    const { jobId } = await createJob(owner, 'tiktok', {
      mediaUrl: 'https://cdn.example.com/scoped-clip.mp4',
    });
    const beforePosts = await contentPosts(owner.workspaceId);
    const outsiderFetch = vi.fn(async () => { throw new Error('unexpected fetch'); });

    const processed = await processPublishingJob(outsider.workspaceId, jobId, 'outsider', {
      workerId: 'outsider',
      fetch: outsiderFetch as any,
      lookup: PUBLIC_LOOKUP,
    } as any);
    expect(processed.statusCode).toBe(404);
    expect(outsiderFetch).not.toHaveBeenCalled();

    const forged = await settleRealPublishingSuccess(
      outsider.workspaceId,
      jobId,
      { externalId: 'forged-outsider-id' },
      'outsider',
    );
    expect(forged.statusCode).toBe(404);
    expect(await contentPosts(owner.workspaceId)).toHaveLength(beforePosts.length);
  }, 120_000);
});

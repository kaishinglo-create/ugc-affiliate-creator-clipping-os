import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { classifyPublishingFailure, publishingApprovalEntityId } from '../src/publishing.js';

const ENTITY_TYPE = 'asset_version';

async function signup(app: any, prefix: string) {
  const suffix = randomUUID();
  const email = `${prefix}-${suffix.slice(0, 12)}@x.com`;
  const workspaceSlug = `${prefix}-${suffix.slice(0, 12)}`;
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
  return {
    workspaceId: created.json().workspace.id,
    headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': created.json().workspace.id },
  };
}

describe('publishing adapters, approval gate and durable queue', () => {
  let app: any;
  let owner: { workspaceId: string; headers: Record<string, string> };
  let outsider: { workspaceId: string; headers: Record<string, string> };

  beforeAll(async () => {
    app = await buildServer();
    owner = await signup(app, 'pub');
    outsider = await signup(app, 'pubout');
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function createApproval(
    ctx: { workspaceId: string; headers: Record<string, string> },
    platform: string,
    entityId: string,
    idempotencyKey: string,
    decision: 'pending' | 'approved' | 'rejected' = 'approved',
    overrides: { entityType?: string; approvalEntityId?: string } = {},
  ): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/approvals',
      headers: ctx.headers,
      payload: {
        entityType: overrides.entityType ?? 'publishing',
        entityId: overrides.approvalEntityId ?? publishingApprovalEntityId(platform as any, ENTITY_TYPE, entityId, idempotencyKey),
      },
    });
    expect(created.statusCode).toBe(201);
    const approvalId = created.json().approval.id;
    if (decision !== 'pending') {
      const decided = await app.inject({
        method: 'POST',
        url: `/api/approvals/${approvalId}/decide`,
        headers: ctx.headers,
        payload: { status: decision, reason: 'publishing test' },
      });
      expect(decided.statusCode).toBe(200);
    }
    return approvalId;
  }

  function enqueue(ctx: { headers: Record<string, string> }, body: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/publishing/jobs', headers: ctx.headers, payload: body });
  }

  function processJob(ctx: { headers: Record<string, string> }, jobId: string) {
    return app.inject({ method: 'POST', url: `/api/publishing/jobs/${jobId}/process`, headers: ctx.headers, payload: {} });
  }

  async function publishingJobCount(workspaceId: string): Promise<number> {
    return withWorkspaceTransaction(workspaceId, (tx: any) =>
      tx.job.count({ where: { workspaceId, category: 'PUBLISHING' } })
    );
  }

  async function contentPostCount(workspaceId: string): Promise<number> {
    return withWorkspaceTransaction(workspaceId, (tx: any) =>
      tx.contentPost.count({ where: { workspaceId } })
    );
  }

  async function auditCount(workspaceId: string, type: string): Promise<number> {
    return withWorkspaceTransaction(workspaceId, (tx: any) =>
      tx.auditEvent.count({ where: { workspaceId, type } })
    );
  }

  it('reports exact NOT_CONFIGURED, makes no network call and fabricates no post', async () => {
    const adapters = await app.inject({ method: 'GET', url: '/api/publishing/adapters', headers: owner.headers });
    expect(adapters.statusCode).toBe(200);
    expect(adapters.json().adapters).toHaveLength(3);
    for (const adapter of adapters.json().adapters) {
      expect(adapter.status).toBe('NOT_CONFIGURED');
      expect(adapter.liveAdapter).toBe(false);
      expect(adapter.credentials.present).toBe(false);
      expect(adapter.contract.api).toBeTruthy();
    }

    const key = `not-configured-${randomUUID()}`;
    const entityId = `clip-${randomUUID()}`;
    await createApproval(owner, 'youtube', entityId, key);
    const created = await enqueue(owner, {
      platform: 'youtube', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().job.id;

    const beforePosts = await contentPostCount(owner.workspaceId);
    const fetchSpy = vi.spyOn(globalThis as any, 'fetch');
    try {
      const processed = await processJob(owner, jobId);
      expect(processed.statusCode).toBe(503);
      expect(processed.json().error.code).toBe('NOT_CONFIGURED');
      expect(processed.json().result).toMatchObject({ ok: false, externalId: null, url: null, publishedAt: null });
      expect(processed.json().job.status).toBe('RETRY_WAIT');
      expect(processed.json().job.attempts).toBe(1);
      expect(processed.json().adapter.status).toBe('NOT_CONFIGURED');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }

    expect(await contentPostCount(owner.workspaceId)).toBe(beforePosts);
    expect(await auditCount(owner.workspaceId, 'publishing_job_enqueued')).toBeGreaterThan(0);
    expect(await auditCount(owner.workspaceId, 'publishing_attempt')).toBeGreaterThan(0);
    expect(await auditCount(owner.workspaceId, 'publishing_attempt_failed')).toBeGreaterThan(0);
    expect(await auditCount(owner.workspaceId, 'publishing_job_succeeded')).toBe(0);
  }, 120_000);

  it('refuses every unapproved, rejected or forged approval and creates no job', async () => {
    const before = await publishingJobCount(owner.workspaceId);
    const baseEntityId = `clip-${randomUUID()}`;

    const noApprovalKey = `none-${randomUUID()}`;
    const none = await enqueue(owner, {
      platform: 'tiktok', entityType: ENTITY_TYPE, entityId: baseEntityId, idempotencyKey: noApprovalKey,
    });
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe('APPROVAL_REQUIRED');

    const pendingKey = `pending-${randomUUID()}`;
    const pendingId = await createApproval(owner, 'tiktok', baseEntityId, pendingKey, 'pending');
    const pending = await enqueue(owner, {
      platform: 'tiktok', entityType: ENTITY_TYPE, entityId: baseEntityId,
      idempotencyKey: pendingKey, approvalId: pendingId,
    });
    expect(pending.statusCode).toBe(409);
    expect(pending.json().error.code).toBe('APPROVAL_REQUIRED');

    const rejectedKey = `rejected-${randomUUID()}`;
    const rejectedId = await createApproval(owner, 'tiktok', baseEntityId, rejectedKey, 'rejected');
    const rejected = await enqueue(owner, {
      platform: 'tiktok', entityType: ENTITY_TYPE, entityId: baseEntityId,
      idempotencyKey: rejectedKey, approvalId: rejectedId,
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe('APPROVAL_REQUIRED');

    const wrongTypeKey = `wrongtype-${randomUUID()}`;
    await createApproval(owner, 'tiktok', baseEntityId, wrongTypeKey, 'approved', { entityType: 'workflow_step' });
    const wrongType = await enqueue(owner, {
      platform: 'tiktok', entityType: ENTITY_TYPE, entityId: baseEntityId, idempotencyKey: wrongTypeKey,
    });
    expect(wrongType.statusCode).toBe(409);
    expect(wrongType.json().error.code).toBe('APPROVAL_REQUIRED');

    const mismatchedKey = `mismatch-${randomUUID()}`;
    await createApproval(owner, 'tiktok', `other-${baseEntityId}`, mismatchedKey);
    const mismatched = await enqueue(owner, {
      platform: 'tiktok', entityType: ENTITY_TYPE, entityId: baseEntityId, idempotencyKey: mismatchedKey,
    });
    expect(mismatched.statusCode).toBe(409);
    expect(mismatched.json().error.code).toBe('APPROVAL_REQUIRED');

    const foreignKey = `foreign-${randomUUID()}`;
    const foreignApprovalId = await createApproval(
      outsider, 'tiktok', baseEntityId, foreignKey, 'approved',
    );
    const foreign = await enqueue(owner, {
      platform: 'tiktok', entityType: ENTITY_TYPE, entityId: baseEntityId,
      idempotencyKey: foreignKey, approvalId: foreignApprovalId,
    });
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json().error.code).toBe('APPROVAL_REQUIRED');

    expect(await publishingJobCount(owner.workspaceId)).toBe(before);
    expect(await contentPostCount(owner.workspaceId)).toBe(0);
  }, 120_000);

  it('is idempotent per workspace/key and rejects a conflicting reuse of a key', async () => {
    const key = `idem-${randomUUID()}`;
    const entityId = `clip-${randomUUID()}`;
    await createApproval(owner, 'instagram', entityId, key);
    const first = await enqueue(owner, {
      platform: 'instagram', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
      options: { caption: 'first caption' },
    });
    expect(first.statusCode).toBe(201);
    const second = await enqueue(owner, {
      platform: 'instagram', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
      options: { caption: 'different caption' },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().job.id).toBe(first.json().job.id);
    expect(second.json().duplicate).toBe(true);
    expect(second.json().job.status).toBe('QUEUED');

    const conflictingKey = key;
    const conflictingEntity = `other-${entityId}`;
    await createApproval(owner, 'youtube', conflictingEntity, conflictingKey);
    const conflict = await enqueue(owner, {
      platform: 'youtube', entityType: ENTITY_TYPE, entityId: conflictingEntity, idempotencyKey: conflictingKey,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  }, 120_000);

  it('classifies retries and dead-letters after maxAttempts without publishing', async () => {
    expect(classifyPublishingFailure('NOT_CONFIGURED')).toEqual({ retryable: true, terminal: false });
    expect(classifyPublishingFailure('ADAPTER_NOT_IMPLEMENTED')).toEqual({ retryable: false, terminal: true });

    const key = `retry-${randomUUID()}`;
    const entityId = `clip-${randomUUID()}`;
    await createApproval(owner, 'youtube', entityId, key);
    const created = await enqueue(owner, {
      platform: 'youtube', entityType: ENTITY_TYPE, entityId, idempotencyKey: key, maxAttempts: 2,
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().job.id;
    const beforePosts = await contentPostCount(owner.workspaceId);
    const attemptsBefore = await auditCount(owner.workspaceId, 'publishing_attempt');
    const failuresBefore = await auditCount(owner.workspaceId, 'publishing_attempt_failed');

    const first = await processJob(owner, jobId);
    expect(first.statusCode).toBe(503);
    expect(first.json().job.status).toBe('RETRY_WAIT');
    expect(first.json().job.attempts).toBe(1);
    expect(new Date(first.json().job.runAt).getTime()).toBeGreaterThan(Date.now());

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await processJob(owner, jobId);
    expect(second.statusCode).toBe(503);
    expect(second.json().job.status).toBe('DEAD_LETTER');
    expect(second.json().job.attempts).toBe(2);

    expect(await auditCount(owner.workspaceId, 'publishing_attempt')).toBe(attemptsBefore + 2);
    expect(await auditCount(owner.workspaceId, 'publishing_attempt_failed')).toBe(failuresBefore + 2);
    expect(await auditCount(owner.workspaceId, 'publishing_job_succeeded')).toBe(0);
    expect(await contentPostCount(owner.workspaceId)).toBe(beforePosts);
  }, 120_000);

  it('keeps jobs and approvals strictly workspace-scoped', async () => {
    const key = `scope-${randomUUID()}`;
    const entityId = `clip-${randomUUID()}`;
    const approvalId = await createApproval(owner, 'tiktok', entityId, key);
    const created = await enqueue(owner, {
      platform: 'tiktok', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().job.id;

    const list = await app.inject({ method: 'GET', url: '/api/publishing/jobs', headers: outsider.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().jobs.map((j: any) => j.id)).not.toContain(jobId);

    const read = await app.inject({ method: 'GET', url: `/api/publishing/jobs/${jobId}`, headers: outsider.headers });
    expect(read.statusCode).toBe(404);
    const process = await processJob(outsider, jobId);
    expect(process.statusCode).toBe(404);

    const borrowed = await enqueue(outsider, {
      platform: 'tiktok', entityType: ENTITY_TYPE, entityId, idempotencyKey: key, approvalId,
    });
    expect(borrowed.statusCode).toBe(409);
    expect(borrowed.json().error.code).toBe('APPROVAL_REQUIRED');

    // Even an identical, approved tuple in another workspace creates a
    // different job; it cannot touch the owner's row.
    await createApproval(outsider, 'tiktok', entityId, key);
    const own = await enqueue(outsider, {
      platform: 'tiktok', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
    });
    expect(own.statusCode).toBe(201);
    expect(own.json().job.id).not.toBe(jobId);

    const ownerJob = await app.inject({ method: 'GET', url: `/api/publishing/jobs/${jobId}`, headers: owner.headers });
    expect(ownerJob.statusCode).toBe(200);
    expect(ownerJob.json().job.status).toBe('QUEUED');
  }, 120_000);

  it('reports CREDENTIALS_ONLY but still refuses to fake a publication', async () => {
    vi.stubEnv('YOUTUBE_CLIENT_ID', 'client-id');
    vi.stubEnv('YOUTUBE_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('YOUTUBE_REFRESH_TOKEN', 'refresh-token');
    try {
      const adapters = await app.inject({ method: 'GET', url: '/api/publishing/adapters', headers: owner.headers });
      expect(adapters.statusCode).toBe(200);
      const youtube = adapters.json().adapters.find((a: any) => a.platform === 'youtube');
      expect(youtube.status).toBe('CREDENTIALS_ONLY');
      expect(youtube.liveAdapter).toBe(false);
      expect(JSON.stringify(adapters.json())).not.toContain('client-secret');
      expect(JSON.stringify(adapters.json())).not.toContain('refresh-token');

      const key = `credentials-${randomUUID()}`;
      const entityId = `clip-${randomUUID()}`;
      await createApproval(owner, 'youtube', entityId, key);
      const created = await enqueue(owner, {
        platform: 'youtube', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
      });
      expect(created.statusCode).toBe(201);
      const beforePosts = await contentPostCount(owner.workspaceId);
      const processed = await processJob(owner, created.json().job.id);
      expect(processed.statusCode).toBe(501);
      expect(processed.json().error.code).toBe('ADAPTER_NOT_IMPLEMENTED');
      expect(processed.json().result.externalId).toBeNull();
      expect(processed.json().job.status).toBe('FAILED');
      expect(await contentPostCount(owner.workspaceId)).toBe(beforePosts);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 120_000);

  it('blocks generic job routes from settling a publishing job without an upload', async () => {
    const key = `guard-${randomUUID()}`;
    const entityId = `clip-${randomUUID()}`;
    await createApproval(owner, 'youtube', entityId, key);
    const created = await enqueue(owner, {
      platform: 'youtube', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().job.id;

    for (const action of ['complete', 'fail', 'cancel', 'requeue', 'retry', 'resume']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/jobs/${jobId}/${action}`,
        headers: owner.headers,
        payload: { reason: 'generic route bypass attempt' },
      });
      expect(response.statusCode, `${action} must be blocked`).toBe(409);
      expect(response.json().error).toBe('USE_PUBLISHING_PROCESS_ENDPOINT');
    }

    const after = await app.inject({
      method: 'GET',
      url: `/api/publishing/jobs/${jobId}`,
      headers: owner.headers,
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().job.status).toBe('QUEUED');
    expect(await auditCount(owner.workspaceId, 'publishing_job_succeeded')).toBe(0);
    expect(await contentPostCount(owner.workspaceId)).toBe(0);
  }, 120_000);
});

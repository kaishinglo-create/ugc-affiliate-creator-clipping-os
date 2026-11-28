import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import {
  publishingApprovalEntityIdForBinding,
  publishingApprovalTarget,
  publishingBindingHash,
  publishingLocalTimeToUtc,
  recoverStalePublishingSchedules,
  enqueueDuePublishingSchedules,
} from '../src/publishing.js';
import { PLATFORM_FORMATS, executeLivePublishing } from '../src/publishing-adapters.js';
import { resolvePublishingCredentials } from '../src/api-integration-center/service.js';
import {
  affiliateCommissionCents,
  appendUtm,
  normalizeUtm,
  summarizeAffiliateRevenue,
} from '../src/affiliate.js';

const ENTITY_TYPE = 'asset_version';

async function signup(app: any, prefix: string) {
  const suffix = randomUUID().slice(0, 12);
  const email = `${prefix}-${suffix}@example.test`;
  const created = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: {
      email,
      password: 'password1234',
      workspaceName: prefix,
      workspaceSlug: `${prefix}-${suffix}`,
    },
  });
  expect(created.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'password1234' },
  });
  expect(login.statusCode).toBe(200);
  const workspaceId = created.json().workspace.id;
  return { workspaceId, headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId } };
}

type Ctx = { workspaceId: string; headers: Record<string, string> };

describe('Phase H pure guards', () => {
  it('encodes account, checksum, format and idempotency key into a versioned approval binding', () => {
    const base = {
      platform: 'youtube',
      entityType: ENTITY_TYPE,
      entityId: `clip-${randomUUID()}`,
      idempotencyKey: `bind-${randomUUID()}`,
    };
    const target = publishingApprovalTarget({
      workspaceId: 'ws', actor: null,
      ...base,
      accountKey: 'youtube-main',
      checksum: 'sha256:' + 'a'.repeat(64),
      options: { format: 'shorts' },
    });
    expect(target).not.toBeNull();
    const changed = publishingApprovalTarget({
      workspaceId: 'ws', actor: null,
      ...base,
      accountKey: 'youtube-main',
      checksum: 'sha256:' + 'a'.repeat(64),
      options: { format: 'standard' },
    });
    expect(changed?.entityId).not.toBe(target?.entityId);
    expect(publishingApprovalEntityIdForBinding({
      platform: 'youtube',
      accountKey: null,
      entityType: ENTITY_TYPE,
      entityId: base.entityId,
      checksum: null,
      params: {},
      idempotencyKey: base.idempotencyKey,
    })).not.toBe(target?.entityId);
    expect(publishingBindingHash({
      platform: 'youtube',
      accountKey: 'youtube-main',
      entityType: ENTITY_TYPE,
      entityId: base.entityId,
      checksum: 'sha256:' + 'a'.repeat(64),
      params: { format: 'shorts' },
      idempotencyKey: base.idempotencyKey,
    })).not.toBe(publishingBindingHash({
      platform: 'youtube',
      accountKey: 'youtube-main',
      entityType: ENTITY_TYPE,
      entityId: base.entityId,
      checksum: 'sha256:' + 'a'.repeat(64),
      params: { format: 'standard' },
      idempotencyKey: base.idempotencyKey,
    }));
  });

  it('rejects unsupported platform formats before any network call', async () => {
    expect(PLATFORM_FORMATS.youtube).toContain('shorts');
    expect(PLATFORM_FORMATS.instagram).toContain('reels');
    const fetchSpy = vi.fn(async () => { throw new Error('network must not be used'); });
    const result = await executeLivePublishing({
      platform: 'youtube',
      workspaceId: 'ws',
      jobId: 'job',
      idempotencyKey: 'key',
      options: { format: 'reels' },
      env: {},
    }, { fetch: fetchSpy as any });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_FORMAT');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps missing commissions null and counts only real supplied values', () => {
    expect(normalizeUtm({ utm_source: ' newsletter ', utm_medium: 'email' })).toEqual({
      utm_source: 'newsletter',
      utm_medium: 'email',
    });
    expect(appendUtm('https://example.com/p?a=1', { utm_source: 'newsletter' }))
      .toBe('https://example.com/p?a=1&utm_source=newsletter');
    expect(appendUtm('http://example.com/p', { utm_source: 'x' })).toBeNull();
    expect(affiliateCommissionCents({ id: 'c', clickId: 'k', amountCents: 100, status: 'paid', convertedAt: new Date() }))
      .toBeNull();
    expect(affiliateCommissionCents({
      id: 'c2', clickId: 'k', amountCents: 100, status: 'paid', convertedAt: new Date(), commissionCents: 25,
    })).toBe(25);

    const clicks = [{
      id: 'click-1', contentId: null, offerId: 'offer', clickedAt: new Date(),
      linkId: 'link-1', campaignId: 'campaign-1', creatorId: 'creator-1',
      platform: 'youtube', utmSource: 'newsletter', externalEventId: 'click-event',
    }];
    const summary = summarizeAffiliateRevenue({
      clicks,
      conversions: [{
        id: 'conv-1', clickId: 'click-1', amountCents: 1000, status: 'approved', convertedAt: new Date(),
        commissionCents: 250, externalEventId: 'click-event',
      }],
      links: [{ id: 'link-1', token: 'tok', offerId: 'offer', destinationUrl: 'https://example.com', disclosureText: 'Affiliate disclosure' }],
    });
    expect(summary.totalCommissionCents).toBe(250);
    expect(summary.byPlatform[0]).toMatchObject({ key: 'youtube', conversions: 1, revenueCents: 1000, commissionCents: 250 });
    expect(summary.disclosedClicks).toBe(1);
    expect(summary.duplicateExternalEvents).toBe(0);
    expect(summarizeAffiliateRevenue({
      clicks: [...clicks, { ...clicks[0], id: 'click-2' }], conversions: [],
    }).duplicateExternalEvents).toBe(1);

    const noCommission = summarizeAffiliateRevenue({
      clicks,
      conversions: [{ id: 'conv-2', clickId: 'click-1', amountCents: 1000, status: 'paid', convertedAt: new Date() }],
    });
    expect(noCommission.totalCommissionCents).toBeNull();
    expect(noCommission.byCreator[0]?.commissionCents).toBeNull();
  });
});

describe('Phase H integration guards', () => {
  let app: any;
  let owner: Ctx;
  let outsider: Ctx;

  beforeAll(async () => {
    app = await buildServer();
    owner = await signup(app, 'phowner');
    outsider = await signup(app, 'phoutside');
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function requestApproval(ctx: Ctx, body: Record<string, unknown>) {
    const created = await app.inject({
      method: 'POST', url: '/api/publishing/approvals', headers: ctx.headers, payload: body,
    });
    expect(created.statusCode).toBe(201);
    const approval = created.json().approval;
    expect(approval.status).toBe('pending');
    return approval.id as string;
  }

  async function decide(ctx: Ctx, approvalId: string, status: 'approved' | 'rejected' = 'approved') {
    const decided = await app.inject({
      method: 'POST', url: `/api/approvals/${approvalId}/decide`, headers: ctx.headers,
      payload: { status, reason: 'phase h regression' },
    });
    expect(decided.statusCode).toBe(200);
    return decided.json().approval;
  }

  async function enqueue(ctx: Ctx, body: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/publishing/jobs', headers: ctx.headers, payload: body });
  }

  it('requires a human decision and re-binds approvals when target or parameters change', async () => {
    const accountKey = `acct-${randomUUID().slice(0, 8)}`;
    for (const key of [accountKey, `${accountKey}-2`]) {
      const account = await app.inject({
        method: 'POST', url: '/api/publishing/accounts', headers: owner.headers,
        payload: { platform: 'youtube', accountKey: key, displayName: 'Test channel' },
      });
      expect(account.statusCode).toBe(200);
    }

    const entityId = `clip-${randomUUID()}`;
    const key = `gate-${randomUUID()}`;
    const approvalId = await requestApproval(owner, {
      platform: 'youtube', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
      accountKey, options: { format: 'shorts' },
    });

    const beforeDecision = await enqueue(owner, {
      platform: 'youtube', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
      accountKey, options: { format: 'shorts' }, approvalId,
    });
    expect(beforeDecision.statusCode).toBe(409);
    expect(beforeDecision.json().error.code).toBe('APPROVAL_REQUIRED');

    await decide(owner, approvalId);

    const changedFormat = await enqueue(owner, {
      platform: 'youtube', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
      accountKey, options: { format: 'standard' }, approvalId,
    });
    expect(changedFormat.statusCode).toBe(409);
    expect(changedFormat.json().error.code).toBe('APPROVAL_REQUIRED');

    const changedAccount = await enqueue(owner, {
      platform: 'youtube', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
      accountKey: `${accountKey}-2`, options: { format: 'shorts' }, approvalId,
    });
    expect(changedAccount.statusCode).toBe(409);

    const foreign = await enqueue(outsider, {
      platform: 'youtube', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
      options: { format: 'shorts' }, approvalId,
    });
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json().error.code).toBe('APPROVAL_REQUIRED');

    const valid = await enqueue(owner, {
      platform: 'youtube', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
      accountKey, options: { format: 'shorts' }, approvalId,
    });
    expect(valid.statusCode).toBe(201);
    expect(valid.json().job.status).toBe('QUEUED');
  }, 120_000);

  it('enforces kill switch and re-checks the gate before dead-letter retry', async () => {
    const accountKey = `retry-${randomUUID().slice(0, 8)}`;
    const account = await app.inject({
      method: 'POST', url: '/api/publishing/accounts', headers: owner.headers,
      payload: { platform: 'tiktok', accountKey },
    });
    expect(account.statusCode).toBe(200);
    const entityId = `clip-${randomUUID()}`;
    const key = `retry-${randomUUID()}`;
    const approvalId = await requestApproval(owner, {
      platform: 'tiktok', entityType: ENTITY_TYPE, entityId, idempotencyKey: key, accountKey,
    });
    await decide(owner, approvalId);
    const queued = await enqueue(owner, {
      platform: 'tiktok', entityType: ENTITY_TYPE, entityId, idempotencyKey: key, accountKey, approvalId,
    });
    expect(queued.statusCode).toBe(201);
    const jobId = queued.json().job.id;

    await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.job.update({ where: { id: jobId, workspaceId: owner.workspaceId }, data: { status: 'DEAD_LETTER' } })
    );

    const switchOn = await app.inject({
      method: 'POST', url: '/api/security/kill-switch/activate', headers: owner.headers,
      payload: { reason: 'phase h regression' },
    });
    expect(switchOn.statusCode).toBe(200);
    const blocked = await app.inject({
      method: 'POST', url: `/api/publishing/jobs/${jobId}/retry`, headers: owner.headers, payload: {},
    });
    expect(blocked.statusCode).toBe(409);
    const switchOff = await app.inject({
      method: 'POST', url: '/api/security/kill-switch/deactivate', headers: owner.headers, payload: {},
    });
    expect(switchOff.statusCode).toBe(200);

    const retried = await app.inject({
      method: 'POST', url: `/api/publishing/jobs/${jobId}/retry`, headers: owner.headers, payload: {},
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().job.status).toBe('QUEUED');

    await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.approval.update({ where: { id: approvalId }, data: { revokedAt: new Date() } })
    );
    await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.job.update({ where: { id: jobId, workspaceId: owner.workspaceId }, data: { status: 'DEAD_LETTER' } })
    );
    const revoked = await app.inject({
      method: 'POST', url: `/api/publishing/jobs/${jobId}/retry`, headers: owner.headers, payload: {},
    });
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json().error.code).toBe('APPROVAL_REQUIRED');
  }, 120_000);

  it('enqueues a due plan once and recovers a plan that crashed before settlement', async () => {
    expect(publishingLocalTimeToUtc('2099-01-01T12:00', 'Europe/Berlin')).toBeInstanceOf(Date);
    expect(publishingLocalTimeToUtc('2099-01-01T12:00', 'Not/AZone')).toBeNull();

    const entityId = `clip-${randomUUID()}`;
    const key = `schedule-${randomUUID()}`;
    const approvalId = await requestApproval(owner, {
      platform: 'instagram', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
      options: { format: 'reels' },
    });
    await decide(owner, approvalId);
    const created = await app.inject({
      method: 'POST', url: '/api/publishing/schedules', headers: owner.headers,
      payload: {
        platform: 'instagram', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
        approvalId, options: { format: 'reels' },
        localTime: '2099-01-01T12:00', timezone: 'Europe/Berlin',
      },
    });
    expect(created.statusCode).toBe(201);
    const scheduleId = created.json().schedule.id;
    const duplicate = await app.inject({
      method: 'POST', url: '/api/publishing/schedules', headers: owner.headers,
      payload: {
        platform: 'instagram', entityType: ENTITY_TYPE, entityId, idempotencyKey: key,
        approvalId, options: { format: 'reels' },
        localTime: '2099-01-01T12:00', timezone: 'Europe/Berlin',
      },
    });
    expect(duplicate.statusCode).toBe(409);

    await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.publishingSchedule.update({
        where: { id: scheduleId, workspaceId: owner.workspaceId },
        data: { runAt: new Date(Date.now() - 60_000) },
      })
    );
    expect(await enqueueDuePublishingSchedules(owner.workspaceId)).toBe(1);
    expect(await enqueueDuePublishingSchedules(owner.workspaceId)).toBe(0);
    const jobs = await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.job.count({ where: { workspaceId: owner.workspaceId, idempotencyKey: key } })
    );
    expect(jobs).toBe(1);

    const crashKey = `crash-${randomUUID()}`;
    const crashEntityId = `clip-${randomUUID()}`;
    const crashApproval = await requestApproval(owner, {
      platform: 'youtube', entityType: ENTITY_TYPE, entityId: crashEntityId, idempotencyKey: crashKey,
    });
    await decide(owner, crashApproval);
    const crashed = await app.inject({
      method: 'POST', url: '/api/publishing/schedules', headers: owner.headers,
      payload: {
        platform: 'youtube', entityType: ENTITY_TYPE, entityId: crashEntityId,
        idempotencyKey: crashKey, approvalId: crashApproval,
        localTime: '2099-01-01T12:00', timezone: 'UTC',
      },
    });
    expect(crashed.statusCode).toBe(201);
    await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.publishingSchedule.update({
        where: { id: crashed.json().schedule.id },
        data: { status: 'ENQUEUING', lastRunAt: new Date(Date.now() - 20 * 60_000) },
      })
    );
    expect(await recoverStalePublishingSchedules(owner.workspaceId)).toBeGreaterThanOrEqual(1);
    const recovered: any = await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.publishingSchedule.findUnique({ where: { id: crashed.json().schedule.id } })
    );
    expect(recovered.status).toBe('PENDING');
  }, 120_000);

  it('fails closed when a workspace credential cannot be decrypted', async () => {
    await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.apiCredential.upsert({
        where: { workspaceId_providerKey: { workspaceId: owner.workspaceId, providerKey: 'youtube_google' } },
        create: {
          workspaceId: owner.workspaceId, providerKey: 'youtube_google', kind: 'OAUTH',
          ciphertext: 'tampered', iv: 'tampered', tag: 'tampered', hint: 'none',
        },
        update: { ciphertext: 'tampered', iv: 'tampered', tag: 'tampered' },
      })
    );
    const resolved = await resolvePublishingCredentials(owner.workspaceId, 'youtube');
    expect(resolved.blocked).toBe(true);
    expect(resolved.source).toBe('none');
    expect(resolved.env).toEqual({});

    const adapters = await app.inject({ method: 'GET', url: '/api/publishing/adapters', headers: owner.headers });
    const youtube = adapters.json().adapters.find((a: any) => a.platform === 'youtube');
    expect(youtube.credentialError).toBe('CREDENTIAL_DECRYPT_FAILED');
    expect(youtube.status).toBe('NOT_CONFIGURED');
    expect(youtube.credentials.present).toBe(false);
  }, 120_000);

  it('deduplicates clicks/conversions and reports truth-only revenue per dimension', async () => {
    const token = `tok-${randomUUID().slice(0, 8)}`;
    const link = await app.inject({
      method: 'POST', url: '/api/affiliate/links', headers: owner.headers,
      payload: {
        token, offerId: 'offer-1', destinationUrl: 'https://example.com/product?x=1',
        campaignId: 'campaign-1', creatorId: 'creator-1', disclosureText: 'Paid partnership',
      },
    });
    expect(link.statusCode).toBe(201);

    const eventId = `event-${randomUUID()}`;
    const clickUrl = `/api/affiliate/links/${token}/click?workspaceId=${owner.workspaceId}` +
      `&utm_source=newsletter&utm_medium=email&contentId=clip-1&postId=post-1&platform=youtube&externalEventId=${eventId}`;
    const firstClick = await app.inject({ method: 'GET', url: clickUrl, payload: {} });
    expect(firstClick.statusCode).toBe(302);
    expect(firstClick.headers.location).toContain('utm_source=newsletter');
    expect(firstClick.headers['x-affiliate-disclosure']).toBe('required');
    const secondClick = await app.inject({ method: 'GET', url: clickUrl, payload: {} });
    expect(secondClick.statusCode).toBe(302);

    const storedClick: any = await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.affiliateClick.findFirst({ where: { workspaceId: owner.workspaceId, externalEventId: eventId } })
    );
    expect(storedClick).not.toBeNull();
    const conversionBody = {
      clickId: storedClick.id,
      amountCents: 1000,
      commissionCents: 250,
      externalEventId: eventId,
    };
    const firstConversion = await app.inject({
      method: 'POST', url: '/api/affiliate/conversions', headers: owner.headers, payload: conversionBody,
    });
    expect(firstConversion.statusCode).toBe(201);
    const duplicateConversion = await app.inject({
      method: 'POST', url: '/api/affiliate/conversions', headers: owner.headers, payload: conversionBody,
    });
    expect(duplicateConversion.statusCode).toBe(200);
    expect(duplicateConversion.json().duplicate).toBe(true);

    const conversionId = firstConversion.json().conversion.id;
    const approved = await app.inject({
      method: 'POST', url: `/api/affiliate/conversions/${conversionId}/payout`, headers: owner.headers,
      payload: { action: 'approve', reference: 'pay-1' },
    });
    expect(approved.statusCode).toBe(200);

    const revenue = await app.inject({ method: 'GET', url: '/api/affiliate/revenue', headers: owner.headers });
    expect(revenue.statusCode).toBe(200);
    expect(revenue.json().revenue.totalCommissionCents).toBe(250);
    expect(revenue.json().revenue.byPlatform).toEqual([expect.objectContaining({
      key: 'youtube', conversions: 1, commissionCents: 250,
    })]);
    expect(revenue.json().revenue.byUtmSource).toEqual([expect.objectContaining({
      key: 'newsletter', conversions: 1,
    })]);

    const clicks = await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.affiliateClick.count({ where: { workspaceId: owner.workspaceId, externalEventId: eventId } })
    );
    const conversions = await withWorkspaceTransaction(owner.workspaceId, (tx: any) =>
      tx.affiliateConversion.count({ where: { workspaceId: owner.workspaceId, externalEventId: eventId } })
    );
    expect(clicks).toBe(1);
    expect(conversions).toBe(1);

    const foreignRevenue = await app.inject({ method: 'GET', url: '/api/affiliate/revenue', headers: outsider.headers });
    expect(foreignRevenue.json().revenue.totalCommissionCents).toBeNull();
    const foreignLinks = await app.inject({ method: 'GET', url: '/api/affiliate/links', headers: outsider.headers });
    expect(foreignLinks.json().links.some((l: any) => l.token === token)).toBe(false);
    const foreignSchedules = await app.inject({ method: 'GET', url: '/api/publishing/schedules', headers: outsider.headers });
    expect(foreignSchedules.json().schedules).toEqual([]);
  }, 120_000);

  it('keeps H.5 read models in the existing views and separates verification states', async () => {
    const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    for (const testId of [
      'h5-publishing-queue', 'h5-publishing-schedules', 'h5-publishing-approvals',
      'h5-publishing-adapters', 'h5-affiliate-revenue', 'h5-affiliate-links', 'h5-verification',
    ]) {
      expect(source).toContain(`"${testId}"`);
    }
    expect(source).toContain('LOCAL_VERIFIED');
    expect(source).toContain('EXTERNAL_LIVE_VERIFIED: NONE');

    const overview = await app.inject({ method: 'GET', url: '/api/publishing/overview', headers: owner.headers });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().verification).toEqual({
      localImplemented: true, localVerified: false, externalLiveVerified: false,
    });
    expect(Array.isArray(overview.json().adapters)).toBe(true);
    expect(Array.isArray(overview.json().queue.blockers)).toBe(true);
  }, 120_000);
});

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { ANALYTICS_SOURCE_NAMES, collectWorkspaceAnalytics } from '../src/analytics-sources.js';

describe('analytics sources', () => {
  let app: any;

  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  async function workspace(label: string): Promise<string> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: {
        email: `${label}-${stamp}@x.com`,
        password: 'password1234',
        workspaceName: label,
        workspaceSlug: `${label}-${stamp}`,
      },
    });
    expect(signup.statusCode).toBe(201);
    return signup.json().workspace.id as string;
  }

  async function session(label: string): Promise<{ workspaceId: string; headers: Record<string, string> }> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: {
        email: `${label}-api-${stamp}@x.com`,
        password: 'password1234',
        workspaceName: label,
        workspaceSlug: `${label}-api-${stamp}`,
      },
    });
    expect(signup.statusCode).toBe(201);
    const workspaceId = signup.json().workspace.id as string;
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `${label}-api-${stamp}@x.com`, password: 'password1234' },
    });
    expect(login.statusCode).toBe(200);
    return {
      workspaceId,
      headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId },
    };
  }

  function source(result: any, name: string): any {
    const found = result.sources.find((entry: any) => entry.source === name);
    expect(found).toBeDefined();
    return found;
  }

  it('marks an empty workspace unavailable instead of inventing zero metrics', async () => {
    const ws = await workspace('empty-src');
    const result = await collectWorkspaceAnalytics(ws);

    expect(result.dataAvailable).toBe(false);
    expect(result.sources).toHaveLength(ANALYTICS_SOURCE_NAMES.length);
    expect(result.sources.every((entry) => !entry.available && entry.reason === 'NO_ROWS' && entry.rowCount === 0)).toBe(true);
    expect(result.campaigns).toEqual([]);
    expect(result.performance).toEqual([]);
    expect(result.clicks).toBeNull();
    expect(result.conversions).toBeNull();
    expect(result.commissionsCents).toBeNull();
    expect(result.affiliateRevenueCents).toBeNull();
    expect(result.revenueCents).toBeNull();
    expect(result.attribution).toBeNull();
    expect(result.payouts).toBeNull();
    expect(result.cashRevenue).toEqual({ available: false, reason: 'NOT_CONFIGURED', metric: null, cents: null });
    expect(result.missing).toEqual([
      ...ANALYTICS_SOURCE_NAMES.map((name) => `${name}:NO_ROWS`),
      'commissionsCents:NO_ROWS',
      'revenueCents:NOT_CONFIGURED',
    ]);

    await expect(collectWorkspaceAnalytics(ws, { windowMs: 0 })).rejects.toThrow('INVALID_WINDOW_MS');
    await expect(collectWorkspaceAnalytics(ws, { limit: 0 })).rejects.toThrow('INVALID_LIMIT');
    await expect(collectWorkspaceAnalytics('bad id!')).rejects.toThrow('INVALID_WORKSPACE_ID');
  });

  it('merges real campaigns, clicks, conversions, commissions, snapshot cash revenue and performance', async () => {
    const ws = await workspace('full-src');
    const foreignWs = await workspace('foreign-src');
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();

    await withWorkspaceTransaction(ws, async (tx: any) => {
      const brand = await tx.brand.create({ data: { workspaceId: ws, name: 'Brand A' } });
      const creator = await tx.creator.create({ data: { workspaceId: ws, name: 'Creator A' } });
      await tx.campaign.create({
        data: {
          workspaceId: ws,
          name: 'Camp A',
          status: 'active',
          goal: 'sales',
          budgetCents: 9900,
          brandId: brand.id,
          creators: { connect: [{ id: creator.id }] },
        },
      });

      const click1 = await tx.affiliateClick.create({
        data: { workspaceId: ws, contentId: 'content-1', offerId: 'offer-1', clickedAt: now, idempotencyKey: `as-click-1-${stamp}` },
      });
      const click2 = await tx.affiliateClick.create({
        data: { workspaceId: ws, contentId: null, offerId: 'offer-2', clickedAt: now, idempotencyKey: `as-click-2-${stamp}` },
      });
      await tx.affiliateConversion.create({
        data: { workspaceId: ws, clickId: click1.id, amountCents: 2500, status: 'approved', convertedAt: now, idempotencyKey: `as-conv-1-${stamp}` },
      });
      await tx.affiliateConversion.create({
        data: { workspaceId: ws, clickId: click2.id, amountCents: 1750, status: 'paid', convertedAt: now, idempotencyKey: `as-conv-2-${stamp}` },
      });
      await tx.affiliateConversion.create({
        data: { workspaceId: ws, clickId: null, amountCents: 900, status: 'pending', convertedAt: now, idempotencyKey: `as-conv-3-${stamp}` },
      });
      await tx.affiliateConversion.create({
        data: { workspaceId: ws, clickId: click1.id, amountCents: 400, status: 'rejected', convertedAt: now, idempotencyKey: `as-conv-4-${stamp}` },
      });

      await tx.analyticsSnapshot.create({
        data: { workspaceId: ws, source: 'manual', metric: 'cash_revenue_cents', value: 4200, periodStart: now, periodEnd: now },
      });
      await tx.analyticsSnapshot.create({
        data: { workspaceId: ws, source: 'manual', metric: 'cash_revenue_cents', value: 800, periodStart: now, periodEnd: now },
      });
      await tx.analyticsSnapshot.create({
        data: { workspaceId: ws, source: 'manual', metric: 'views', value: 100, periodStart: now, periodEnd: now },
      });

      const post = await tx.contentPost.create({
        data: { workspaceId: ws, platform: 'youtube', externalId: `yt-${stamp}`, title: 'Video A', publishedAt: now },
      });
      await tx.contentPost.create({
        data: { workspaceId: ws, platform: 'tiktok', externalId: `tt-${stamp}`, title: 'No snapshots' },
      });
      await tx.performanceSnapshot.create({
        data: { workspaceId: ws, postId: post.id, views: 100, likes: 1, capturedAt: new Date(now.getTime() - 120_000) },
      });
      await tx.performanceSnapshot.create({
        data: { workspaceId: ws, postId: post.id, views: 300, likes: 9, comments: 4, shares: 2, watchTimeSec: 42, capturedAt: new Date(now.getTime() - 60_000) },
      });
    });

    await withWorkspaceTransaction(foreignWs, async (tx: any) => {
      const brand = await tx.brand.create({ data: { workspaceId: foreignWs, name: 'FOREIGN Brand' } });
      const creator = await tx.creator.create({ data: { workspaceId: foreignWs, name: 'FOREIGN Creator' } });
      await tx.campaign.create({
        data: {
          workspaceId: foreignWs,
          name: 'FOREIGN CAMP',
          brandId: brand.id,
          creators: { connect: [{ id: creator.id }] },
        },
      });
      const click = await tx.affiliateClick.create({
        data: { workspaceId: foreignWs, contentId: 'foreign-content', clickedAt: now, idempotencyKey: `as-f-click-${stamp}` },
      });
      await tx.affiliateConversion.create({
        data: { workspaceId: foreignWs, clickId: click.id, amountCents: 99_999, status: 'paid', convertedAt: now, idempotencyKey: `as-f-conv-${stamp}` },
      });
      await tx.analyticsSnapshot.create({
        data: { workspaceId: foreignWs, source: 'manual', metric: 'cash_revenue_cents', value: 99_999, periodStart: now, periodEnd: now },
      });
      const post = await tx.contentPost.create({
        data: { workspaceId: foreignWs, platform: 'tiktok', externalId: `foreign-${stamp}`, title: 'FOREIGN post' },
      });
      await tx.performanceSnapshot.create({
        data: { workspaceId: foreignWs, postId: post.id, views: 9999, capturedAt: now },
      });
    });

    const result = await collectWorkspaceAnalytics(ws);
    expect(result.dataAvailable).toBe(true);
    expect(result.sources.every((entry) => entry.available && entry.reason === 'OK')).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.clicks).toBe(2);
    expect(result.conversions).toBe(4);
    expect(result.commissionsCents).toBe(4250);
    expect(result.affiliateRevenueCents).toBe(4250);
    expect(result.revenueCents).toBe(5000);
    expect(result.cashRevenue).toEqual({ available: true, reason: 'OK', metric: 'cash_revenue_cents', cents: 5000 });
    expect(result.attribution).toMatchObject({
      clicks: 2,
      conversions: 4,
      attributedConversions: 3,
      unattributedConversions: 1,
      revenueCents: 4250,
    });
    expect(result.payouts?.paid).toEqual({ count: 1, amountCents: 1750 });
    expect(result.payouts?.payableCents).toBe(2500);
    expect(result.campaigns).toEqual([
      expect.objectContaining({
        name: 'Camp A',
        budgetCents: 9900,
        brand: { id: expect.any(String), name: 'Brand A' },
        creators: [{ id: expect.any(String), name: 'Creator A' }],
      }),
    ]);
    expect(result.performance).toEqual([
      expect.objectContaining({ platform: 'youtube', snapshotCount: 2, views: 300, likes: 9, watchTimeSec: 42 }),
    ]);
    expect(JSON.stringify(result)).not.toContain('FOREIGN');
    expect(source(result, 'content_posts').rowCount).toBe(2);

    const foreignResult = await collectWorkspaceAnalytics(foreignWs);
    expect(foreignResult.clicks).toBe(1);
    expect(foreignResult.conversions).toBe(1);
    expect(foreignResult.commissionsCents).toBe(99_999);
    expect(foreignResult.revenueCents).toBe(99_999);
    expect(foreignResult.campaigns.map((campaign) => campaign.name)).toEqual(['FOREIGN CAMP']);
    expect(foreignResult.performance.map((entry) => entry.views)).toEqual([9999]);
    expect(JSON.stringify(foreignResult)).not.toContain('Camp A');
    expect(JSON.stringify(foreignResult)).not.toContain('Brand A');
  });

  it('applies the window and reports a missing cash metric when only other snapshot metrics exist', async () => {
    const ws = await workspace('window-src');
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    const old = new Date(now.getTime() - 3_600_000);

    await withWorkspaceTransaction(ws, async (tx: any) => {
      await tx.analyticsSnapshot.create({
        data: { workspaceId: ws, source: 'manual', metric: 'cash_revenue_cents', value: 7000, periodStart: old, periodEnd: old },
      });
      await tx.analyticsSnapshot.create({
        data: { workspaceId: ws, source: 'manual', metric: 'views', value: 10, periodStart: now, periodEnd: now },
      });
      await tx.affiliateClick.create({
        data: { workspaceId: ws, clickedAt: old, idempotencyKey: `as-old-click-${stamp}` },
      });
      const recentClick = await tx.affiliateClick.create({
        data: { workspaceId: ws, clickedAt: now, idempotencyKey: `as-new-click-${stamp}` },
      });
      await tx.affiliateConversion.create({
        data: { workspaceId: ws, clickId: recentClick.id, amountCents: 1200, status: 'approved', convertedAt: now, idempotencyKey: `as-new-conv-${stamp}` },
      });
      await tx.affiliateConversion.create({
        data: { workspaceId: ws, amountCents: 5000, status: 'paid', convertedAt: old, idempotencyKey: `as-old-conv-${stamp}` },
      });
    });

    const short = await collectWorkspaceAnalytics(ws, { windowMs: 60_000 });
    expect(short.windowMs).toBe(60_000);
    expect(source(short, 'analytics_snapshots').rowCount).toBe(1);
    expect(source(short, 'affiliate_clicks').rowCount).toBe(1);
    expect(source(short, 'affiliate_conversions').rowCount).toBe(1);
    expect(short.clicks).toBe(1);
    expect(short.conversions).toBe(1);
    expect(short.commissionsCents).toBe(1200);
    expect(short.revenueCents).toBeNull();
    expect(short.cashRevenue).toEqual({ available: false, reason: 'NOT_CONFIGURED', metric: null, cents: null });
    expect(short.missing).toContain('revenueCents:NOT_CONFIGURED');

    const full = await collectWorkspaceAnalytics(ws);
    expect(full.windowMs).toBeNull();
    expect(full.clicks).toBe(2);
    expect(full.conversions).toBe(2);
    expect(full.commissionsCents).toBe(6200);
    expect(full.revenueCents).toBe(7000);
    expect(full.missing).not.toContain('revenueCents:NOT_CONFIGURED');
  });

  it('keeps sums independent of limit and produces identical repeated aggregation', async () => {
    const ws = await workspace('limit-src');
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();

    await withWorkspaceTransaction(ws, async (tx: any) => {
      await tx.campaign.create({ data: { workspaceId: ws, name: `Camp 1 ${stamp}` } });
      await tx.campaign.create({ data: { workspaceId: ws, name: `Camp 2 ${stamp}` } });
      const click = await tx.affiliateClick.create({
        data: { workspaceId: ws, idempotencyKey: `as-limit-click-${stamp}`, clickedAt: now },
      });
      await tx.affiliateConversion.create({
        data: { workspaceId: ws, clickId: click.id, amountCents: 700, status: 'approved', convertedAt: now, idempotencyKey: `as-limit-conv-${stamp}` },
      });
      await tx.analyticsSnapshot.create({
        data: { workspaceId: ws, source: 'manual', metric: 'revenue_cents', value: 3300, periodStart: now, periodEnd: now },
      });
      for (const index of [1, 2]) {
        const post = await tx.contentPost.create({
          data: { workspaceId: ws, platform: 'youtube', externalId: `limit-${index}-${stamp}` },
        });
        await tx.performanceSnapshot.create({
          data: { workspaceId: ws, postId: post.id, views: index * 100, capturedAt: now },
        });
      }
    });

    const limited = await collectWorkspaceAnalytics(ws, { limit: 1 });
    const repeated = await collectWorkspaceAnalytics(ws, { limit: 1 });
    const all = await collectWorkspaceAnalytics(ws);

    expect(repeated).toEqual(limited);
    expect(limited.campaigns).toHaveLength(1);
    expect(all.campaigns).toHaveLength(2);
    expect(limited.performance).toHaveLength(1);
    expect(all.performance).toHaveLength(2);
    expect(source(limited, 'campaigns').rowCount).toBe(2);
    expect(source(limited, 'performance_snapshots').rowCount).toBe(2);
    expect(limited.clicks).toBe(all.clicks);
    expect(limited.conversions).toBe(all.conversions);
    expect(limited.commissionsCents).toBe(all.commissionsCents);
    expect(limited.revenueCents).toBe(all.revenueCents);
    expect(limited.commissionsCents).toBe(700);
    expect(limited.revenueCents).toBe(3300);
    expect(limited.cashRevenue.metric).toBe('revenue_cents');
  });

  it('exposes the truth-first report through the authenticated API', async () => {
    const ctx = await session('analytics-api');
    const unauth = await app.inject({ method: 'GET', url: '/api/analytics/sources' });
    expect(unauth.statusCode).toBe(401);

    const response = await app.inject({ method: 'GET', url: '/api/analytics/sources', headers: ctx.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().analytics.dataAvailable).toBe(false);
    expect(response.json().analytics.missing.length).toBeGreaterThan(0);
    expect(response.json().analytics.sources.length).toBeGreaterThan(0);
    expect(response.json().analytics.windowMs).toBeNull();

    const windowed = await app.inject({
      method: 'GET',
      url: '/api/analytics/sources?windowMs=60000&limit=5',
      headers: ctx.headers,
    });
    expect(windowed.statusCode).toBe(200);
    expect(windowed.json().analytics.windowMs).toBe(60_000);

    const badLimit = await app.inject({
      method: 'GET',
      url: '/api/analytics/sources?limit=0',
      headers: ctx.headers,
    });
    expect(badLimit.statusCode).toBe(400);
    expect(badLimit.json().error).toBe('INVALID_LIMIT');

    const other = await session('analytics-api-other');
    const foreign = await app.inject({ method: 'GET', url: '/api/analytics/sources', headers: other.headers });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().analytics.dataAvailable).toBe(false);
  });
});

/**
 * Truth-first workspace analytics aggregation.
 *
 * Every number returned here is derived from rows that actually exist in the
 * workspace. Missing rows are reported as unavailable (`NO_ROWS` /
 * `NOT_CONFIGURED`) instead of silently becoming zeroes. No external API is
 * called and no synthetic metrics are produced.
 *
 * Exported API:
 * - `collectWorkspaceAnalytics(workspaceId, options?)` -> `WorkspaceAnalytics`
 * - `WorkspaceAnalyticsOptions`, `WorkspaceAnalytics` (result shape)
 * - `AnalyticsSourceName`, `AnalyticsSourceReason`, `AnalyticsSource`
 * - `CashRevenue`, `CampaignAnalytics`, `PerformanceAnalytics`
 * - `ANALYTICS_SOURCE_NAMES`, `CASH_REVENUE_CENTS_METRICS`
 *
 * Revenue is deliberately split: `affiliateRevenueCents` is approved + paid
 * affiliate conversion amounts, while `revenueCents` is cash revenue from
 * AnalyticsSnapshot metric rows only. They are never added together.
 * `limit` caps only the returned campaign/performance arrays; all sums are
 * computed from the full workspace/window row set.
 */

import { withWorkspaceTransaction } from '../lib/db.js';
import { summarizeAffiliateRevenue, summarizeAttribution, summarizePayouts } from './affiliate.js';
import type { AffiliateRevenueSummary, AttributionSummary, PayoutSummary } from './affiliate.js';

export const ANALYTICS_SOURCE_NAMES = [
  'analytics_snapshots',
  'affiliate_clicks',
  'affiliate_conversions',
  'campaigns',
  'creators',
  'brands',
  'content_posts',
  'performance_snapshots',
] as const;

export type AnalyticsSourceName = (typeof ANALYTICS_SOURCE_NAMES)[number];
export type AnalyticsSourceReason = 'OK' | 'NO_ROWS' | 'NOT_CONFIGURED';

export type AnalyticsSource = {
  source: AnalyticsSourceName;
  available: boolean;
  reason: AnalyticsSourceReason;
  rowCount: number;
};

/** Explicit cents-denominated snapshot metrics. The first present metric wins, so gross and net rows are never mixed. */
export const CASH_REVENUE_CENTS_METRICS = [
  'cash_revenue_cents',
  'net_revenue_cents',
  'revenue_cents',
  'gross_revenue_cents',
] as const;

export type CashRevenue = {
  available: boolean;
  reason: 'OK' | 'NOT_CONFIGURED';
  metric: string | null;
  cents: number | null;
};

export type CampaignAnalytics = {
  id: string;
  name: string;
  status: string;
  goal: string | null;
  budgetCents: number | null;
  startDate: string | null;
  endDate: string | null;
  brand: { id: string; name: string } | null;
  creators: Array<{ id: string; name: string }>;
};

export type PerformanceAnalytics = {
  postId: string;
  platform: string;
  externalId: string;
  title: string | null;
  url: string | null;
  publishedAt: string | null;
  /** Number of real PerformanceSnapshot rows for this post in the window. */
  snapshotCount: number;
  /** Values from the newest snapshot only; cumulative snapshots are not summed. */
  views: number;
  likes: number;
  comments: number;
  shares: number;
  watchTimeSec: number | null;
  capturedAt: string;
};

export type WorkspaceAnalyticsOptions = {
  /** Optional look-back window in milliseconds, ending at collection time. */
  windowMs?: number;
  /** Max items per returned campaign/performance array. Default 50, max 200. */
  limit?: number;
};

export type WorkspaceAnalytics = {
  dataAvailable: boolean;
  windowMs: number | null;
  sources: AnalyticsSource[];
  campaigns: CampaignAnalytics[];
  /** Null when there are no real click rows. */
  clicks: number | null;
  /** Null when there are no real conversion rows. */
  conversions: number | null;
  /** Approved + paid affiliate conversion cents; null without conversion rows. */
  commissionsCents: number | null;
  /** Same source as commissionsCents, exposed separately; never part of revenueCents. */
  affiliateRevenueCents: number | null;
  /** Cash revenue cents from AnalyticsSnapshot metrics; null when no real cash metric exists. */
  revenueCents: number | null;
  cashRevenue: CashRevenue;
  /** Null unless both click and conversion rows exist. Derived via summarizeAttribution. */
  attribution: AttributionSummary | null;
  /** Null unless conversion rows exist. Derived via summarizePayouts. */
  payouts: PayoutSummary | null;
  /** Phase H.4: revenue per clip/creator/platform/campaign/UTM source. */
  affiliateRevenue: AffiliateRevenueSummary | null;
  performance: PerformanceAnalytics[];
  /** Stable `${target}:${reason}` keys for unavailable sources and derived metrics. */
  missing: string[];
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function normalizeOptions(options: WorkspaceAnalyticsOptions): { windowMs: number | null; limit: number } {
  const windowMs = options.windowMs;
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (windowMs !== undefined && (!Number.isFinite(windowMs) || windowMs <= 0)) {
    throw new Error('INVALID_WINDOW_MS');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error('INVALID_LIMIT');
  }
  return { windowMs: windowMs ?? null, limit };
}

function within(column: string, from: Date | null, to: Date): Record<string, unknown> {
  return from ? { [column]: { gte: from, lte: to } } : {};
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function normalizeMetric(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function selectCashRevenue(snapshots: any[]): CashRevenue {
  for (const metric of CASH_REVENUE_CENTS_METRICS) {
    const rows = snapshots.filter((snapshot) => normalizeMetric(snapshot.metric) === metric);
    const finiteRows = rows.filter((snapshot) => Number.isFinite(Number(snapshot.value)));
    if (!finiteRows.length) continue;
    const cents = Math.round(finiteRows.reduce((total, snapshot) => total + Number(snapshot.value), 0));
    return { available: true, reason: 'OK', metric, cents };
  }
  return { available: false, reason: 'NOT_CONFIGURED', metric: null, cents: null };
}

function campaignView(row: any, workspaceId: string): CampaignAnalytics {
  const brand = row.brand && row.brand.workspaceId === workspaceId
    ? { id: String(row.brand.id), name: String(row.brand.name) }
    : null;
  const creators = (row.creators ?? [])
    .filter((creator: any) => creator?.workspaceId === workspaceId)
    .map((creator: any) => ({ id: String(creator.id), name: String(creator.name) }))
    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
  return {
    id: String(row.id),
    name: String(row.name),
    status: String(row.status),
    goal: row.goal === null || row.goal === undefined ? null : String(row.goal),
    budgetCents: row.budgetCents === null || row.budgetCents === undefined ? null : Number(row.budgetCents),
    startDate: iso(row.startDate),
    endDate: iso(row.endDate),
    brand,
    creators,
  };
}

function performanceViews(posts: any[], snapshots: any[]): PerformanceAnalytics[] {
  const byPost = new Map<string, any[]>();
  for (const snapshot of snapshots) {
    const list = byPost.get(String(snapshot.postId)) ?? [];
    list.push(snapshot);
    byPost.set(String(snapshot.postId), list);
  }

  const views: PerformanceAnalytics[] = [];
  for (const post of posts) {
    const rows = byPost.get(String(post.id));
    if (!rows?.length) continue;
    const latest = rows.reduce((a, b) => (new Date(b.capturedAt).getTime() >= new Date(a.capturedAt).getTime() ? b : a));
    const watchTime = Number(latest.watchTimeSec);
    views.push({
      postId: String(post.id),
      platform: String(post.platform),
      externalId: String(post.externalId),
      title: post.title === null || post.title === undefined ? null : String(post.title),
      url: post.url === null || post.url === undefined ? null : String(post.url),
      publishedAt: iso(post.publishedAt),
      snapshotCount: rows.length,
      views: Number(latest.views),
      likes: Number(latest.likes),
      comments: Number(latest.comments),
      shares: Number(latest.shares),
      watchTimeSec: latest.watchTimeSec === null || latest.watchTimeSec === undefined || !Number.isFinite(watchTime)
        ? null
        : watchTime,
      capturedAt: new Date(latest.capturedAt).toISOString(),
    });
  }
  return views;
}

/**
 * Collect one workspace's real analytics/affiliate rows in a single RLS-scoped
 * transaction. Throws `INVALID_WORKSPACE_ID`, `INVALID_WINDOW_MS`, or
 * `INVALID_LIMIT` for malformed input.
 */
export async function collectWorkspaceAnalytics(
  workspaceId: string,
  options: WorkspaceAnalyticsOptions = {},
): Promise<WorkspaceAnalytics> {
  const { windowMs, limit } = normalizeOptions(options);
  const to = new Date();
  const from = windowMs === null ? null : new Date(to.getTime() - windowMs);

  return withWorkspaceTransaction(workspaceId, async (tx: any) => {
    const [snapshots, clicks, conversions, campaignRows, creators, brands, posts, performanceSnapshots, links] = await Promise.all([
      tx.analyticsSnapshot.findMany({
        where: {
          workspaceId,
          ...(from ? { periodStart: { lte: to }, periodEnd: { gte: from } } : {}),
        },
      }),
      tx.affiliateClick.findMany({ where: { workspaceId, ...within('clickedAt', from, to) } }),
      tx.affiliateConversion.findMany({ where: { workspaceId, ...within('convertedAt', from, to) } }),
      tx.campaign.findMany({
        where: { workspaceId, ...within('createdAt', from, to) },
        orderBy: { createdAt: 'desc' },
        include: { brand: true, creators: { where: { workspaceId } } },
      }),
      tx.creator.findMany({ where: { workspaceId, ...within('createdAt', from, to) } }),
      tx.brand.findMany({ where: { workspaceId, ...within('createdAt', from, to) } }),
      tx.contentPost.findMany({ where: { workspaceId, ...within('createdAt', from, to) }, orderBy: { createdAt: 'desc' } }),
      tx.performanceSnapshot.findMany({
        where: { workspaceId, ...within('capturedAt', from, to) },
        orderBy: { capturedAt: 'asc' },
      }),
      tx.affiliateLink.findMany({ where: { workspaceId, ...within('createdAt', from, to) } }),
    ]);

    const counts: Record<AnalyticsSourceName, number> = {
      analytics_snapshots: snapshots.length,
      affiliate_clicks: clicks.length,
      affiliate_conversions: conversions.length,
      campaigns: campaignRows.length,
      creators: creators.length,
      brands: brands.length,
      content_posts: posts.length,
      performance_snapshots: performanceSnapshots.length,
    };
    const sources: AnalyticsSource[] = ANALYTICS_SOURCE_NAMES.map((source) => ({
      source,
      available: counts[source] > 0,
      reason: counts[source] > 0 ? 'OK' : 'NO_ROWS',
      rowCount: counts[source],
    }));
    const sourceMap = new Map(sources.map((source) => [source.source, source]));

    const cashRevenue = selectCashRevenue(snapshots);
    const attribution = sourceMap.get('affiliate_clicks')!.available && sourceMap.get('affiliate_conversions')!.available
      ? summarizeAttribution(clicks, conversions)
      : null;
    const payouts = sourceMap.get('affiliate_conversions')!.available ? summarizePayouts(conversions) : null;
    const commissionsCents = payouts ? payouts.approved.amountCents + payouts.paid.amountCents : null;
    const affiliateRevenue = sourceMap.get('affiliate_conversions')!.available
      ? summarizeAffiliateRevenue({ clicks, conversions, links, posts })
      : null;

    const campaigns = campaignRows.slice(0, limit).map((row: any) => campaignView(row, workspaceId));
    const performance = performanceViews(posts, performanceSnapshots).slice(0, limit);

    const missing: string[] = sources
      .filter((source) => !source.available)
      .map((source) => `${source.source}:${source.reason}`);
    if (commissionsCents === null) missing.push(`commissionsCents:${sourceMap.get('affiliate_conversions')!.reason}`);
    // The H.4 revenue view exposes a null commission explicitly via its own
    // endpoint; the legacy missing list must keep its documented shape.
    if (cashRevenue.cents === null) missing.push(`revenueCents:${cashRevenue.reason}`);

    return {
      dataAvailable: sources.some((source) => source.available),
      windowMs,
      sources,
      campaigns,
      clicks: sourceMap.get('affiliate_clicks')!.available ? (attribution ? attribution.clicks : clicks.length) : null,
      conversions: sourceMap.get('affiliate_conversions')!.available ? (attribution ? attribution.conversions : conversions.length) : null,
      commissionsCents,
      affiliateRevenueCents: commissionsCents,
      revenueCents: cashRevenue.cents,
      cashRevenue,
      attribution,
      payouts,
      affiliateRevenue,
      performance,
      missing,
    };
  });
}

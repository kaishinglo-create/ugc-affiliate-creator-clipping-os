/**
 * Affiliate attribution and payout helpers.
 *
 * The database stores the raw facts only: clicks carry the content/offer they
 * belong to, conversions optionally carry the click that caused them. These
 * helpers derive attribution and payout views from those rows; they never
 * invent revenue for missing data.
 */

export const AFFILIATE_PAYOUT_ACTIONS = ['approve', 'pay', 'reject'] as const;
export type AffiliatePayoutAction = (typeof AFFILIATE_PAYOUT_ACTIONS)[number];

export type AffiliateClickRow = {
  id: string;
  contentId: string | null;
  offerId: string | null;
  clickedAt: Date | string;
};

export type AffiliateConversionRow = {
  id: string;
  clickId: string | null;
  amountCents: number;
  status: string;
  convertedAt: Date | string;
};

type StatusTotal = { count: number; amountCents: number };

type AttributionBucket = {
  clicks: number;
  conversions: number;
  pendingCents: number;
  approvedCents: number;
  paidCents: number;
  rejectedCents: number;
  otherCents: number;
};

export type AttributionSummary = {
  clicks: number;
  conversions: number;
  attributedConversions: number;
  unattributedConversions: number;
  unresolvedClickIds: number;
  conversionRate: number;
  revenueCents: number;
  pendingCents: number;
  approvedCents: number;
  paidCents: number;
  rejectedCents: number;
  statusTotals: Array<StatusTotal & { status: string }>;
  byContent: AttributionBucketView[];
  byOffer: AttributionBucketView[];
};

export type PayoutSummary = {
  pending: StatusTotal;
  approved: StatusTotal;
  paid: StatusTotal;
  rejected: StatusTotal;
  other: StatusTotal;
  unpaidCents: number;
  payableCents: number;
  paidCents: number;
  statusTotals: Array<StatusTotal & { status: string }>;
};

export function isAffiliatePayoutAction(value: unknown): value is AffiliatePayoutAction {
  return typeof value === 'string' && (AFFILIATE_PAYOUT_ACTIONS as readonly string[]).includes(value);
}

export function resolvePayoutTransition(
  currentStatus: string,
  action: AffiliatePayoutAction,
): { ok: true; status: 'approved' | 'paid' | 'rejected' } | { ok: false; error: 'INVALID_PAYOUT_TRANSITION' } {
  if (action === 'approve' && currentStatus === 'pending') return { ok: true, status: 'approved' };
  if (action === 'pay' && currentStatus === 'approved') return { ok: true, status: 'paid' };
  if (action === 'reject' && (currentStatus === 'pending' || currentStatus === 'approved')) {
    return { ok: true, status: 'rejected' };
  }
  return { ok: false, error: 'INVALID_PAYOUT_TRANSITION' };
}

function emptyBucket(): AttributionBucket {
  return { clicks: 0, conversions: 0, pendingCents: 0, approvedCents: 0, paidCents: 0, rejectedCents: 0, otherCents: 0 };
}

function addAmount(target: { pendingCents: number; approvedCents: number; paidCents: number; rejectedCents: number; otherCents: number }, status: string, amountCents: number): void {
  if (status === 'pending') target.pendingCents += amountCents;
  else if (status === 'approved') target.approvedCents += amountCents;
  else if (status === 'paid') target.paidCents += amountCents;
  else if (status === 'rejected') target.rejectedCents += amountCents;
  else target.otherCents += amountCents;
}

function addStatusTotal(target: Map<string, StatusTotal>, status: string, amountCents: number): void {
  const current = target.get(status) ?? { count: 0, amountCents: 0 };
  current.count += 1;
  current.amountCents += amountCents;
  target.set(status, current);
}

function statusTotal(target: Map<string, StatusTotal>, status: string): StatusTotal {
  return target.get(status) ?? { count: 0, amountCents: 0 };
}

function roundRate(value: number): number {
  return Number(value.toFixed(4));
}

type AttributionBucketView = AttributionBucket & { revenueCents: number; contentId?: string; offerId?: string };

function bucketList(buckets: Map<string, AttributionBucket>, keyName: 'contentId' | 'offerId'): AttributionBucketView[] {
  return [...buckets.entries()]
    .map(([key, bucket]) => {
      const revenueCents = bucket.approvedCents + bucket.paidCents;
      return keyName === 'contentId'
        ? { contentId: key, ...bucket, revenueCents }
        : { offerId: key, ...bucket, revenueCents };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents || b.conversions - a.conversions || b.clicks - a.clicks);
}

export function summarizeAttribution(clicks: AffiliateClickRow[], conversions: AffiliateConversionRow[]): AttributionSummary {
  const clickById = new Map(clicks.map((click) => [click.id, click]));
  const statusTotals = new Map<string, StatusTotal>();
  const byContent = new Map<string, AttributionBucket>();
  const byOffer = new Map<string, AttributionBucket>();

  for (const click of clicks) {
    if (click.contentId) {
      const bucket = byContent.get(click.contentId) ?? emptyBucket();
      bucket.clicks += 1;
      byContent.set(click.contentId, bucket);
    }
    if (click.offerId) {
      const bucket = byOffer.get(click.offerId) ?? emptyBucket();
      bucket.clicks += 1;
      byOffer.set(click.offerId, bucket);
    }
  }

  let attributedConversions = 0;
  let unattributedConversions = 0;
  let unresolvedClickIds = 0;

  for (const conversion of conversions) {
    const amountCents = Number.isFinite(conversion.amountCents) ? conversion.amountCents : 0;
    const status = String(conversion.status || 'pending');
    addStatusTotal(statusTotals, status, amountCents);

    const click = conversion.clickId ? clickById.get(conversion.clickId) : undefined;
    if (!click) {
      unattributedConversions += 1;
      if (conversion.clickId) unresolvedClickIds += 1;
      continue;
    }

    attributedConversions += 1;
    if (click.contentId) {
      const bucket = byContent.get(click.contentId) ?? emptyBucket();
      bucket.conversions += 1;
      addAmount(bucket, status, amountCents);
      byContent.set(click.contentId, bucket);
    }
    if (click.offerId) {
      const bucket = byOffer.get(click.offerId) ?? emptyBucket();
      bucket.conversions += 1;
      addAmount(bucket, status, amountCents);
      byOffer.set(click.offerId, bucket);
    }
  }

  const pending = statusTotal(statusTotals, 'pending');
  const approved = statusTotal(statusTotals, 'approved');
  const paid = statusTotal(statusTotals, 'paid');
  const rejected = statusTotal(statusTotals, 'rejected');

  return {
    clicks: clicks.length,
    conversions: conversions.length,
    attributedConversions,
    unattributedConversions,
    unresolvedClickIds,
    conversionRate: clicks.length ? roundRate(conversions.length / clicks.length) : 0,
    revenueCents: approved.amountCents + paid.amountCents,
    pendingCents: pending.amountCents,
    approvedCents: approved.amountCents,
    paidCents: paid.amountCents,
    rejectedCents: rejected.amountCents,
    statusTotals: [...statusTotals.entries()]
      .map(([status, totals]) => ({ status, ...totals }))
      .sort((a, b) => a.status.localeCompare(b.status)),
    byContent: bucketList(byContent, 'contentId'),
    byOffer: bucketList(byOffer, 'offerId'),
  };
}

export function summarizePayouts(conversions: AffiliateConversionRow[]): PayoutSummary {
  const statusTotals = new Map<string, StatusTotal>();
  for (const conversion of conversions) {
    const amountCents = Number.isFinite(conversion.amountCents) ? conversion.amountCents : 0;
    addStatusTotal(statusTotals, String(conversion.status || 'pending'), amountCents);
  }

  const pending = statusTotal(statusTotals, 'pending');
  const approved = statusTotal(statusTotals, 'approved');
  const paid = statusTotal(statusTotals, 'paid');
  const rejected = statusTotal(statusTotals, 'rejected');
  const knownStatuses = new Set(['pending', 'approved', 'paid', 'rejected']);
  const other = [...statusTotals.entries()]
    .filter(([status]) => !knownStatuses.has(status))
    .reduce((sum, [, totals]) => ({ count: sum.count + totals.count, amountCents: sum.amountCents + totals.amountCents }), { count: 0, amountCents: 0 });

  return {
    pending,
    approved,
    paid,
    rejected,
    other,
    unpaidCents: pending.amountCents + approved.amountCents,
    payableCents: approved.amountCents,
    paidCents: paid.amountCents,
    statusTotals: [...statusTotals.entries()]
      .map(([status, totals]) => ({ status, ...totals }))
      .sort((a, b) => a.status.localeCompare(b.status)),
  };
}

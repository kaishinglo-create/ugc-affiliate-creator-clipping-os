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
  /** Phase H: optional, privacy-safe attribution dimensions. */
  linkId?: string | null;
  postId?: string | null;
  campaignId?: string | null;
  creatorId?: string | null;
  productId?: string | null;
  platform?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  referrer?: string | null;
  externalEventId?: string | null;
};

export type AffiliateConversionRow = {
  id: string;
  clickId: string | null;
  amountCents: number;
  status: string;
  convertedAt: Date | string;
  /** Phase H: only a real, supplied commission is ever counted. */
  commissionCents?: number | null;
  currency?: string | null;
  payoutReference?: string | null;
  paidAt?: Date | string | null;
  externalEventId?: string | null;
};

export type AffiliateLinkRow = {
  id: string;
  token: string;
  campaignId?: string | null;
  creatorId?: string | null;
  productId?: string | null;
  offerId: string;
  destinationUrl: string;
  commissionBps?: number | null;
  disclosureText?: string | null;
  status?: string;
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

/* -------------------------------------------------------------------------- *
 * Phase H.4: links, UTM, disclosure and truth-only revenue dimensions.
 * Every number below is derived from stored rows. No rate is applied to a
 * conversion that did not already carry a real commission value.
 * -------------------------------------------------------------------------- */

export const UTM_FIELDS = {
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  utm_content: 'utmContent',
  utm_term: 'utmTerm',
} as const;

export type UtmParams = Partial<Record<keyof typeof UTM_FIELDS, string>>;

export function normalizeUtm(value: unknown): UtmParams {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out: UtmParams = {};
  for (const [param, field] of Object.entries(UTM_FIELDS)) {
    const raw = source[param] ?? source[field];
    if (typeof raw === 'string' && raw.trim()) out[param as keyof typeof UTM_FIELDS] = raw.trim().slice(0, 200);
  }
  return out;
}

export function appendUtm(destinationUrl: string, utm: UtmParams): string | null {
  try {
    const parsed = new URL(destinationUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    for (const [key, value] of Object.entries(utm)) {
      if (value) parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function affiliateCommissionCents(conversion: AffiliateConversionRow): number | null {
  const value = conversion.commissionCents;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

export type RevenueDimension = {
  key: string;
  clicks: number;
  conversions: number;
  revenueCents: number;
  commissionCents: number | null;
};

export type AffiliateRevenueSummary = {
  byClip: RevenueDimension[];
  byCreator: RevenueDimension[];
  byPlatform: RevenueDimension[];
  byCampaign: RevenueDimension[];
  byUtmSource: RevenueDimension[];
  totalCommissionCents: number | null;
  disclosedClicks: number;
  undisclosedClicks: number;
  duplicateExternalEvents: number;
};

type DimensionMap = Map<string, RevenueDimension>;

function dimension(map: DimensionMap, key: string | null | undefined): RevenueDimension | null {
  if (!key) return null;
  const normalized = String(key).trim().slice(0, 128);
  if (!normalized) return null;
  const row = map.get(normalized) ?? { key: normalized, clicks: 0, conversions: 0, revenueCents: 0, commissionCents: null };
  map.set(normalized, row);
  return row;
}

function dimensionList(map: DimensionMap): RevenueDimension[] {
  return [...map.values()].sort(
    (a, b) => b.revenueCents - a.revenueCents || b.conversions - a.conversions || b.clicks - a.clicks || a.key.localeCompare(b.key),
  );
}

function countDuplicateEvents(rows: Array<{ externalEventId?: string | null }>): number {
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (!row.externalEventId) continue;
    const key = String(row.externalEventId);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

/**
 * Revenue is approved + paid conversion amounts only. Commissions are added
 * only when the conversion actually carries a real commissionCents value.
 */
export function summarizeAffiliateRevenue(input: {
  clicks: AffiliateClickRow[];
  conversions: AffiliateConversionRow[];
  links?: AffiliateLinkRow[];
  posts?: Array<{ id: string; platform: string }>;
}): AffiliateRevenueSummary {
  const clickById = new Map(input.clicks.map((click) => [click.id, click]));
  const linkById = new Map((input.links ?? []).map((link) => [link.id, link]));
  const postPlatform = new Map((input.posts ?? []).map((post) => [String(post.id), String(post.platform)]));
  const maps = {
    byClip: new Map<string, RevenueDimension>(),
    byCreator: new Map<string, RevenueDimension>(),
    byPlatform: new Map<string, RevenueDimension>(),
    byCampaign: new Map<string, RevenueDimension>(),
    byUtmSource: new Map<string, RevenueDimension>(),
  };

  const keysForClick = (click: AffiliateClickRow) => {
    const link = click.linkId ? linkById.get(String(click.linkId)) : undefined;
    return {
      clip: click.postId ?? click.contentId,
      creator: click.creatorId ?? link?.creatorId,
      platform: click.platform ?? (click.postId ? postPlatform.get(String(click.postId)) : undefined),
      campaign: click.campaignId ?? link?.campaignId,
      utmSource: click.utmSource,
    };
  };

  for (const click of input.clicks) {
    const keys = keysForClick(click);
    for (const [map, key] of [
      [maps.byClip, keys.clip], [maps.byCreator, keys.creator], [maps.byPlatform, keys.platform],
      [maps.byCampaign, keys.campaign], [maps.byUtmSource, keys.utmSource],
    ] as Array<[DimensionMap, string | null | undefined]>) {
      const row = dimension(map, key);
      if (row) row.clicks += 1;
    }
  }

  let commissionSeen = 0;
  let totalCommissionCents = 0;
  let disclosedClicks = 0;
  let undisclosedClicks = 0;

  for (const conversion of input.conversions) {
    const click = conversion.clickId ? clickById.get(String(conversion.clickId)) : undefined;
    const commission = affiliateCommissionCents(conversion);
    if (commission !== null) {
      commissionSeen += 1;
      if (conversion.status === 'approved' || conversion.status === 'paid') totalCommissionCents += commission;
    }
    if (!click || (conversion.status !== 'approved' && conversion.status !== 'paid')) continue;
    const revenue = Number.isFinite(conversion.amountCents) && conversion.amountCents > 0 ? conversion.amountCents : 0;
    const keys = keysForClick(click);
    for (const [map, key] of [
      [maps.byClip, keys.clip], [maps.byCreator, keys.creator], [maps.byPlatform, keys.platform],
      [maps.byCampaign, keys.campaign], [maps.byUtmSource, keys.utmSource],
    ] as Array<[DimensionMap, string | null | undefined]>) {
      const row = dimension(map, key);
      if (!row) continue;
      row.conversions += 1;
      row.revenueCents += revenue;
      if (commission !== null) row.commissionCents = (row.commissionCents ?? 0) + commission;
    }
  }

  for (const click of input.clicks) {
    const link = click.linkId ? linkById.get(String(click.linkId)) : undefined;
    if (link?.disclosureText?.trim()) disclosedClicks += 1;
    else undisclosedClicks += 1;
  }

  return {
    byClip: dimensionList(maps.byClip),
    byCreator: dimensionList(maps.byCreator),
    byPlatform: dimensionList(maps.byPlatform),
    byCampaign: dimensionList(maps.byCampaign),
    byUtmSource: dimensionList(maps.byUtmSource),
    totalCommissionCents: commissionSeen > 0 ? totalCommissionCents : null,
    disclosedClicks,
    undisclosedClicks,
    duplicateExternalEvents: countDuplicateEvents(input.clicks) + countDuplicateEvents(input.conversions),
  };
}

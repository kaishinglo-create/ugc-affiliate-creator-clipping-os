/**
 * Explainable content scoring for Phase G research.
 *
 * Every dimension is derived from supplied facts or explicitly marked as a
 * missing/estimated value. No engagement or revenue figure is invented.
 */
export interface ContentCandidateInput {
  title: string;
  publishedAt?: string;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  channelTitle?: string;
  creatorSubscribers?: number;
  description?: string;
  category?: string;
  affiliateKeywords?: string[];
  audienceKeywords?: string[];
  rightsStatus?: 'authorized' | 'restricted' | 'unknown';
  platformRisk?: 'low' | 'medium' | 'high';
  productionMinutes?: number;
}

export interface ScoreDimension {
  key: string;
  value: number | null;
  source: 'provided' | 'estimated' | 'missing';
  evidence: string;
}

export interface ScoreReport {
  overall: number | null;
  dimensions: ScoreDimension[];
  notes: string[];
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function hasNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function keywordHits(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword.toLowerCase())).length;
}

/** Scores a candidate using only facts supplied by the caller. */
export function scoreContentCandidate(input: ContentCandidateInput): ScoreReport {
  const title = String(input.title ?? '').trim();
  const description = String(input.description ?? '').trim();
  const haystack = `${title} ${description}`.trim();
  const affiliateKeywords = input.affiliateKeywords ?? [];
  const audienceKeywords = input.audienceKeywords ?? [];
  const dimensions: ScoreDimension[] = [];

  dimensions.push({
    key: 'relevance',
    value: affiliateKeywords.length ? clamp01(keywordHits(haystack, affiliateKeywords) / Math.max(1, affiliateKeywords.length)) : null,
    source: affiliateKeywords.length ? 'provided' : 'missing',
    evidence: affiliateKeywords.length ? `Affiliate keyword hits in title/description: ${keywordHits(haystack, affiliateKeywords)}/${affiliateKeywords.length}.` : 'No relevance keywords supplied.',
  });

  if (input.publishedAt && Number.isFinite(Date.parse(input.publishedAt))) {
    const ageDays = (Date.now() - Date.parse(input.publishedAt)) / 86_400_000;
    dimensions.push({ key: 'freshness', value: clamp01(1 - ageDays / 365), source: 'provided', evidence: `Published ${ageDays.toFixed(1)} days ago.` });
  } else {
    dimensions.push({ key: 'freshness', value: null, source: 'missing', evidence: 'No publication timestamp supplied.' });
  }

  if (hasNumber(input.viewCount) || hasNumber(input.likeCount) || hasNumber(input.commentCount)) {
    const views = hasNumber(input.viewCount) ? input.viewCount : 0;
    const likes = hasNumber(input.likeCount) ? input.likeCount : 0;
    const comments = hasNumber(input.commentCount) ? input.commentCount : 0;
    const engagement = views > 0 ? clamp01((likes + comments * 2) / views) : 0;
    dimensions.push({ key: 'engagement', value: engagement, source: 'provided', evidence: `Computed from supplied views/likes/comments; ratio=${engagement.toFixed(4)}.` });
  } else {
    dimensions.push({ key: 'engagement', value: null, source: 'missing', evidence: 'No engagement counters supplied.' });
  }

  if (hasNumber(input.creatorSubscribers)) {
    dimensions.push({ key: 'creatorRelevance', value: clamp01(Math.log10(Math.max(1, input.creatorSubscribers)) / 7), source: 'provided', evidence: `Creator subscribers supplied: ${input.creatorSubscribers}.` });
  } else {
    dimensions.push({ key: 'creatorRelevance', value: null, source: 'missing', evidence: 'No creator reach supplied.' });
  }

  dimensions.push({
    key: 'affiliatePotential',
    value: affiliateKeywords.length ? clamp01(keywordHits(haystack, affiliateKeywords) / Math.max(1, affiliateKeywords.length)) : null,
    source: affiliateKeywords.length ? 'estimated' : 'missing',
    evidence: 'Estimated only from supplied affiliate keyword overlap; no revenue claim made.',
  });

  const clipWords = ['tutorial', 'review', 'how', 'quick', 'tips', 'demo', 'workflow', 'compared'];
  const hookWords = ['!', '?', 'best', 'why', 'how', 'never', 'secret', 'stop'];
  dimensions.push({
    key: 'clipSuitability',
    value: clamp01(keywordHits(title, clipWords) / 3),
    source: 'estimated',
    evidence: 'Heuristic based on title signals only; no transcript supplied.',
  });
  dimensions.push({
    key: 'hookPotential',
    value: clamp01(keywordHits(title, hookWords) / 3),
    source: 'estimated',
    evidence: 'Heuristic based on title punctuation/curiosity signals.',
  });
  dimensions.push({
    key: 'audienceFit',
    value: audienceKeywords.length ? clamp01(keywordHits(haystack, audienceKeywords) / Math.max(1, audienceKeywords.length)) : null,
    source: audienceKeywords.length ? 'provided' : 'missing',
    evidence: audienceKeywords.length ? `Audience keyword hits: ${keywordHits(haystack, audienceKeywords)}/${audienceKeywords.length}.` : 'No audience keywords supplied.',
  });

  const rights = input.rightsStatus ?? 'unknown';
  const rightsValue = rights === 'authorized' ? 1 : rights === 'restricted' ? 0 : 0.5;
  dimensions.push({
    key: 'rightsPlatformRisk',
    value: rightsValue,
    source: input.rightsStatus ? 'provided' : 'missing',
    evidence: `Rights status: ${rights}; platform risk: ${input.platformRisk ?? 'unknown'}.`,
  });

  if (hasNumber(input.productionMinutes)) {
    dimensions.push({ key: 'productionEffort', value: clamp01(1 - input.productionMinutes / 240), source: 'provided', evidence: `Estimated production time supplied: ${input.productionMinutes} minutes.` });
  } else {
    dimensions.push({ key: 'productionEffort', value: null, source: 'missing', evidence: 'No production effort supplied.' });
  }

  const weights: Record<string, number> = {
    relevance: 0.16, freshness: 0.12, engagement: 0.16, creatorRelevance: 0.1,
    affiliatePotential: 0.12, clipSuitability: 0.12, hookPotential: 0.08,
    audienceFit: 0.08, rightsPlatformRisk: 0.1, productionEffort: 0.06,
  };
  let weighted = 0;
  let usedWeight = 0;
  for (const dimension of dimensions) {
    if (dimension.value === null) continue;
    const weight = weights[dimension.key] ?? 0;
    weighted += dimension.value * weight;
    usedWeight += weight;
  }
  return {
    overall: usedWeight > 0 ? clamp01(weighted / usedWeight) : null,
    dimensions,
    notes: [
      'Values marked estimated are heuristics, not measured facts.',
      'Missing dimensions are excluded from the weighted average, not treated as zero.',
      'No revenue or engagement number is invented.',
    ],
  };
}

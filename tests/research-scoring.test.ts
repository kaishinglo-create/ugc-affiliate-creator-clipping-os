import { describe, expect, it } from 'vitest';
import { scoreContentCandidate } from '../src/research-scoring.js';

describe('explainable content scoring', () => {
  it('marks missing dimensions without inventing values', () => {
    const report = scoreContentCandidate({ title: 'A video' });
    expect(report.dimensions.find((d) => d.key === 'engagement')).toMatchObject({ value: null, source: 'missing' });
    expect(report.notes.join(' ')).toContain('No revenue or engagement number is invented.');
  });

  it('uses supplied facts and explains each dimension', () => {
    const report = scoreContentCandidate({
      title: 'Best clipping workflow tutorial',
      publishedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      viewCount: 1000,
      likeCount: 100,
      commentCount: 20,
      creatorSubscribers: 10000,
      affiliateKeywords: ['clipping'],
      audienceKeywords: ['creator'],
      rightsStatus: 'authorized',
      platformRisk: 'low',
      productionMinutes: 60,
    });
    expect(report.overall).not.toBeNull();
    expect(report.overall!).toBeGreaterThan(0);
    expect(report.dimensions.every((d) => d.evidence.length > 0)).toBe(true);
    expect(report.dimensions.find((d) => d.key === 'engagement')?.source).toBe('provided');
  });
});

import { describe, expect, it } from 'vitest';
import { rankClipCandidates } from '../src/clip-ranking.js';
import type { PlannedClip } from '../src/video/clipping.js';

const clips: PlannedClip[] = [
  { start: 10, duration: 18, startMs: 10000, endMs: 28000, text: 'first', score: 0.6 },
  { start: 40, duration: 12, startMs: 40000, endMs: 52000, text: 'second', score: 0.8 },
];

describe('clip ranking', () => {
  it('prefers higher transcript scores and scene alignment', () => {
    const ranked = rankClipCandidates({ clips, sceneTimestamps: [40.2], targetDurationSeconds: 15 });
    expect(ranked[0].text).toBe('second');
    expect(ranked[0].reason).toContain('sceneAligned=true');
    expect(ranked[1].rank).toBeLessThanOrEqual(ranked[0].rank);
  });

  it('returns an empty list without candidates', () => {
    expect(rankClipCandidates({ clips: [] })).toEqual([]);
  });
});

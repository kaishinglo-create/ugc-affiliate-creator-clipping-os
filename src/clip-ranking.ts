/**
 * Deterministic clip ranking using real transcript/scene facts only.
 */
import type { PlannedClip } from './video/clipping.js';

export interface RankedClip extends PlannedClip {
  rank: number;
  reason: string;
}

export interface RankInput {
  clips: PlannedClip[];
  sceneTimestamps?: number[];
  targetDurationSeconds?: number;
}

/** Rank clip candidates; no invented scores, only bounded deterministic factors. */
export function rankClipCandidates(input: RankInput): RankedClip[] {
  const clips = Array.isArray(input.clips) ? input.clips : [];
  const scenes = (input.sceneTimestamps ?? []).filter((value) => Number.isFinite(value) && value >= 0);
  const target = Math.max(1, Math.min(60, Number(input.targetDurationSeconds) || 15));
  return clips.map((clip, _index) => {
    const startsAtScene = scenes.some((timestamp) => Math.abs(timestamp - clip.start) <= 1.5);
    const lengthFit = 1 - Math.min(1, Math.abs(clip.duration - target) / target);
    const score = Math.max(0, Math.min(1, (Number.isFinite(clip.score) ? clip.score : 0.5) * 0.7 + lengthFit * 0.2 + (startsAtScene ? 0.1 : 0)));
    const reason = `transcriptScore=${Number.isFinite(clip.score) ? clip.score.toFixed(2) : 'n/a'}; lengthFit=${lengthFit.toFixed(2)}; sceneAligned=${startsAtScene}`;
    return { ...clip, rank: score, reason };
  }).sort((a, b) => b.rank - a.rank || a.start - b.start || indexCompare(a, b, clips));
}

function indexCompare(a: RankedClip, b: RankedClip, clips: PlannedClip[]): number {
  return clips.indexOf(a) - clips.indexOf(b);
}

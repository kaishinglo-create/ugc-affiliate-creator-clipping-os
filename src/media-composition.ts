/**
 * Phase G media composition helpers: real ffmpeg thumbnails, VTT subtitles and
 * automatic scene-aware clip ranking driven by probed media facts.
 */
import { readFile, stat } from 'node:fs/promises';
import { rankClipCandidates } from './clip-ranking.js';
import { resolveProfile, thumbnailArgs, writeVtt } from './content-production.js';
import { workspaceMediaPath } from './media-workspace.js';
import {
  detectScenes, planHighlightClips, probeMedia, runBinary,
  type HighlightWindow,
} from './video/clipping.js';

export interface ThumbnailResult {
  name: string;
  bytes: number;
  width: number;
  height: number;
  atSeconds: number;
}

/** Render one real thumbnail frame at a validated profile size. */
export async function generateThumbnail(input: {
  workspaceId: string;
  sourceName: string;
  outputName: string;
  atSeconds?: number;
  profile?: string;
}): Promise<ThumbnailResult> {
  const source = workspaceMediaPath(input.workspaceId, input.sourceName);
  const output = workspaceMediaPath(input.workspaceId, input.outputName);
  const profile = resolveProfile(String(input.profile ?? '9:16'));
  const at = Math.max(0, Math.min(3600, Number(input.atSeconds) || 1));
  await runBinary('ffmpeg', thumbnailArgs(source, output, at, profile), 60_000);
  const info = await stat(output).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    throw Object.assign(new Error('OUTPUT_NOT_CREATED'), { statusCode: 502 });
  }
  return { name: String(input.outputName), bytes: info.size, width: profile.width, height: profile.height, atSeconds: at };
}

/** Convert an existing workspace SRT file to WebVTT without changing its cues. */
export async function createVtt(input: { workspaceId: string; srtName: string; vttName?: string }): Promise<{ name: string; bytes: number }> {
  const source = workspaceMediaPath(input.workspaceId, input.srtName);
  const name = String(input.vttName ?? `${String(input.srtName).replace(/\.srt$/i, '')}.vtt`);
  const target = workspaceMediaPath(input.workspaceId, name);
  const srt = await readFile(source, 'utf8');
  await writeVtt(target, srt);
  const info = await stat(target);
  return { name, bytes: info.size };
}

export interface AutoRankResult {
  threshold: number;
  sceneTimestamps: number[];
  sourceDurationSeconds: number | null;
  candidates: ReturnType<typeof rankClipCandidates>;
}

/**
 * Detect real scene changes with ffmpeg, plan windows from real transcript
 * timestamps, then rank the candidates deterministically. No scene time or
 * segment score is fabricated when ffmpeg or the transcript is unavailable.
 */
export async function autoRankClips(input: {
  workspaceId: string;
  sourceName: string;
  highlights: HighlightWindow[];
  sceneThreshold?: number;
  targetDurationSeconds?: number;
  maxClips?: number;
}): Promise<AutoRankResult> {
  if (!Array.isArray(input.highlights)) {
    throw Object.assign(new Error('INVALID_INPUT'), { statusCode: 400 });
  }
  const source = workspaceMediaPath(input.workspaceId, input.sourceName);
  const metadata = await probeMedia(source);
  const scenes = await detectScenes(source, Number(input.sceneThreshold) || 0.3);
  const planned = planHighlightClips(input.highlights, {
    maxClips: input.maxClips === undefined ? undefined : Number(input.maxClips),
    sourceDurationSeconds: metadata.durationSeconds ?? null,
  });
  return {
    threshold: scenes.threshold,
    sceneTimestamps: scenes.timestamps,
    sourceDurationSeconds: metadata.durationSeconds ?? null,
    candidates: rankClipCandidates({
      clips: planned,
      sceneTimestamps: scenes.timestamps,
      targetDurationSeconds: input.targetDurationSeconds === undefined ? undefined : Number(input.targetDurationSeconds),
    }),
  };
}

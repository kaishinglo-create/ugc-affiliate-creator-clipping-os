/**
 * SRT generation and real ffmpeg subtitle burn-in.
 *
 * `writeSrt` is pure local file I/O. `burnSubtitles` always invokes ffmpeg: a
 * missing binary yields `NOT_CONFIGURED` (message `FFMPEG_NOT_CONFIGURED`),
 * never a silently copied input or a fabricated result.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  MediaNotFoundError,
  assertSafePath,
  invalidVideoInput,
  resolveVideoCodec,
  runBinary,
  verifyOutputFile,
} from './clipping.js';

export interface SrtCue {
  /** Optional 1-based cue number; defaults to the position in `cues`. */
  index?: number;
  /** Start time in seconds. */
  start: number;
  /** End time in seconds; must be greater than `start`. */
  end: number;
  text: string;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Format seconds as the SRT `HH:MM:SS,mmm` timestamp. */
export function formatSrtTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw invalidVideoInput('SRT timestamps must be finite and non-negative');
  }
  const totalMs = Math.round(seconds * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  if (hours > 99) {
    throw invalidVideoInput('SRT hours must be at most 99');
  }
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(wholeSeconds, 2)},${pad(millis, 3)}`;
}

/** Write a validated, newline-delimited SRT file. */
export async function writeSrt(cues: SrtCue[], targetPath: string): Promise<string> {
  if (!Array.isArray(cues)) {
    throw invalidVideoInput('cues must be an array');
  }
  const safePath = assertSafePath(targetPath, 'srtPath');
  const lines: string[] = [];

  cues.forEach((cue, position) => {
    if (!cue || typeof cue.text !== 'string') {
      throw invalidVideoInput('each cue must have text');
    }
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end)) {
      throw invalidVideoInput('cue timestamps must be finite');
    }
    if (cue.start < 0 || cue.end < 0 || cue.end <= cue.start) {
      throw invalidVideoInput('cue end must be greater than cue start');
    }
    const index = cue.index ?? position + 1;
    if (!Number.isInteger(index) || index < 1) {
      throw invalidVideoInput('cue index must be a positive integer');
    }
    formatSrtTimestamp(cue.start);
    formatSrtTimestamp(cue.end);
    lines.push(
      String(index),
      `${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}`,
      cue.text,
      '',
    );
  });

  await mkdir(path.dirname(safePath), { recursive: true });
  await writeFile(safePath, lines.join('\n'), 'utf8');
  return safePath;
}

/** Escape a filename for use in an ffmpeg `subtitles` filter expression. */
export function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export interface BurnSubtitlesOptions {
  input: string;
  srt: string;
  output: string;
  /** Video encoder; defaults to `FFMPEG_VIDEO_CODEC` or libx264. */
  codec?: string;
}

export interface BurnSubtitlesResult {
  outputPath: string;
  bytes: number;
  args: string[];
  durationMs: number;
}

/** Burn an existing SRT into a video with ffmpeg's `subtitles` filter. */
export async function burnSubtitles(options: BurnSubtitlesOptions): Promise<BurnSubtitlesResult> {
  const startedAt = performance.now();
  const input = assertSafePath(options.input, 'input');
  const srt = assertSafePath(options.srt, 'srt');
  const output = assertSafePath(options.output, 'output');

  const [inputInfo, srtInfo] = await Promise.all([
    stat(input).catch(() => null),
    stat(srt).catch(() => null),
  ]);
  if (!inputInfo || !inputInfo.isFile()) {
    throw new MediaNotFoundError(input);
  }
  if (!srtInfo || !srtInfo.isFile()) {
    throw new MediaNotFoundError(srt, 'SRT_NOT_FOUND');
  }

  await mkdir(path.dirname(output), { recursive: true });
  const filter = `subtitles=${escapeFilterPath(srt)}`;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-vf',
    filter,
    '-c:v',
    resolveVideoCodec(options.codec),
    '-c:a',
    'aac',
    output,
  ];

  await runBinary('ffmpeg', args);
  const bytes = await verifyOutputFile(output);
  return {
    outputPath: output,
    bytes,
    args,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

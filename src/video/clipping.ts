/**
 * Real ffmpeg/ffprobe-backed clipping primitives.
 *
 * This module never fabricates media or metadata. If a binary is unavailable,
 * every entry point fails with the explicit `NOT_CONFIGURED` code (carried by
 * `FFmpegNotConfiguredError`, whose message is `FFMPEG_NOT_CONFIGURED`).
 *
 * Binaries are resolved from `FFMPEG_BIN` / `FFPROBE_BIN` and fall back to the
 * names on PATH. All invocations use `spawn` with argument arrays and
 * `shell: false`; user input is never interpolated into a command string.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export type VideoErrorCode =
  | 'NOT_CONFIGURED'
  | 'MEDIA_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'FFMPEG_FAILED'
  | 'FFPROBE_FAILED'
  | 'OUTPUT_NOT_CREATED';

export interface VideoErrorDetails {
  binary?: 'ffmpeg' | 'ffprobe';
  path?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  cause?: string;
  reason?: string;
}

export interface VideoErrorInfo {
  code: VideoErrorCode;
  message: string;
  details: VideoErrorDetails;
}

/** Base error for the video pipeline. `code` is the stable classification. */
export class VideoPipelineError extends Error {
  readonly code: VideoErrorCode;
  readonly details: VideoErrorDetails;

  constructor(code: VideoErrorCode, message: string, details: VideoErrorDetails = {}) {
    super(message);
    this.name = 'VideoPipelineError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Missing/unexecutable ffmpeg or ffprobe. Code is `NOT_CONFIGURED`. */
export class FFmpegNotConfiguredError extends VideoPipelineError {
  readonly missingBinary: 'ffmpeg' | 'ffprobe';

  constructor(binary: 'ffmpeg' | 'ffprobe') {
    super('NOT_CONFIGURED', 'FFMPEG_NOT_CONFIGURED', { binary });
    this.name = 'FFmpegNotConfiguredError';
    this.missingBinary = binary;
  }
}

/** A source file (or subtitle file) does not exist or is not a regular file. */
export class MediaNotFoundError extends VideoPipelineError {
  constructor(targetPath: string, message = 'MEDIA_NOT_FOUND') {
    super('MEDIA_NOT_FOUND', message, { path: targetPath });
    this.name = 'MediaNotFoundError';
  }
}

export function invalidVideoInput(reason: string): VideoPipelineError {
  return new VideoPipelineError('INVALID_INPUT', 'INVALID_INPUT', { reason });
}

export function videoErrorInfo(error: unknown): VideoErrorInfo {
  if (error instanceof VideoPipelineError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: 'FFMPEG_FAILED',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

/** Accept only absolute paths without `..` segments or NUL bytes. */
export function assertSafePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidVideoInput(`${label} must be a non-empty absolute path`);
  }
  if (value.includes('\0')) {
    throw invalidVideoInput(`${label} must not contain NUL bytes`);
  }
  if (value.split(/[\\/]/).includes('..')) {
    throw invalidVideoInput(`${label} must not contain path traversal segments`);
  }
  if (!path.isAbsolute(value)) {
    throw invalidVideoInput(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}

/** Require `candidate` to be a path strictly inside `base`. */
export function assertWithinDirectory(candidate: string, base: string): void {
  const safeCandidate = assertSafePath(candidate, 'output');
  const safeBase = assertSafePath(base, 'allowedTempDir');
  const relative = path.relative(safeBase, safeCandidate);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw invalidVideoInput('output must be inside allowedTempDir');
  }
}

export interface ExtractAudioOptions {
  input: string;
  output: string;
  /** Mono WAV sample rate; defaults to 16 kHz for Whisper. */
  sampleRate?: number;
  /** Optional workspace temp directory that must contain `output`. */
  allowedTempDir?: string;
}

export interface ExtractAudioResult {
  outputPath: string;
  bytes: number;
  args: string[];
  durationMs: number;
}

/**
 * Extract a real mono 16 kHz PCM WAV from a video with ffmpeg. The result is
 * only returned after ffmpeg exits successfully and the output file exists.
 */
export async function extractAudio(options: ExtractAudioOptions): Promise<ExtractAudioResult> {
  const startedAt = performance.now();
  const input = assertSafePath(options.input, 'input');
  const output = assertSafePath(options.output, 'output');
  if (options.allowedTempDir !== undefined) {
    assertWithinDirectory(output, options.allowedTempDir);
  }
  const sampleRate = options.sampleRate ?? 16_000;
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000) {
    throw invalidVideoInput('sampleRate must be an integer between 8000 and 48000');
  }

  const inputInfo = await stat(input).catch(() => null);
  if (!inputInfo || !inputInfo.isFile()) {
    throw new MediaNotFoundError(input);
  }

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    '-c:a',
    'pcm_s16le',
    output,
  ];
  await mkdir(path.dirname(output), { recursive: true });
  await runBinary('ffmpeg', args);
  const bytes = await verifyOutputFile(output);
  return { outputPath: output, bytes, args, durationMs: elapsedMs(startedAt) };
}

/** Resolve the video codec; the argument wins over the environment variable. */
export function resolveVideoCodec(codec?: string): string {
  const value = codec?.trim() || process.env.FFMPEG_VIDEO_CODEC?.trim() || 'libx264';
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidVideoInput('invalid video codec');
  }
  return value;
}

function binaryName(binary: 'ffmpeg' | 'ffprobe'): string {
  const envName = binary === 'ffmpeg' ? 'FFMPEG_BIN' : 'FFPROBE_BIN';
  return process.env[envName]?.trim() || binary;
}

const MAX_CAPTURE_BYTES = 64 * 1024;

function appendCapped(current: string, chunk: Buffer): string {
  const remaining = MAX_CAPTURE_BYTES - current.length;
  return remaining <= 0 ? current : current + chunk.toString('utf8').slice(0, remaining);
}

export interface BinaryRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Spawn a configured binary with an argument array; never use a shell. */
export async function runBinary(binary: 'ffmpeg' | 'ffprobe', args: readonly string[]): Promise<BinaryRunResult> {
  const resolved = binaryName(binary);
  const failureCode = binary === 'ffprobe' ? 'FFPROBE_FAILED' : 'FFMPEG_FAILED';

  return await new Promise<BinaryRunResult>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const fail = (error: VideoPipelineError): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    let child;
    try {
      child = spawn(resolved, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      fail(new VideoPipelineError(failureCode, `${binary.toUpperCase()}_SPAWN_FAILED`, {
        binary,
        cause: error instanceof Error ? error.message : String(error),
      }));
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        fail(new FFmpegNotConfiguredError(binary));
        return;
      }
      fail(new VideoPipelineError(failureCode, `${binary.toUpperCase()}_SPAWN_FAILED`, {
        binary,
        cause: error.message,
        stderr: stderr.slice(-2000),
      }));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr, exitCode: 0 });
        return;
      }
      reject(new VideoPipelineError(failureCode, `${binary.toUpperCase()}_EXIT_${code ?? `SIGNAL_${signal ?? 'UNKNOWN'}`}`, {
        binary,
        exitCode: code,
        signal,
        stderr: stderr.slice(-2000),
      }));
    });
  });
}

/** Confirm the binary actually produced a non-empty regular file. */
export async function verifyOutputFile(outputPath: string): Promise<number> {
  const info = await stat(outputPath).catch(() => null);
  if (!info || !info.isFile() || info.size <= 0) {
    throw new VideoPipelineError('OUTPUT_NOT_CREATED', 'OUTPUT_NOT_CREATED', { path: outputPath });
  }
  return info.size;
}

export interface MediaStreamInfo {
  index: number;
  codecType: string;
  codecName: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  bitRate: number | null;
}

export interface MediaMetadata {
  path: string;
  formatName: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  bitRate: number | null;
  streams: MediaStreamInfo[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Probe a source file with real `ffprobe`; throws on missing binary or file. */
export async function probeMedia(targetPath: string): Promise<MediaMetadata> {
  const safePath = assertSafePath(targetPath, 'path');
  const info = await stat(safePath).catch(() => null);
  if (!info || !info.isFile()) {
    throw new MediaNotFoundError(safePath);
  }

  const args = ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', safePath];
  const { stdout } = await runBinary('ffprobe', args);

  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new VideoPipelineError('FFPROBE_FAILED', 'FFPROBE_INVALID_JSON', { stderr: stdout.slice(-2000) });
  }
  const root = asRecord(raw);
  const rawFormat = asRecord(root?.format);
  const rawStreams = root?.streams;
  if (!root || !rawFormat || !Array.isArray(rawStreams)) {
    throw new VideoPipelineError('FFPROBE_FAILED', 'FFPROBE_INVALID_JSON');
  }

  const streams: MediaStreamInfo[] = rawStreams.map((entry, index) => {
    const stream = asRecord(entry) ?? {};
    return {
      index: numberOrNull(stream.index) ?? index,
      codecType: stringOrNull(stream.codec_type) ?? 'unknown',
      codecName: stringOrNull(stream.codec_name),
      width: numberOrNull(stream.width),
      height: numberOrNull(stream.height),
      durationSeconds: numberOrNull(stream.duration),
      bitRate: numberOrNull(stream.bit_rate),
    };
  });

  return {
    path: safePath,
    formatName: stringOrNull(rawFormat.format_name),
    durationSeconds: numberOrNull(rawFormat.duration),
    sizeBytes: numberOrNull(rawFormat.size),
    bitRate: numberOrNull(rawFormat.bit_rate),
    streams,
  };
}

export interface ClipSegmentOptions {
  input: string;
  output: string;
  /** Seconds into the source; must be finite and non-negative. */
  start: number;
  /** Seconds to extract; must be strictly positive. */
  duration: number;
  /** Enable the 9:16 scale/crop filter (dimensions may be overridden). */
  vertical?: boolean;
  width?: number;
  height?: number;
  /** Video encoder for the re-encode; defaults to `FFMPEG_VIDEO_CODEC` or libx264. */
  codec?: string;
  /** Optional workspace temp directory that must contain `output`. */
  allowedTempDir?: string;
}

export interface ClipSegmentResult {
  outputPath: string;
  bytes: number;
  args: string[];
  durationMs: number;
}

function positiveDimension(value: number | undefined, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw invalidVideoInput(`${label} must be a positive integer`);
  }
  return value;
}

/** Cut one segment with real ffmpeg. Plain clips use stream copy. */
export async function clipSegment(options: ClipSegmentOptions): Promise<ClipSegmentResult> {
  const startedAt = performance.now();
  const input = assertSafePath(options.input, 'input');
  const output = assertSafePath(options.output, 'output');
  if (options.allowedTempDir !== undefined) {
    assertWithinDirectory(output, options.allowedTempDir);
  }
  if (!Number.isFinite(options.start) || options.start < 0) {
    throw invalidVideoInput('start must be finite and non-negative');
  }
  if (!Number.isFinite(options.duration) || options.duration <= 0) {
    throw invalidVideoInput('duration must be strictly positive');
  }

  const inputInfo = await stat(input).catch(() => null);
  if (!inputInfo || !inputInfo.isFile()) {
    throw new MediaNotFoundError(input);
  }

  const useFilter = options.vertical === true || options.width !== undefined || options.height !== undefined;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(options.start),
    '-i',
    input,
    '-t',
    String(options.duration),
  ];

  if (useFilter) {
    const width = positiveDimension(options.width, 'width', 1080);
    const height = positiveDimension(options.height, 'height', 1920);
    const filter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
    args.push('-vf', filter, '-c:v', resolveVideoCodec(options.codec), '-c:a', 'aac');
  } else {
    args.push('-c', 'copy');
  }
  args.push(output);

  await mkdir(path.dirname(output), { recursive: true });
  await runBinary('ffmpeg', args);
  const bytes = await verifyOutputFile(output);
  return { outputPath: output, bytes, args, durationMs: elapsedMs(startedAt) };
}

export interface ExportStep {
  name: 'probe' | 'clip' | 'subtitles';
  ok: boolean;
  durationMs: number;
  outputPath?: string;
  error?: VideoErrorInfo;
}

export interface ExportVideoOptions extends ClipSegmentOptions {
  /** Path to an existing SRT file; when set, subtitles are burned in. */
  subtitles?: string;
}

export interface ExportVideoSuccess {
  ok: true;
  outputPath: string;
  steps: ExportStep[];
  durationMs: number;
  metadata: MediaMetadata;
}

export interface ExportVideoFailure {
  ok: false;
  outputPath: null;
  steps: ExportStep[];
  durationMs: number;
  error: VideoErrorInfo;
  metadata: MediaMetadata | null;
}

export type ExportVideoResult = ExportVideoSuccess | ExportVideoFailure;

function failure(
  steps: ExportStep[],
  startedAt: number,
  error: unknown,
  metadata: MediaMetadata | null,
): ExportVideoFailure {
  const info = videoErrorInfo(error);
  return { ok: false, outputPath: null, steps, durationMs: elapsedMs(startedAt), error: info, metadata };
}

/**
 * Probe -> clip -> optional burn-in. Missing binaries and other failures are
 * reported in the result (never hidden behind an empty or fabricated video).
 */
export async function exportVideo(options: ExportVideoOptions): Promise<ExportVideoResult> {
  const startedAt = performance.now();
  const steps: ExportStep[] = [];

  let metadata: MediaMetadata;
  const probeStartedAt = performance.now();
  try {
    metadata = await probeMedia(options.input);
  } catch (error) {
    steps.push({ name: 'probe', ok: false, durationMs: elapsedMs(probeStartedAt), error: videoErrorInfo(error) });
    return failure(steps, startedAt, error, null);
  }
  steps.push({ name: 'probe', ok: true, durationMs: elapsedMs(probeStartedAt) });

  const srtPath = options.subtitles;
  const hasSubtitles = typeof srtPath === 'string' && srtPath.length > 0;
  let intermediate: string | null = null;
  let clipOutput = options.output;

  if (hasSubtitles) {
    const extension = path.extname(options.output) || '.mp4';
    const base = path.basename(options.output, extension);
    intermediate = path.join(
      path.dirname(options.output),
      `.${base}-clip-${randomUUID()}${extension}`,
    );
    clipOutput = intermediate;
  }

  const cleanIntermediate = async (): Promise<void> => {
    if (intermediate !== null) await unlink(intermediate).catch(() => undefined);
  };

  const clipStartedAt = performance.now();
  try {
    const clip = await clipSegment({ ...options, output: clipOutput });
    steps.push({ name: 'clip', ok: true, durationMs: clip.durationMs, outputPath: clip.outputPath });
  } catch (error) {
    steps.push({ name: 'clip', ok: false, durationMs: elapsedMs(clipStartedAt), error: videoErrorInfo(error) });
    await cleanIntermediate();
    return failure(steps, startedAt, error, metadata);
  }

  if (!hasSubtitles) {
    return { ok: true, outputPath: clipOutput, steps, durationMs: elapsedMs(startedAt), metadata };
  }

  const burnStartedAt = performance.now();
  try {
    const { burnSubtitles } = await import('./subtitles.js');
    const burned = await burnSubtitles({
      input: clipOutput,
      srt: srtPath as string,
      output: options.output,
      codec: options.codec,
    });
    steps.push({ name: 'subtitles', ok: true, durationMs: burned.durationMs, outputPath: burned.outputPath });
  } catch (error) {
    steps.push({ name: 'subtitles', ok: false, durationMs: elapsedMs(burnStartedAt), error: videoErrorInfo(error) });
    await cleanIntermediate();
    return failure(steps, startedAt, error, metadata);
  } finally {
    await cleanIntermediate();
  }

  return { ok: true, outputPath: options.output, steps, durationMs: elapsedMs(startedAt), metadata };
}

/**
 * Local transcription and deterministic highlight detection.
 *
 * Transcription uses a locally configured whisper.cpp CLI. No network service
 * and no paid provider is contacted. If the binary or model is unavailable,
 * every entry point fails with an explicit `NOT_CONFIGURED` code instead of
 * fabricating a transcript. Highlight detection is a pure, explainable rule
 * pass over a real transcript supplied by the caller or the local binary.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export type TranscriptionErrorCode =
  | 'NOT_CONFIGURED'
  | 'MEDIA_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'TRANSCRIBE_FAILED'
  | 'TRANSCRIPT_NOT_CREATED';

export interface TranscriptionErrorDetails {
  binary?: string;
  path?: string;
  exitCode?: number | null;
  reason?: string;
  stderr?: string;
}

export class TranscriptionError extends Error {
  readonly code: TranscriptionErrorCode;
  readonly details: TranscriptionErrorDetails;

  constructor(code: TranscriptionErrorCode, message: string, details: TranscriptionErrorDetails = {}) {
    super(message);
    this.name = 'TranscriptionError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function invalidInput(reason: string): TranscriptionError {
  return new TranscriptionError('INVALID_INPUT', 'INVALID_INPUT', { reason });
}

/** Accept absolute paths without traversal segments or NUL bytes. */
export function assertTranscriptionPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalidInput(`${label} must be a non-empty absolute path`);
  if (value.includes('\0')) throw invalidInput(`${label} must not contain NUL bytes`);
  if (value.split(/[\\/]/).includes('..')) throw invalidInput(`${label} must not contain path traversal segments`);
  if (!path.isAbsolute(value)) throw invalidInput(`${label} must be an absolute path`);
  return path.normalize(value);
}

export interface TranscriptSegment {
  startMs: number | null;
  endMs: number | null;
  text: string;
}

function parseTimestamp(value: string): number | null {
  const match = /^(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4].padEnd(3, '0'));
  if (minutes >= 60 || seconds >= 60) return null;
  return ((hours * 3600 + minutes * 60 + seconds) * 1000) + millis;
}

/** Parse timestamped transcript lines; untimed text becomes one null-time segment. */
export function parseTranscript(text: string): TranscriptSegment[] {
  const lines = text.split(/\r?\n/);
  const segments: TranscriptSegment[] = [];
  let pendingStart: number | null = null;
  let pendingEnd: number | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const times = trimmed.split(/-->/).map((part) => part.trim());
    if (times.length === 2) {
      const start = parseTimestamp(times[0]);
      const end = parseTimestamp(times[1]);
      if (start !== null && end !== null && end >= start) {
        pendingStart = start;
        pendingEnd = end;
      }
      continue;
    }
    if (pendingStart !== null) {
      segments.push({ startMs: pendingStart, endMs: pendingEnd, text: trimmed });
      pendingStart = null;
      pendingEnd = null;
    }
  }
  if (segments.length > 0) {
    for (let i = 0; i < segments.length - 1; i += 1) {
      if (segments[i].endMs === null) segments[i].endMs = segments[i + 1].startMs;
    }
  }
  if (segments.length === 0 && text.trim()) {
    segments.push({ startMs: null, endMs: null, text: text.trim() });
  }
  return segments;
}

export interface HighlightOptions {
  keywords?: string[];
  limit?: number;
  minScore?: number;
}

export interface Highlight {
  startMs: number | null;
  endMs: number | null;
  text: string;
  score: number;
  reasons: string[];
}

/** Explainable scoring of real transcript segments; no generation or invention. */
export function detectHighlights(text: string, options: HighlightOptions = {}): Highlight[] {
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 5) || 5));
  const minScore = Math.max(1, Math.min(20, Math.trunc(options.minScore ?? 2) || 2));
  const keywords = (options.keywords ?? [])
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 0)
    .slice(0, 50);
  const scored: Highlight[] = [];
  for (const segment of parseTranscript(text)) {
    const lower = segment.text.toLowerCase();
    const reasons: string[] = [];
    for (const keyword of keywords) {
      if (lower.includes(keyword)) reasons.push(`keyword:${keyword}`);
    }
    if (segment.text.includes('?')) reasons.push('question');
    if (segment.text.includes('!')) reasons.push('emphasis');
    if (/\d/.test(segment.text)) reasons.push('number_or_stat');
    if (segment.text.length >= 40 && segment.text.length <= 240) reasons.push('substantive_length');
    const score = reasons.length;
    if (score < minScore) continue;
    scored.push({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text, score, reasons });
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.startMs ?? Number.MAX_SAFE_INTEGER) - (b.startMs ?? Number.MAX_SAFE_INTEGER))
    .slice(0, limit);
}

/** Strict language allowlist. `auto` is Whisper's own language detection. */
export const TRANSCRIPTION_LANGUAGES = ['de', 'en', 'auto'] as const;
export type TranscriptionLanguage = (typeof TRANSCRIPTION_LANGUAGES)[number];

/** Reject every language outside the allowlist instead of forwarding arbitrary CLI flags. */
export function normalizeTranscriptionLanguage(value: unknown): TranscriptionLanguage | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalidInput('language must be one of de, en, auto');
  const language = value.trim().toLowerCase();
  if (!TRANSCRIPTION_LANGUAGES.includes(language as TranscriptionLanguage)) {
    throw invalidInput('language must be one of de, en, auto');
  }
  return language as TranscriptionLanguage;
}

export interface TranscribeOptions {
  audioPath: string;
  outputDir: string;
  /** Explicit model paths are only for trusted local callers; API clients cannot supply one. */
  modelPath?: string;
  binary?: string;
  language?: TranscriptionLanguage;
  /** Bound CPU use; defaults to one thread on small hosts. */
  threads?: number;
  timeoutMs?: number;
  /** Cooperative cancellation; aborts kill the live whisper process. */
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  ok: true;
  text: string;
  segments: TranscriptSegment[];
  transcriptPath: string;
  /** Timestamped SRT produced by whisper.cpp when available. */
  timedTranscriptPath?: string;
  durationMs: number;
}

function binaryPath(explicit?: string): string {
  return explicit?.trim() || process.env.WHISPER_BIN?.trim() || 'whisper';
}

/** Bounded whisper timeout, configurable without ever becoming unbounded. */
export function whisperTimeoutMs(explicit?: number): number {
  const raw = explicit ?? Number(process.env.WHISPER_TIMEOUT_MS ?? 300_000);
  return Number.isFinite(raw) ? Math.max(1000, Math.min(600_000, Math.trunc(raw))) : 300_000;
}

/** Threads stay conservative by default; raising the cap is an explicit operator choice. */
export function whisperThreadCount(explicit?: number): number {
  const configuredMax = Number(process.env.WHISPER_THREADS_MAX ?? 2);
  const cap = Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.max(1, Math.min(8, Math.trunc(configuredMax)))
    : 2;
  const raw = explicit ?? Number(process.env.WHISPER_THREADS ?? 1);
  return Number.isFinite(raw) ? Math.max(1, Math.min(cap, Math.trunc(raw))) : 1;
}

/** English-only weights must never silently satisfy a German request. */
function assertMultilingualModel(model: string, language?: TranscriptionLanguage): void {
  if ((language === 'de' || language === 'auto') && /(?:\.en|-en)\.bin$/i.test(path.basename(model))) {
    throw new TranscriptionError('NOT_CONFIGURED', 'WHISPER_MULTILINGUAL_MODEL_REQUIRED', { path: model });
  }
}

/**
 * Server-side model selection. `de` requires an explicit multilingual model;
 * `auto` prefers one but can use the English model when none is configured.
 */
export function resolveTranscriptionModel(language?: TranscriptionLanguage, explicitModelPath?: string): string {
  if (explicitModelPath !== undefined) {
    const model = assertTranscriptionPath(explicitModelPath, 'modelPath');
    assertMultilingualModel(model, language);
    return model;
  }
  const multilingual = process.env.WHISPER_MODEL_MULTILINGUAL?.trim();
  if (language === 'de') {
    if (!multilingual) {
      throw new TranscriptionError('NOT_CONFIGURED', 'WHISPER_MULTILINGUAL_MODEL_NOT_CONFIGURED');
    }
    const model = assertTranscriptionPath(multilingual, 'WHISPER_MODEL_MULTILINGUAL');
    assertMultilingualModel(model, language);
    return model;
  }
  if (language === 'auto' && multilingual) {
    const model = assertTranscriptionPath(multilingual, 'WHISPER_MODEL_MULTILINGUAL');
    assertMultilingualModel(model, language);
    return model;
  }
  const configured = process.env.WHISPER_MODEL?.trim();
  if (!configured) throw new TranscriptionError('NOT_CONFIGURED', 'WHISPER_MODEL_NOT_CONFIGURED');
  const model = assertTranscriptionPath(configured, 'WHISPER_MODEL');
  assertMultilingualModel(model, language);
  return model;
}

/** Spawn whisper with argument arrays only; abort kills the live child. */
export async function runWhisper(binary: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = '';
    if (signal?.aborted) {
      reject(new TranscriptionError('TRANSCRIBE_FAILED', 'TRANSCRIBE_ABORTED', { binary, reason: 'aborted' }));
      return;
    }
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    const finish = (error?: TranscriptionError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => {
      if (settled) return;
      child.kill('SIGKILL');
      finish(new TranscriptionError('TRANSCRIBE_FAILED', 'TRANSCRIBE_ABORTED', { binary, reason: 'aborted' }));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      finish(new TranscriptionError('TRANSCRIBE_FAILED', 'TRANSCRIBE_TIMEOUT', { binary }));
    }, timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        finish(new TranscriptionError('NOT_CONFIGURED', 'WHISPER_NOT_CONFIGURED', { binary }));
      } else {
        finish(new TranscriptionError('TRANSCRIBE_FAILED', 'WHISPER_SPAWN_FAILED', { binary, reason: error.message }));
      }
    });
    child.once('close', (code, closeSignal) => {
      if (code === 0) {
        finish();
      } else {
        finish(new TranscriptionError('TRANSCRIBE_FAILED', `WHISPER_EXIT_${code ?? `SIGNAL_${closeSignal ?? 'UNKNOWN'}`}`, { binary, exitCode: code, stderr }));
      }
    });
  });
}

/** Run a real local whisper.cpp process and return only the file it produced. */
export async function transcribeAudio(options: TranscribeOptions): Promise<TranscriptionResult> {
  const startedAt = performance.now();
  const audio = assertTranscriptionPath(options.audioPath, 'audioPath');
  const outputDir = assertTranscriptionPath(options.outputDir, 'outputDir');
  const binary = binaryPath(options.binary);
  const language = normalizeTranscriptionLanguage(options.language);

  const audioInfo = await stat(audio).catch(() => null);
  if (!audioInfo || !audioInfo.isFile()) throw new TranscriptionError('MEDIA_NOT_FOUND', 'MEDIA_NOT_FOUND', { path: audio });
  const model = resolveTranscriptionModel(language, options.modelPath);
  const modelExists = (await stat(model).catch(() => null))?.isFile();
  if (!modelExists) {
    const configuredMultilingual = process.env.WHISPER_MODEL_MULTILINGUAL?.trim();
    const missingMultilingual = !options.modelPath && configuredMultilingual && path.resolve(configuredMultilingual) === path.resolve(model);
    throw new TranscriptionError(
      'NOT_CONFIGURED',
      missingMultilingual ? 'WHISPER_MULTILINGUAL_MODEL_NOT_FOUND' : 'WHISPER_MODEL_NOT_FOUND',
      { path: model },
    );
  }
  if (!/^[A-Za-z0-9_./-]{1,128}$/.test(binary)) throw invalidInput('invalid whisper binary path');
  if (options.signal?.aborted) throw new TranscriptionError('TRANSCRIBE_FAILED', 'TRANSCRIBE_ABORTED', { binary, reason: 'aborted' });

  await mkdir(outputDir, { recursive: true });
  const outputBase = path.join(outputDir, `transcript-${randomUUID()}`);
  const args = ['-m', model, '-f', audio, '-otxt', '-osrt', '-of', outputBase];
  if (language) args.push('-l', language);
  args.push('-t', String(whisperThreadCount(options.threads)));
  await runWhisper(binary, args, whisperTimeoutMs(options.timeoutMs), options.signal);

  const transcriptPath = `${outputBase}.txt`;
  const produced = await stat(transcriptPath).catch(() => null);
  if (!produced || !produced.isFile()) {
    throw new TranscriptionError('TRANSCRIPT_NOT_CREATED', 'TRANSCRIPT_NOT_CREATED', { path: transcriptPath });
  }
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(transcriptPath, 'utf8');
  const timedTranscriptPath = `${outputBase}.srt`;
  const timedInfo = await stat(timedTranscriptPath).catch(() => null);
  const timedText = timedInfo?.isFile() ? await readFile(timedTranscriptPath, 'utf8') : null;
  return {
    ok: true,
    text,
    segments: parseTranscript(timedText ?? text),
    transcriptPath,
    ...(timedText === null ? {} : { timedTranscriptPath }),
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

function formatHighlightTimestamp(ms: number | null): string {
  const safe = Math.max(0, Math.trunc(ms ?? 0));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function transcriptForHighlights(result: TranscriptionResult): string {
  const hasTimings = result.segments.some((segment) => segment.startMs !== null);
  if (!hasTimings) return result.text;
  return result.segments
    .map((segment) => {
      if (segment.startMs === null) return segment.text;
      return `${formatHighlightTimestamp(segment.startMs)} --> ${formatHighlightTimestamp(segment.endMs)}\n${segment.text}`;
    })
    .join('\n\n');
}

/** Transcribe real audio, then derive explainable highlights from that transcript. */
export async function transcribeAndHighlight(options: TranscribeOptions & HighlightOptions) {
  const result = await transcribeAudio(options);
  return {
    ...result,
    highlights: detectHighlights(transcriptForHighlights(result), options),
  };
}

/** Write a transcript to disk only when called explicitly by the workspace owner. */
export async function writeTranscript(text: string, outputPath: string): Promise<string> {
  const target = assertTranscriptionPath(outputPath, 'outputPath');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
  return target;
}

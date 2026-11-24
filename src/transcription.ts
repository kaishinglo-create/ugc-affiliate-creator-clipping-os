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
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const times = trimmed.split(/-->/).map((part) => part.trim());
    if (times.length === 2) {
      const start = parseTimestamp(times[0]);
      const end = parseTimestamp(times[1]);
      if (start !== null && end !== null && end >= start) pendingStart = start;
      continue;
    }
    if (pendingStart !== null) {
      segments.push({ startMs: pendingStart, endMs: null, text: trimmed });
      pendingStart = null;
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

export interface TranscribeOptions {
  audioPath: string;
  outputDir: string;
  modelPath?: string;
  binary?: string;
  language?: string;
  timeoutMs?: number;
}

export interface TranscriptionResult {
  ok: true;
  text: string;
  segments: TranscriptSegment[];
  transcriptPath: string;
  durationMs: number;
}

function binaryPath(explicit?: string): string {
  return explicit?.trim() || process.env.WHISPER_BIN?.trim() || 'whisper';
}

async function runWhisper(binary: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new TranscriptionError('TRANSCRIBE_FAILED', 'TRANSCRIBE_TIMEOUT', { binary }));
    }, timeoutMs);
    timer.unref();
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        reject(new TranscriptionError('NOT_CONFIGURED', 'WHISPER_NOT_CONFIGURED', { binary }));
      } else {
        reject(new TranscriptionError('TRANSCRIBE_FAILED', 'WHISPER_SPAWN_FAILED', { binary, reason: error.message }));
      }
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new TranscriptionError('TRANSCRIBE_FAILED', `WHISPER_EXIT_${code ?? `SIGNAL_${signal ?? 'UNKNOWN'}`}`, { binary, exitCode: code, stderr }));
    });
  });
}

/** Run a real local whisper.cpp process and return only the file it produced. */
export async function transcribeAudio(options: TranscribeOptions): Promise<TranscriptionResult> {
  const startedAt = performance.now();
  const audio = assertTranscriptionPath(options.audioPath, 'audioPath');
  const outputDir = assertTranscriptionPath(options.outputDir, 'outputDir');
  const binary = binaryPath(options.binary);
  const model = options.modelPath ? assertTranscriptionPath(options.modelPath, 'modelPath') : process.env.WHISPER_MODEL?.trim() || '';

  const audioInfo = await stat(audio).catch(() => null);
  if (!audioInfo || !audioInfo.isFile()) throw new TranscriptionError('MEDIA_NOT_FOUND', 'MEDIA_NOT_FOUND', { path: audio });
  if (!model) throw new TranscriptionError('NOT_CONFIGURED', 'WHISPER_MODEL_NOT_CONFIGURED', { binary });
  if (model && !(await stat(model).catch(() => null))?.isFile()) {
    throw new TranscriptionError('NOT_CONFIGURED', 'WHISPER_MODEL_NOT_FOUND', { path: model });
  }
  if (!/^[A-Za-z0-9_./-]{1,128}$/.test(binary)) throw invalidInput('invalid whisper binary path');

  await mkdir(outputDir, { recursive: true });
  const outputBase = path.join(outputDir, `transcript-${randomUUID()}`);
  const args = ['-m', model, '-f', audio, '-otxt', '-of', outputBase];
  if (options.language?.trim()) args.push('-l', options.language.trim().slice(0, 16));
  await runWhisper(binary, args, Math.max(1000, Math.min(600_000, Number(options.timeoutMs) || 120_000)));

  const transcriptPath = `${outputBase}.txt`;
  const produced = await stat(transcriptPath).catch(() => null);
  if (!produced || !produced.isFile()) {
    throw new TranscriptionError('TRANSCRIPT_NOT_CREATED', 'TRANSCRIPT_NOT_CREATED', { path: transcriptPath });
  }
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(transcriptPath, 'utf8');
  return {
    ok: true,
    text,
    segments: parseTranscript(text),
    transcriptPath,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

/** Transcribe real audio, then derive explainable highlights from that transcript. */
export async function transcribeAndHighlight(options: TranscribeOptions & HighlightOptions) {
  const result = await transcribeAudio(options);
  return {
    ...result,
    highlights: detectHighlights(result.text, options),
  };
}

/** Write a transcript to disk only when called explicitly by the workspace owner. */
export async function writeTranscript(text: string, outputPath: string): Promise<string> {
  const target = assertTranscriptionPath(outputPath, 'outputPath');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
  return target;
}

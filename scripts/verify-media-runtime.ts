/**
 * Real local media runtime verification (no test doubles).
 *
 * Requires: ffmpeg/ffprobe on PATH (or FFMPEG_BIN/FFPROBE_BIN), a whisper.cpp
 * CLI binary (WHISPER_BIN) and a local model (WHISPER_MODEL). Defaults point to
 * the resource-conscious tiny.en setup used on this host. The script creates a
 * real video from a real speech sample, extracts audio, transcribes it, derives
 * timed highlights, exports a vertical subtitled clip and verifies the burn-in
 * against an otherwise identical plain clip.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { clipSegment, exportVideo, extractAudio, probeMedia, runBinary } from '../src/video/clipping.js';
import { writeSrt, type SrtCue } from '../src/video/subtitles.js';
import { transcribeAndHighlight, whisperTimeoutMs } from '../src/transcription.js';

const WHISPER_HOME = path.join(homedir(), '.local/share/ugc-media/whisper');
const VERIFY_DIR = process.env.MEDIA_VERIFY_DIR?.trim() || '/tmp/opencode/ugc-media-verify';
const SAMPLE = process.env.WHISPER_SAMPLE?.trim() || path.join(WHISPER_HOME, 'samples/en-test-sentence-cc0.wav');
const WHISPER_CLI = process.env.WHISPER_BIN?.trim() || path.join(WHISPER_HOME, 'whisper-cli');
const WHISPER_MODEL = process.env.WHISPER_MODEL?.trim() || path.join(WHISPER_HOME, 'ggml-tiny.en.bin');
const WHISPER_MODEL_MULTILINGUAL = process.env.WHISPER_MODEL_MULTILINGUAL?.trim() || path.join(WHISPER_HOME, 'ggml-tiny.bin');
const SAMPLE_DE = process.env.WHISPER_SAMPLE_DE?.trim() || path.join(WHISPER_HOME, 'samples/de-deutschland-cc0.flac');
const WIDTH = 720;
const HEIGHT = 1280;

async function fileExists(target: string): Promise<boolean> {
  const info = await stat(target).catch(() => null);
  return Boolean(info?.isFile());
}

async function requireFile(target: string, label: string): Promise<void> {
  if (!await fileExists(target)) throw new Error(`${label}_NOT_FOUND: ${target}`);
}

/** Prefer permanent assets; only fall back to legacy /tmp paths when needed. */
async function firstExisting(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return candidates[0];
}

async function runGermanCase(binary: string): Promise<Record<string, unknown>> {
  const [modelOk, sampleOk] = await Promise.all([
    fileExists(WHISPER_MODEL_MULTILINGUAL),
    fileExists(SAMPLE_DE),
  ]);
  if (!modelOk || !sampleOk) {
    return {
      status: 'SKIPPED_EXTERNAL_SAMPLE',
      reason: !modelOk ? 'WHISPER_MODEL_MULTILINGUAL_NOT_FOUND' : 'GERMAN_SAMPLE_NOT_FOUND',
      modelPath: WHISPER_MODEL_MULTILINGUAL,
      samplePath: SAMPLE_DE,
    };
  }
  const started = Date.now();
  const transcription = await transcribeAndHighlight({
    audioPath: SAMPLE_DE,
    outputDir: VERIFY_DIR,
    modelPath: WHISPER_MODEL_MULTILINGUAL,
    binary,
    language: 'de',
    threads: 1,
    timeoutMs: whisperTimeoutMs(),
    keywords: ['deutschland'],
    minScore: 1,
  });
  const text = transcription.text.replace(/\s+/g, ' ').trim();
  return {
    status: 'OK',
    language: 'de',
    text,
    containsExpectedGermanWord: /deutschland/i.test(text),
    segmentCount: transcription.segments.length,
    durationMs: Date.now() - started,
    samplePath: SAMPLE_DE,
    modelPath: WHISPER_MODEL_MULTILINGUAL,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function main(): Promise<void> {
  const whisperCli = await firstExisting([
    WHISPER_CLI,
    '/tmp/opencode/whisper.cpp/build/bin/whisper-cli', // legacy only
  ]);
  const whisperModel = await firstExisting([
    WHISPER_MODEL,
    '/tmp/opencode/whisper.cpp/models/ggml-tiny.en.bin', // legacy only
  ]);
  const sample = await firstExisting([
    SAMPLE,
    '/tmp/opencode/whisper.cpp/samples/jfk.wav', // legacy only
  ]);
  await Promise.all([
    requireFile(sample, 'WHISPER_SAMPLE'),
    requireFile(whisperCli, 'WHISPER_BIN'),
    requireFile(whisperModel, 'WHISPER_MODEL'),
  ]);
  await mkdir(VERIFY_DIR, { recursive: true });

  process.env.WHISPER_BIN = whisperCli;
  process.env.WHISPER_MODEL = whisperModel;
  process.env.WHISPER_THREADS = '1';

  const source = path.join(VERIFY_DIR, 'source.mp4');
  const audio = path.join(VERIFY_DIR, 'speech.wav');
  const srt = path.join(VERIFY_DIR, 'captions.srt');
  const output = path.join(VERIFY_DIR, 'highlight-vertical-subtitled.mp4');
  const plain = path.join(VERIFY_DIR, 'highlight-vertical-plain.mp4');
  const frame = path.join(VERIFY_DIR, 'subtitled-frame.png');

  await runBinary('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=navy:s=1280x720:r=25:d=11',
    '-stream_loop', '-1', '-i', sample,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
    '-threads', '1', '-c:a', 'aac', '-shortest', source,
  ]);
  const extracted = await extractAudio({ input: source, output: audio, allowedTempDir: VERIFY_DIR });
  const sourceMetadata = await probeMedia(source);

  const transcription = await transcribeAndHighlight({
    audioPath: audio,
    outputDir: VERIFY_DIR,
    modelPath: whisperModel,
    binary: whisperCli,
    language: 'en',
    threads: 1,
    timeoutMs: whisperTimeoutMs(),
    keywords: ['test', 'sentence', 'this'],
    minScore: 1,
  });
  const timed = transcription.segments.filter(
    (segment) => segment.startMs !== null && segment.endMs !== null && segment.endMs > segment.startMs,
  );
  if (timed.length === 0) {
    throw new Error('REAL_TRANSCRIPT_MISSING_TIMESTAMPS: whisper.cpp did not produce an SRT with timings');
  }

  const startMs = timed[0].startMs as number;
  const endMs = timed[timed.length - 1].endMs as number;
  const duration = clamp((endMs - startMs) / 1000, 1, 8);
  const cues: SrtCue[] = timed
    .map((segment) => ({
      start: clamp(((segment.startMs as number) - startMs) / 1000, 0, duration),
      end: clamp(((segment.endMs as number) - startMs) / 1000, 0, duration),
      text: segment.text.replace(/\s+/g, ' ').trim().slice(0, 160),
    }))
    .filter((cue) => cue.end > cue.start && cue.text.length > 0)
    .slice(0, 12);
  if (cues.length === 0) {
    throw new Error('NO_TIMED_CUES: real transcript produced no usable subtitle cues');
  }
  await writeSrt(cues, srt);

  const exportResult = await exportVideo({
    input: source,
    output,
    start: startMs / 1000,
    duration,
    vertical: true,
    width: WIDTH,
    height: HEIGHT,
    subtitles: srt,
    allowedTempDir: VERIFY_DIR,
    threads: 1,
  });
  if (!exportResult.ok) throw new Error(`REAL_EXPORT_FAILED: ${exportResult.error.code} ${exportResult.error.message}`);
  const outputMetadata = await probeMedia(output);

  await clipSegment({
    input: source,
    output: plain,
    start: startMs / 1000,
    duration,
    vertical: true,
    width: WIDTH,
    height: HEIGHT,
    allowedTempDir: VERIFY_DIR,
    threads: 1,
  });
  const comparison = await runBinary('ffmpeg', [
    '-hide_banner', '-i', output, '-i', plain, '-lavfi', 'ssim', '-f', 'null', '-',
  ]);
  const match = /All:([0-9.]+)/.exec(comparison.stderr);
  const ssimAll = match ? Number(match[1]) : null;
  if (ssimAll === null || !Number.isFinite(ssimAll)) {
    throw new Error('SUBTITLE_VALIDATION_FAILED: ffmpeg SSIM value missing');
  }
  if (ssimAll >= 0.999) {
    throw new Error(`SUBTITLE_BURN_IN_NOT_VISIBLE: SSIM ${ssimAll} between subtitled and plain clip`);
  }
  await runBinary('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', output, '-frames:v', '1', frame,
  ]);

  const germanCase = await runGermanCase(whisperCli);
  if (germanCase.status === 'OK' && germanCase.containsExpectedGermanWord !== true) {
    throw new Error(`GERMAN_TRANSCRIPT_UNEXPECTED: ${String(germanCase.text).slice(0, 240)}`);
  }

  const report = {
    ok: true,
    at: new Date().toISOString(),
    languageCases: { en: { status: 'OK', language: 'en', text: transcription.text.trim() }, de: germanCase },
    binaries: { whisperCli, model: whisperModel, multilingualModel: WHISPER_MODEL_MULTILINGUAL, sample },
    source: { durationSeconds: sourceMetadata.durationSeconds, sizeBytes: sourceMetadata.sizeBytes },
    audio: { outputPath: extracted.outputPath, bytes: extracted.bytes },
    transcription: {
      text: transcription.text.trim(),
      timedTranscriptPath: transcription.timedTranscriptPath ?? null,
      highlights: transcription.highlights,
      durationMs: transcription.durationMs,
    },
    subtitleCues: cues,
    clip: {
      startMs,
      durationSeconds: duration,
      width: WIDTH,
      height: HEIGHT,
      outputPath: output,
      bytes: exportResult.steps.find((step) => step.name === 'subtitles')?.outputPath ? outputMetadata.sizeBytes : 0,
      durationSeconds: outputMetadata.durationSeconds,
      streams: outputMetadata.streams.map((stream) => ({
        codec: stream.codecName,
        type: stream.codecType,
        width: stream.width,
        height: stream.height,
      })),
      steps: exportResult.steps,
    },
    visualValidation: { ssimAllComparedToPlainClip: ssimAll, framePath: frame },
  };
  await writeFile(path.join(VERIFY_DIR, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    transcript: report.transcription.text,
    highlights: report.transcription.highlights.length,
    clip: report.clip.durationSeconds,
    dimensions: `${WIDTH}x${HEIGHT}`,
    ssimAll: ssimAll,
    languageCases: {
      en: 'OK',
      de: germanCase.status,
      ...(germanCase.status === 'OK' ? { deText: germanCase.text, deContainsExpectedWord: germanCase.containsExpectedGermanWord } : { deReason: germanCase.reason }),
    },
    report: path.join(VERIFY_DIR, 'verification.json'),
  }, null, 2));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MEDIA_RUNTIME_VERIFICATION_FAILED: ${message}`);
  process.exitCode = 1;
});

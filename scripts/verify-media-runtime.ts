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
import path from 'node:path';
import { clipSegment, exportVideo, extractAudio, probeMedia, runBinary } from '../src/video/clipping.js';
import { writeSrt, type SrtCue } from '../src/video/subtitles.js';
import { transcribeAndHighlight } from '../src/transcription.js';

const VERIFY_DIR = process.env.MEDIA_VERIFY_DIR?.trim() || '/tmp/opencode/ugc-media-verify';
const SAMPLE = process.env.WHISPER_SAMPLE?.trim() || '/tmp/opencode/whisper.cpp/samples/jfk.wav';
const WHISPER_CLI = process.env.WHISPER_BIN?.trim() || '/tmp/opencode/whisper.cpp/build/bin/whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL?.trim() || '/tmp/opencode/whisper.cpp/models/ggml-tiny.en.bin';
const WIDTH = 720;
const HEIGHT = 1280;

async function requireFile(target: string, label: string): Promise<void> {
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new Error(`${label}_NOT_FOUND: ${target}`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function main(): Promise<void> {
  await Promise.all([
    requireFile(SAMPLE, 'WHISPER_SAMPLE'),
    requireFile(WHISPER_CLI, 'WHISPER_BIN'),
    requireFile(WHISPER_MODEL, 'WHISPER_MODEL'),
  ]);
  await mkdir(VERIFY_DIR, { recursive: true });

  process.env.WHISPER_BIN = WHISPER_CLI;
  process.env.WHISPER_MODEL = WHISPER_MODEL;
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
    '-i', SAMPLE,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
    '-c:a', 'aac', '-shortest', source,
  ]);
  const extracted = await extractAudio({ input: source, output: audio, allowedTempDir: VERIFY_DIR });
  const sourceMetadata = await probeMedia(source);

  const transcription = await transcribeAndHighlight({
    audioPath: audio,
    outputDir: VERIFY_DIR,
    modelPath: WHISPER_MODEL,
    binary: WHISPER_CLI,
    language: 'en',
    threads: 1,
    timeoutMs: 300_000,
    keywords: ['country', 'americans', 'fellow'],
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

  const report = {
    ok: true,
    at: new Date().toISOString(),
    binaries: { whisperCli: WHISPER_CLI, model: WHISPER_MODEL, sample: SAMPLE },
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
    report: path.join(VERIFY_DIR, 'verification.json'),
  }, null, 2));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MEDIA_RUNTIME_VERIFICATION_FAILED: ${message}`);
  process.exitCode = 1;
});

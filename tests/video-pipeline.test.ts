/**
 * Video pipeline tests using TEST DOUBLES only.
 *
 * The `ffmpeg` and `ffprobe` stand-ins below are tiny shell scripts that record
 * argv and either emit a fixed JSON document or write a placeholder byte file.
 * They are not real encoders/probers and the placeholder file is NOT real media;
 * the assertions only verify argument construction, validation and error
 * classification. Real media requires real binaries on the host.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clipSegment, exportVideo, probeMedia } from '../src/video/clipping.js';
import { burnSubtitles, escapeFilterPath, writeSrt } from '../src/video/subtitles.js';

const FFMPEG_DOUBLE = `#!/bin/sh
# TEST DOUBLE for ffmpeg: record argv, then write a placeholder byte file.
# This placeholder is NOT real media.
printf '%s\\n' "$@" >> "$FFMPEG_ARGV_LOG" || exit 1
printf '%s\\n' '--' >> "$FFMPEG_ARGV_LOG" || exit 1
last=''
for arg in "$@"; do last="$arg"; done
mkdir -p "$(dirname "$last")" || exit 1
printf 'test-double-output' > "$last" || exit 1
exit 0
`;

const FFPROBE_DOUBLE = `#!/bin/sh
# TEST DOUBLE for ffprobe: record argv, then emit fixed minimal JSON.
# This JSON is NOT derived from real media.
printf '%s\\n' "$@" >> "$FFPROBE_ARGV_LOG" || exit 1
printf '%s\\n' '--' >> "$FFPROBE_ARGV_LOG" || exit 1
cat <<'JSON'
{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"duration":"12.5","bit_rate":"3000000"},{"index":1,"codec_type":"audio","codec_name":"aac","width":null,"height":null,"duration":"12.5","bit_rate":"128000"}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"12.5","size":"4000000","bit_rate":"3200000"}}
JSON
`;

const TRACKED_ENV = ['FFMPEG_BIN', 'FFPROBE_BIN', 'FFMPEG_ARGV_LOG', 'FFPROBE_ARGV_LOG', 'FFMPEG_VIDEO_CODEC'];

async function writeExecutable(filePath: string, body: string): Promise<void> {
  await writeFile(filePath, body, { mode: 0o755 });
  await chmod(filePath, 0o755);
}

/** Split the doubles' append-only argv log into invocations. */
async function argvGroups(logPath: string): Promise<string[][]> {
  const contents = await readFile(logPath, 'utf8').catch(() => '');
  return contents
    .split('\n--\n')
    .filter((group) => group.length > 0)
    .map((group) => group.split('\n').filter((line) => line.length > 0));
}

describe('video pipeline (ffmpeg/ffprobe test doubles)', () => {
  let root: string;
  let ffmpegLog: string;
  let ffprobeLog: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const name of TRACKED_ENV) originalEnv[name] = process.env[name];
    root = await mkdtemp(path.join(tmpdir(), 'ugc-video-doubles-'));
    const binDir = path.join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeExecutable(path.join(binDir, 'ffmpeg-test-double'), FFMPEG_DOUBLE);
    await writeExecutable(path.join(binDir, 'ffprobe-test-double'), FFPROBE_DOUBLE);
    process.env.FFMPEG_BIN = path.join(binDir, 'ffmpeg-test-double');
    process.env.FFPROBE_BIN = path.join(binDir, 'ffprobe-test-double');
    ffmpegLog = path.join(root, 'ffmpeg.argv');
    ffprobeLog = path.join(root, 'ffprobe.argv');
    process.env.FFMPEG_ARGV_LOG = ffmpegLog;
    process.env.FFPROBE_ARGV_LOG = ffprobeLog;
    delete process.env.FFMPEG_VIDEO_CODEC;
  });

  afterEach(async () => {
    for (const name of TRACKED_ENV) {
      const value = originalEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  /** Placeholder source bytes: enough for stat(), never presented as real media. */
  async function source(): Promise<string> {
    const input = path.join(root, 'source.mp4');
    await writeFile(input, 'test-double-source-placeholder');
    return input;
  }

  function disableBinaries(): void {
    process.env.FFMPEG_BIN = path.join(root, 'missing-ffmpeg-binary');
    process.env.FFPROBE_BIN = path.join(root, 'missing-ffprobe-binary');
  }

  it('probeMedia parses structured metadata and passes exact ffprobe argv to the test double', async () => {
    const input = await source();
    const metadata = await probeMedia(input);

    expect(metadata).toEqual({
      path: input,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: 12.5,
      sizeBytes: 4000000,
      bitRate: 3200000,
      streams: [
        {
          index: 0,
          codecType: 'video',
          codecName: 'h264',
          width: 1920,
          height: 1080,
          durationSeconds: 12.5,
          bitRate: 3000000,
        },
        {
          index: 1,
          codecType: 'audio',
          codecName: 'aac',
          width: null,
          height: null,
          durationSeconds: 12.5,
          bitRate: 128000,
        },
      ],
    });
    expect(await argvGroups(ffprobeLog)).toEqual([
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input],
    ]);
  });

  it('probeMedia classifies a missing source as MEDIA_NOT_FOUND', async () => {
    await expect(probeMedia(path.join(root, 'not-there.mp4'))).rejects.toMatchObject({
      code: 'MEDIA_NOT_FOUND',
    });
  });

  it('clipSegment uses stream copy for a plain clip with exact ffmpeg argv', async () => {
    const input = await source();
    const output = path.join(root, 'plain', 'clip.mp4');
    const result = await clipSegment({ input, output, start: 1.5, duration: 3 });

    expect(result.args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      '1.5',
      '-i',
      input,
      '-t',
      '3',
      '-c',
      'copy',
      output,
    ]);
    expect(result.outputPath).toBe(output);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect((await stat(output)).size).toBe(result.bytes);
    expect(await argvGroups(ffmpegLog)).toEqual([result.args]);
  });

  it('clipSegment builds the exact vertical scale/crop filter and uses a configurable codec', async () => {
    const input = await source();
    const output = path.join(root, 'vertical.mp4');
    const result = await clipSegment({ input, output, start: 2, duration: 4, vertical: true, codec: 'mpeg4' });

    expect(result.args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      '2',
      '-i',
      input,
      '-t',
      '4',
      '-vf',
      'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
      '-c:v',
      'mpeg4',
      '-c:a',
      'aac',
      output,
    ]);

    const custom = await clipSegment({
      input,
      output: path.join(root, 'vertical-custom.mp4'),
      start: 0,
      duration: 1,
      vertical: true,
      width: 720,
      height: 1280,
    });
    expect(custom.args).toContain('scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280');
    expect(custom.args).toContain('libx264');
  });

  it('clipSegment rejects invalid duration, traversal and output outside allowedTempDir', async () => {
    const input = await source();
    const allowed = path.join(root, 'workspace-tmp');
    await mkdir(allowed, { recursive: true });

    await expect(clipSegment({ input, output: path.join(root, 'zero.mp4'), start: 0, duration: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(clipSegment({ input, output: `${root}/../escape.mp4`, start: 0, duration: 1 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(clipSegment({
      input,
      output: path.join(root, 'outside.mp4'),
      start: 0,
      duration: 1,
      allowedTempDir: allowed,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(clipSegment({
      input,
      output: `${allowed}/../outside.mp4`,
      start: 0,
      duration: 1,
      allowedTempDir: allowed,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await argvGroups(ffmpegLog)).toEqual([]);
  });

  it('writeSrt produces valid SRT and rejects invalid cue timestamps', async () => {
    const srtPath = path.join(root, 'subs', 'captions.srt');
    const written = await writeSrt(
      [
        { start: 0, end: 1.25, text: 'Hello' },
        { index: 7, start: 61.005, end: 62, text: 'World' },
      ],
      srtPath,
    );

    expect(written).toBe(srtPath);
    expect(await readFile(srtPath, 'utf8')).toBe(
      '1\n00:00:00,000 --> 00:00:01,250\nHello\n\n7\n00:01:01,005 --> 00:01:02,000\nWorld\n',
    );
    await expect(writeSrt([{ start: 2, end: 1, text: 'bad' }], path.join(root, 'bad.srt')))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(writeSrt([{ start: -1, end: 1, text: 'bad' }], path.join(root, 'bad.srt')))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('burnSubtitles escapes the SRT path in the ffmpeg subtitles filter', async () => {
    const input = await source();
    const srt = await writeSrt([{ start: 0, end: 1, text: 'Hello' }], path.join(root, 'sub:title.srt'));
    const output = path.join(root, 'burned.mp4');
    const result = await burnSubtitles({ input, srt, output });

    expect(result.args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      input,
      '-vf',
      `subtitles=${escapeFilterPath(srt)}`,
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      output,
    ]);
    expect(result.args[7]).toMatch(/subtitles=.*sub\\:title\.srt$/);
    expect(result.bytes).toBeGreaterThan(0);
    expect(await argvGroups(ffmpegLog)).toEqual([result.args]);
  });

  it('burnSubtitles returns NOT_CONFIGURED when ffmpeg is absent', async () => {
    const input = await source();
    const srt = await writeSrt([{ start: 0, end: 1, text: 'Hello' }], path.join(root, 'caps.srt'));
    disableBinaries();

    await expect(burnSubtitles({ input, srt, output: path.join(root, 'never.mp4') }))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED', message: 'FFMPEG_NOT_CONFIGURED' });
  });

  it('exportVideo chains probe -> clip with real step timings (test-double ffmpeg)', async () => {
    const input = await source();
    const output = path.join(root, 'export-plain.mp4');
    const result = await exportVideo({ input, output, start: 0, duration: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a successful export');
    expect(result.outputPath).toBe(output);
    expect(result.steps.map((step) => step.name)).toEqual(['probe', 'clip']);
    expect(result.steps.every((step) => step.ok && Number.isFinite(step.durationMs))).toBe(true);
    expect(result.metadata.durationSeconds).toBe(12.5);
    expect(Number.isFinite(result.durationMs)).toBe(true);
    expect((await stat(output)).size).toBeGreaterThan(0);
  });

  it('exportVideo chains probe -> clip -> subtitles and removes the intermediate file', async () => {
    const input = await source();
    const srt = await writeSrt([{ start: 0, end: 1, text: 'Hello' }], path.join(root, 'caps.srt'));
    const output = path.join(root, 'export-burned.mp4');
    const result = await exportVideo({ input, output, start: 0, duration: 5, subtitles: srt });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a successful export');
    expect(result.outputPath).toBe(output);
    expect(result.steps.map((step) => step.name)).toEqual(['probe', 'clip', 'subtitles']);
    expect(result.steps.every((step) => step.ok && Number.isFinite(step.durationMs))).toBe(true);

    const groups = await argvGroups(ffmpegLog);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toContain('copy');
    expect(groups[1]).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      groups[1][5],
      '-vf',
      `subtitles=${escapeFilterPath(srt)}`,
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      output,
    ]);
    const intermediate = groups[0][groups[0].length - 1];
    expect(intermediate).not.toBe(output);
    expect(await stat(intermediate).catch(() => null)).toBeNull();
    expect((await stat(output)).size).toBeGreaterThan(0);
  });

  it('exportVideo reports NOT_CONFIGURED instead of an empty result when binaries are absent', async () => {
    const input = await source();
    const output = path.join(root, 'never-export.mp4');
    disableBinaries();

    const result = await exportVideo({ input, output, start: 0, duration: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a NOT_CONFIGURED failure');
    expect(result.outputPath).toBeNull();
    expect(result.error).toMatchObject({ code: 'NOT_CONFIGURED', message: 'FFMPEG_NOT_CONFIGURED' });
    expect(result.steps.map((step) => [step.name, step.ok])).toEqual([['probe', false]]);
    expect(Number.isFinite(result.durationMs)).toBe(true);
    expect(await stat(output).catch(() => null)).toBeNull();
  });

  it('exportVideo reports NOT_CONFIGURED when ffprobe succeeds but ffmpeg is absent', async () => {
    const input = await source();
    process.env.FFMPEG_BIN = path.join(root, 'missing-ffmpeg-only');
    const output = path.join(root, 'never-clip.mp4');

    const result = await exportVideo({ input, output, start: 0, duration: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a NOT_CONFIGURED failure');
    expect(result.error.code).toBe('NOT_CONFIGURED');
    expect(result.steps.map((step) => [step.name, step.ok])).toEqual([['probe', true], ['clip', false]]);
  });
});

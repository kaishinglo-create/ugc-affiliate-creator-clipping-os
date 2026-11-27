import 'dotenv/config';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/db.js';
import { profileDimensions } from '../src/content-production.js';
import { createVtt, generateThumbnail, autoRankClips } from '../src/media-composition.js';
import { workspaceMediaRoot } from '../src/media-workspace.js';

const workspaceIds: string[] = [];

// Named test doubles: they stand in for ffmpeg/ffprobe only in this test file.
// Production always invokes the real configured binaries.
const FFMPEG_DOUBLE = `#!/bin/sh
case " $* " in
  *showinfo*)
    printf 'frame=1 pts_time:1.20 pos=0\\n' >&2
    printf 'frame=2 pts_time:4.80 pos=0\\n' >&2
    exit 0
    ;;
esac
last=''
for arg in "$@"; do last="$arg"; done
mkdir -p "$(dirname "$last")" || exit 1
printf 'thumbnail-bytes' > "$last"
exit 0
`;

const FFPROBE_DOUBLE = `#!/bin/sh
cat <<'JSON'
{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"duration":"12.5"}],"format":{"format_name":"mp4","duration":"12.5","size":"1000000"}}
JSON
`;

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.$disconnect();
});

async function workspace(): Promise<string> {
  const id = randomUUID();
  workspaceIds.push(id);
  await prisma.workspace.create({ data: { id, name: 'Composition test', slug: id } });
  const root = workspaceMediaRoot(id);
  await mkdir(root, { recursive: true });
  return id;
}

async function installDoubles(root: string) {
  const ffmpeg = path.join(root, 'ffmpeg-composition');
  const ffprobe = path.join(root, 'ffprobe-composition');
  await writeFile(ffmpeg, FFMPEG_DOUBLE, { mode: 0o755 });
  await writeFile(ffprobe, FFPROBE_DOUBLE, { mode: 0o755 });
  vi.stubEnv('FFMPEG_BIN', ffmpeg);
  vi.stubEnv('FFPROBE_BIN', ffprobe);
}

describe('Phase G media composition', () => {
  it('resolves all three production profiles and rejects unknown keys', () => {
    expect(profileDimensions('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(profileDimensions('16:9')).toEqual({ width: 1920, height: 1080 });
    expect(profileDimensions('1:1')).toEqual({ width: 1080, height: 1080 });
    expect(profileDimensions(undefined)).toBeNull();
    expect(() => profileDimensions('21:9')).toThrow('UNKNOWN_PRODUCTION_PROFILE');
  });

  it('converts a real SRT file to WebVTT with timestamp dots', async () => {
    const workspaceId = await workspace();
    const root = workspaceMediaRoot(workspaceId);
    await writeFile(path.join(root, 'captions.srt'), '1\n00:00:01,000 --> 00:00:02,500\nHello UGC\n');
    const result = await createVtt({ workspaceId, srtName: 'captions.srt' });
    expect(result.name).toBe('captions.vtt');
    expect(result.bytes).toBeGreaterThan(0);
    const vtt = await readFile(path.join(root, 'captions.vtt'), 'utf8');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:01.000 --> 00:00:02.500');
  });

  it('renders a thumbnail through ffmpeg with validated profile dimensions', async () => {
    const workspaceId = await workspace();
    const root = workspaceMediaRoot(workspaceId);
    await installDoubles(root);
    await writeFile(path.join(root, 'source.mp4'), 'fake authorized source');
    const thumbnail = await generateThumbnail({
      workspaceId, sourceName: 'source.mp4', outputName: 'thumb.png', profile: '1:1', atSeconds: 3,
    });
    expect(thumbnail).toMatchObject({ name: 'thumb.png', width: 1080, height: 1080, atSeconds: 3 });
    expect((await stat(path.join(root, 'thumb.png'))).size).toBeGreaterThan(0);
  });

  it('detects scenes from ffmpeg output and ranks clips with them', async () => {
    const workspaceId = await workspace();
    const root = workspaceMediaRoot(workspaceId);
    await installDoubles(root);
    await writeFile(path.join(root, 'source.mp4'), 'fake authorized source');
    const analysis = await autoRankClips({
      workspaceId,
      sourceName: 'source.mp4',
      highlights: [
        { startMs: 1_100, endMs: 5_000, text: 'first real highlight', score: 0.8 },
        { startMs: 6_000, endMs: 9_000, text: 'second real highlight', score: 0.4 },
      ],
      sceneThreshold: 0.3,
      targetDurationSeconds: 5,
    });
    expect(analysis.sceneTimestamps).toEqual([1.2, 4.8]);
    expect(analysis.sourceDurationSeconds).toBe(12.5);
    expect(analysis.candidates.length).toBeGreaterThan(0);
    expect(analysis.candidates[0].reason).toContain('sceneAligned=true');
  });
});

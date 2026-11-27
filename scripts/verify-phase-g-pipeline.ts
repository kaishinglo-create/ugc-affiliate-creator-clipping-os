/**
 * Real Phase G pipeline verification using authorized local media only.
 *
 * Uses the installed ffmpeg/ffprobe and whisper.cpp binaries, a self-created
 * CC0 speech sample, and the persisted quality/release modules. No fake media,
 * no test doubles, no paid service, no publishing. Artifacts and a machine
 * readable report are written to /tmp/opencode/phase-g-verify.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prisma } from '../lib/db.js';
import { profileDimensions, suggestCopy } from '../src/content-production.js';
import { autoRankClips, createVtt, generateThumbnail } from '../src/media-composition.js';
import { requestClipRelease } from '../src/media-release.js';
import { workspaceMediaPath, workspaceMediaRoot } from '../src/media-workspace.js';
import { extractAudio, exportVideo, probeMedia, runBinary } from '../src/video/clipping.js';
import { transcribeAndHighlight } from '../src/transcription.js';

const OUT_DIR = process.env.PHASE_G_VERIFY_DIR?.trim() || '/tmp/opencode/phase-g-verify';
const SAMPLE = process.env.WHISPER_SAMPLE?.trim() || '';
process.env.UGC_MEDIA_TMP_DIR ??= OUT_DIR;

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`VERIFICATION_FAILED: ${message}`);
}

async function main() {
  assert(SAMPLE, 'WHISPER_SAMPLE is not configured');
  await mkdir(OUT_DIR, { recursive: true });
  await prisma.workspace.deleteMany({ where: { name: 'Phase G verification' } }).catch(() => undefined);
  const workspaceId = `phase-g-verify-${randomUUID()}`;
  await prisma.workspace.create({ data: { id: workspaceId, name: 'Phase G verification', slug: workspaceId } });
  const root = workspaceMediaRoot(workspaceId);
  await mkdir(root, { recursive: true });
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    workspaceId,
    binaries: {
      ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
      ffprobe: process.env.FFPROBE_BIN || 'ffprobe',
      whisper: process.env.WHISPER_BIN || 'whisper',
      model: process.env.WHISPER_MODEL || null,
    },
    authorizedSource: 'self-created test video + CC0 speech sample (no third-party copyrighted content)',
    steps: [] as Array<Record<string, unknown>>,
  };
  const steps = report.steps as Array<Record<string, unknown>>;
  try {
    // 1. Create a real 6-second source with an actual hard cut at 3 seconds.
    const generated = path.join(OUT_DIR, 'generated-source.mp4');
    await runBinary('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=white:s=1280x720:r=25:d=3',
      '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=25:d=3',
      '-stream_loop', '3', '-i', SAMPLE,
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '6', '-shortest', generated,
    ], 180_000);
    await copyFile(generated, workspaceMediaPath(workspaceId, 'source.mp4'));
    const sourceMeta = await probeMedia(workspaceMediaPath(workspaceId, 'source.mp4'));
    steps.push({ step: 'source', durationSeconds: sourceMeta.durationSeconds, bytes: (await stat(generated)).size });
    assert((sourceMeta.durationSeconds ?? 0) >= 5, 'source duration');

    // 2. Real local whisper.cpp transcription with real SRT timestamps.
    const audioPath = workspaceMediaPath(workspaceId, 'speech.wav');
    await extractAudio({ input: workspaceMediaPath(workspaceId, 'source.mp4'), output: audioPath, threads: 1 });
    const transcription = await transcribeAndHighlight({
      audioPath,
      outputDir: root,
      language: 'en',
      threads: 1,
      keywords: ['workflow', 'creator'],
    });
    assert(transcription.text.trim().length > 0, 'whisper produced no transcript');
    assert(transcription.timedTranscriptPath, 'whisper produced no timed SRT');
    await copyFile(transcription.timedTranscriptPath!, workspaceMediaPath(workspaceId, 'captions.srt'));
    const transcriptText = await readFile(transcription.transcriptPath, 'utf8');
    steps.push({
      step: 'transcription',
      textLength: transcription.text.length,
      segments: transcription.segments.length,
      highlights: transcription.highlights.length,
      srtBytes: (await stat(workspaceMediaPath(workspaceId, 'captions.srt'))).size,
      transcriptPreview: transcriptText.trim().slice(0, 160),
    });

    // 3. Real scene detection + deterministic ranking on real transcript times.
    // Real whisper SRT segments carry the only trustworthy timestamps. The
    // keyword-based highlight detector may return zero hits for neutral test
    // speech, so timed segments are used as candidates instead of inventing one.
    const segmentHighlights = transcription.segments
      .filter((segment) => segment.startMs !== null && segment.endMs !== null && segment.endMs > segment.startMs)
      .map((segment) => ({
        startMs: segment.startMs as number,
        endMs: segment.endMs as number,
        text: segment.text.slice(0, 240),
        score: 0.5,
      }));
    const detectedHighlights = transcription.highlights
      .filter((highlight) => highlight.startMs !== null && highlight.endMs !== null)
      .map((highlight) => ({
        startMs: highlight.startMs as number,
        endMs: highlight.endMs as number,
        text: highlight.text,
        score: highlight.score,
      }));
    const analysis = await autoRankClips({
      workspaceId,
      sourceName: 'source.mp4',
      highlights: [...detectedHighlights, ...segmentHighlights],
      sceneThreshold: 0.05,
      targetDurationSeconds: 12,
    });
    steps.push({
      step: 'analysis',
      sceneTimestamps: analysis.sceneTimestamps,
      rankedClips: analysis.candidates.length,
      topReason: analysis.candidates[0]?.reason ?? null,
    });
    assert(analysis.sceneTimestamps.some((t) => Math.abs(t - 3) < 0.5), 'real scene cut at 3s was not detected');
    const best = analysis.candidates[0];
    assert(best, 'no ranked clip');

    // 4. Produce all three aspect ratios with real ffmpeg and burned-in SRT.
    const videos: Array<Record<string, unknown>> = [];
    for (const key of ['9:16', '16:9', '1:1'] as const) {
      const dims = profileDimensions(key)!;
      const clipName = `phase-g-${key.replace(':', 'x')}.mp4`;
      const exported = await exportVideo({
        input: workspaceMediaPath(workspaceId, 'source.mp4'),
        output: workspaceMediaPath(workspaceId, clipName),
        start: best.start,
        // Bound the render to a short, real clip window so verification stays
        // feasible on a 2-CPU sandbox; the window itself comes from the SRT.
        duration: Math.min(best.duration, sourceMeta.durationSeconds ?? best.duration, 3),
        vertical: true,
        width: dims.width,
        height: dims.height,
        subtitles: workspaceMediaPath(workspaceId, 'captions.srt'),
        allowedTempDir: root,
        threads: 1,
      });
      assert(exported.ok, `${key} export failed: ${exported.ok ? '' : exported.error.code}`);
      const metadata = await probeMedia(workspaceMediaPath(workspaceId, clipName));
      const videoStream = metadata.streams.find((stream) => stream.codecType === 'video');
      assert(videoStream?.width === dims.width && videoStream.height === dims.height, `${key} dimensions`);
      const bytes = (await stat(workspaceMediaPath(workspaceId, clipName))).size;
      const thumbnail = await generateThumbnail({
        workspaceId,
        sourceName: clipName,
        outputName: `thumb-${key.replace(':', 'x')}.png`,
        profile: key,
        atSeconds: 1,
      });
      const release = await requestClipRelease({
        workspaceId,
        clipName,
        rightsStatus: 'AUTHORIZED',
        minWidth: dims.width,
        minHeight: dims.height,
      });
      assert(release.passed && release.approval, `${key} quality/release gate`);
      videos.push({
        profile: key,
        clipName,
        bytes,
        width: videoStream.width,
        height: videoStream.height,
        codec: videoStream.codecName,
        subtitleSteps: exported.steps.map((step) => ({ name: step.name, ok: step.ok })),
        thumbnail,
        qualityReportId: release.reportId,
        qualityPassed: release.passed,
        approvalId: release.approval.id,
        approvalStatus: release.approval.status,
        previewUrl: `/api/media/files/${clipName}`,
      });
    }
    report.videos = videos;

    // 5. Derived metadata: WebVTT and honest rule-based copy.
    const vtt = await createVtt({ workspaceId, srtName: 'captions.srt' });
    const copy = suggestCopy({ topic: 'creator workflow', title: transcription.text.slice(0, 80) });
    report.subtitles = { vttName: vtt.name, vttBytes: vtt.bytes, source: 'real whisper SRT' };
    report.metadata = copy;

    report.outcome = 'passed';
    report.finishedAt = new Date().toISOString();
  } catch (error) {
    report.outcome = 'failed';
    report.error = String((error as Error)?.message ?? error);
    report.finishedAt = new Date().toISOString();
    throw error;
  } finally {
    await writeFile(path.join(OUT_DIR, 'verification.json'), JSON.stringify(report, null, 2), 'utf8');
    await prisma.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  console.log(JSON.stringify({
    outcome: report.outcome,
    videos: (report.videos as any[]).map((v) => ({ profile: v.profile, bytes: v.bytes, dimensions: `${v.width}x${v.height}` })),
    report: path.join(OUT_DIR, 'verification.json'),
  }, null, 2));
}

main().catch((error) => {
  console.error(`PHASE_G_VERIFY_FAILED: ${String(error?.message ?? error)}`);
  process.exit(1);
});

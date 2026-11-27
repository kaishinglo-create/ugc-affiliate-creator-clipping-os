/**
 * Agent-driven Phase G pipeline.
 *
 * A queued PHASE_G_PIPELINE job is executed by the autonomous engine. Every
 * artifact and report is derived from real media facts (probe, ffmpeg scene
 * detection, real transcript timestamps and file statistics). Nothing is
 * published; a passing clip only produces a pending manual approval.
 */
import { z } from 'zod';
import { writeAuditEvent } from '../lib/audit.js';
import { withWorkspaceTransaction } from '../lib/db.js';
import { isKillSwitchActive } from '../lib/security.js';
import { autoRankClips, generateThumbnail } from './media-composition.js';
import { requestClipRelease } from './media-release.js';
import { workspaceMediaPath, workspaceMediaRoot } from './media-workspace.js';
import { profileDimensions, suggestCopy } from './content-production.js';
import { completeJob, createJob, failJob, getJob, heartbeatJob } from './jobs.js';
import { exportVideo, probeMedia } from './video/clipping.js';

export const pipelinePayload = z.object({
  sourceName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  outputPrefix: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  profile: z.enum(['9:16', '16:9', '1:1']).default('9:16'),
  rightsStatus: z.enum(['AUTHORIZED']),
  highlights: z.array(z.object({
    startMs: z.number().finite().nonnegative(),
    endMs: z.number().finite().positive(),
    text: z.string().max(240).default(''),
    score: z.number().finite().default(0),
  })).max(12).default([]),
  targetDurationSeconds: z.number().min(1).max(60).optional(),
  sceneThreshold: z.number().min(0.05).max(1).optional(),
  topic: z.string().max(200).optional(),
});

export type PipelinePayload = z.infer<typeof pipelinePayload>;

export async function enqueuePhaseGPipeline(
  workspaceId: string,
  payload: unknown,
  idempotencyKey?: string | null,
): Promise<any> {
  const parsed = pipelinePayload.safeParse(payload);
  if (!parsed.success) throw Object.assign(new Error('INVALID_INPUT'), { statusCode: 400 });
  workspaceMediaPath(workspaceId, parsed.data.sourceName);
  return createJob({
    workspaceId,
    type: 'PHASE_G_PIPELINE',
    category: 'MEDIA',
    payload: { stage: 'queued', progress: 0, input: parsed.data },
    idempotencyKey: idempotencyKey ?? null,
    maxAttempts: 2,
  });
}

export interface PipelineArtifacts {
  profile: string;
  clipName: string;
  thumbnailName: string;
  analysis: Awaited<ReturnType<typeof autoRankClips>>;
  copy: ReturnType<typeof suggestCopy>;
  quality: Awaited<ReturnType<typeof requestClipRelease>>;
  sourceDurationSeconds: number | null;
}

/** Execute the full production chain against real authorized media. */
export async function runPhaseGPipeline(
  workspaceId: string,
  payload: PipelinePayload,
  signal?: AbortSignal,
): Promise<PipelineArtifacts> {
  if (signal?.aborted) throw Object.assign(new Error('CANCELLED'), { statusCode: 409 });
  const input = workspaceMediaPath(workspaceId, payload.sourceName);
  const root = workspaceMediaRoot(workspaceId);
  const metadata = await probeMedia(input);
  if (signal?.aborted) throw Object.assign(new Error('CANCELLED'), { statusCode: 409 });

  const analysis = await autoRankClips({
    workspaceId,
    sourceName: payload.sourceName,
    highlights: payload.highlights,
    sceneThreshold: payload.sceneThreshold,
    targetDurationSeconds: payload.targetDurationSeconds,
  });
  const best = analysis.candidates[0];
  if (!best) throw Object.assign(new Error('NO_RANKED_CLIP'), { statusCode: 422 });
  const dimensions = profileDimensions(payload.profile)!;
  const clipName = `${payload.outputPrefix}-${payload.profile.replace(':', 'x')}.mp4`;
  const exported = await exportVideo({
    input,
    output: workspaceMediaPath(workspaceId, clipName),
    start: best.start,
    duration: Math.min(best.duration, metadata.durationSeconds ?? best.duration),
    vertical: true,
    width: dimensions.width,
    height: dimensions.height,
    allowedTempDir: root,
    threads: 1,
    signal,
  });
  if (!exported.ok) throw Object.assign(new Error(exported.error.code), { statusCode: 502 });

  const thumbnailName = `${payload.outputPrefix}-thumb-${payload.profile.replace(':', 'x')}.png`;
  await generateThumbnail({
    workspaceId,
    sourceName: clipName,
    outputName: thumbnailName,
    profile: payload.profile,
    atSeconds: 1,
  });
  const copy = suggestCopy({ title: best.text || payload.topic, topic: payload.topic });
  const quality = await requestClipRelease({
    workspaceId,
    clipName,
    rightsStatus: payload.rightsStatus,
    minWidth: dimensions.width,
    minHeight: dimensions.height,
  });
  return {
    profile: payload.profile,
    clipName,
    thumbnailName,
    analysis,
    copy,
    quality,
    sourceDurationSeconds: metadata.durationSeconds ?? null,
  };
}

/** Engine driver: fence the lease, execute, persist a redacted result. */
export async function executePhaseGPipelineJob(
  workspaceId: string,
  job: { id: string; leaseId: string; payload: unknown },
  workerId: string,
  leaseTtlMs: number,
): Promise<{ outcome: 'succeeded' | 'failed' | 'retry' | 'skipped'; error?: string }> {
  const lease = { workspaceId, leaseId: job.leaseId, workerId };
  const parsed = pipelinePayload.safeParse((job.payload as any)?.input ?? job.payload);
  if (!parsed.success) {
    const updated = await failJob(job.id, { error: 'PHASE_G_INVALID_PAYLOAD', retryable: false }, lease);
    return { outcome: updated?.status === 'RETRY_WAIT' ? 'retry' : 'failed', error: 'PHASE_G_INVALID_PAYLOAD' };
  }
  const fence = async (tx: any) => {
    const rows: { id: string }[] = await tx.$queryRaw`
      SELECT id FROM "Job" WHERE id = ${job.id} AND "workspaceId" = ${workspaceId}
        AND "leaseId" = ${job.leaseId} AND "leaseOwner" = ${workerId}
        AND status = 'RUNNING' AND "leaseExpiresAt" > ${new Date()} FOR UPDATE
    `;
    return rows.length === 1;
  };
  const blocked = await withWorkspaceTransaction(workspaceId, async (tx: any) => {
    if (!(await fence(tx))) return 'lost';
    if (await isKillSwitchActive(workspaceId, tx)) return 'blocked';
    return 'ok';
  });
  if (blocked !== 'ok') return { outcome: 'skipped' as const };

  const controller = new AbortController();
  const timer = setInterval(() => {
    void heartbeatJob(job.id, job.leaseId, workerId, { workspaceId, extendMs: leaseTtlMs }).catch(() => undefined);
  }, Math.max(1000, Math.floor(leaseTtlMs / 3)));
  timer.unref();
  try {
    const artifacts = await runPhaseGPipeline(workspaceId, parsed.data, controller.signal);
    const settled = await withWorkspaceTransaction(workspaceId, async (tx: any) => {
      if (!(await fence(tx))) return { outcome: 'skipped' as const };
      const fresh: any = await getJob(job.id, workspaceId);
      const result = {
        profile: artifacts.profile,
        clipName: artifacts.clipName,
        thumbnailName: artifacts.thumbnailName,
        sceneTimestamps: artifacts.analysis.sceneTimestamps,
        rankedClips: artifacts.analysis.candidates.length,
        qualityPassed: artifacts.quality.passed,
        reportId: artifacts.quality.reportId ?? null,
        approvalId: artifacts.quality.approval?.id ?? null,
        sourceDurationSeconds: artifacts.sourceDurationSeconds,
      };
      await tx.job.update({
        where: { id: job.id, workspaceId },
        data: { payload: { ...((fresh?.payload ?? {}) as Record<string, unknown>), stage: 'complete', progress: 100, result } },
      });
      await completeJob(job.id, lease, tx);
      await writeAuditEvent({
        workspaceId,
        type: 'phase_g_pipeline_completed',
        actor: workerId,
        data: { jobId: job.id, ...result },
        tx,
      });
      return { outcome: 'succeeded' as const };
    });
    return settled;
  } catch (error) {
    const message = String((error as Error)?.message ?? 'PHASE_G_PIPELINE_FAILED').slice(0, 120);
    const updated = await failJob(job.id, { error: message, retryable: false }, lease).catch(() => null);
    await withWorkspaceTransaction(workspaceId, (tx: any) => writeAuditEvent({
      workspaceId,
      type: 'phase_g_pipeline_failed',
      actor: workerId,
      data: { jobId: job.id, error: message },
      tx,
    })).catch(() => undefined);
    return { outcome: updated?.status === 'RETRY_WAIT' ? 'retry' : 'failed', error: message };
  } finally {
    clearInterval(timer);
  }
}

/**
 * Phase G persistent media quality reports derived from real probed facts.
 */
import { stat } from 'node:fs/promises';
import { withWorkspaceTransaction } from '../lib/db.js';
import { probeMedia } from './video/clipping.js';

export interface QualityCheck {
  key: string;
  passed: boolean;
  detail: string;
}

export interface QualityEvaluation {
  passed: boolean;
  checks: QualityCheck[];
  reportId?: string;
}

export async function evaluateClip(input: {
  workspaceId: string;
  clipPath: string;
  rightsStatus?: string;
  minWidth?: number;
  minHeight?: number;
  minDurationSeconds?: number;
  jobId?: string;
}): Promise<QualityEvaluation> {
  const checks: QualityCheck[] = [];
  let metadata: any = null;
  let bytes = 0;
  try {
    metadata = await probeMedia(input.clipPath);
    const info = await stat(input.clipPath);
    bytes = info.size;
  } catch {
    checks.push({ key: 'file_integrity', passed: false, detail: 'Clip file could not be probed or read.' });
    const failed: any = await withWorkspaceTransaction(input.workspaceId, (tx: any) => tx.qualityReport.create({
      data: { workspaceId: input.workspaceId, jobId: input.jobId ?? null, clipPath: input.clipPath, passed: false, checksJson: checks },
    }));
    return { passed: false, checks, reportId: failed.id };
  }
  checks.push({ key: 'file_integrity', passed: bytes > 0, detail: `File size ${bytes} bytes.` });

  const video = (metadata.streams ?? []).find((stream: any) => stream.codecType === 'video');
  const audio = (metadata.streams ?? []).find((stream: any) => stream.codecType === 'audio');
  const minWidth = Math.max(1, Number(input.minWidth) || 720);
  const minHeight = Math.max(1, Number(input.minHeight) || 720);
  checks.push({
    key: 'resolution',
    passed: Boolean(video && Number(video.width) >= minWidth && Number(video.height) >= minHeight),
    detail: video ? `${video.width}x${video.height} (minimum ${minWidth}x${minHeight})` : 'No video stream.',
  });
  checks.push({ key: 'codec', passed: Boolean(video?.codecName), detail: video?.codecName ?? 'No video codec.' });
  checks.push({ key: 'audio', passed: Boolean(audio?.codecName), detail: audio?.codecName ?? 'No audio stream.' });
  const duration = Number(metadata.durationSeconds ?? 0);
  const minDuration = Math.max(0.1, Number(input.minDurationSeconds) || 1);
  checks.push({ key: 'duration', passed: duration >= minDuration, detail: `Duration ${duration}s (minimum ${minDuration}s).` });
  checks.push({
    key: 'rights',
    passed: input.rightsStatus === 'AUTHORIZED',
    detail: `Rights status: ${input.rightsStatus ?? 'UNKNOWN'}.`,
  });

  const passed = checks.every((check) => check.passed);
  const report: any = await withWorkspaceTransaction(input.workspaceId, (tx: any) => tx.qualityReport.create({
    data: {
      workspaceId: input.workspaceId,
      jobId: input.jobId ?? null,
      clipPath: input.clipPath,
      passed,
      checksJson: checks,
    },
  }));
  return { passed, checks, reportId: report.id };
}

export async function listQualityReports(workspaceId: string, take = 100): Promise<any[]> {
  return withWorkspaceTransaction<any[]>(workspaceId, (tx: any) => tx.qualityReport.findMany({
    where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: Math.min(500, Math.max(1, take)),
    select: { id: true, jobId: true, clipPath: true, passed: true, createdAt: true, checksJson: true },
  }));
}

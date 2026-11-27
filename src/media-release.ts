/**
 * Phase G manual release gate: a clip may only be released for export after a
 * passing persisted quality report and an explicit workspace approval.
 */
import { withWorkspaceTransaction } from '../lib/db.js';
import { workspaceMediaPath } from './media-workspace.js';
import { evaluateClip, type QualityEvaluation } from './quality-gate.js';

export const CLIP_RELEASE_ENTITY = 'media_clip';

function releaseError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

export interface ClipReleaseRequest extends QualityEvaluation {
  approval: { id: string; status: string; entityType: string; entityId: string } | null;
}

/** Evaluate a clip and, only when it passes, create a pending manual approval. */
export async function requestClipRelease(input: {
  workspaceId: string;
  clipName: string;
  jobId?: string;
  rightsStatus?: string;
  requestedBy?: string;
  minWidth?: number;
  minHeight?: number;
}): Promise<ClipReleaseRequest> {
  const clipName = String(input.clipName ?? '');
  const clipPath = workspaceMediaPath(input.workspaceId, clipName);
  const evaluation = await evaluateClip({
    workspaceId: input.workspaceId,
    clipPath,
    rightsStatus: input.rightsStatus,
    jobId: input.jobId,
    minWidth: input.minWidth,
    minHeight: input.minHeight,
  });
  if (!evaluation.passed || !evaluation.reportId) {
    return { ...evaluation, approval: null };
  }
  const created: any = await withWorkspaceTransaction(input.workspaceId, (tx: any) => tx.approval.create({
    data: {
      workspaceId: input.workspaceId,
      entityType: CLIP_RELEASE_ENTITY,
      entityId: clipName,
      requestedBy: input.requestedBy ? String(input.requestedBy).slice(0, 200) : null,
      status: 'pending',
    },
    select: { id: true, status: true, entityType: true, entityId: true },
  }));
  return { ...evaluation, approval: created };
}

/** Verify that a decided approval actually releases the requested output. */
export async function assertClipReleased(input: {
  workspaceId: string;
  approvalId: string;
  outputName: string;
}): Promise<{ id: string; status: string; entityId: string }> {
  const approval: any = await withWorkspaceTransaction(input.workspaceId, (tx: any) => tx.approval.findFirst({
    where: {
      id: String(input.approvalId ?? ''),
      workspaceId: input.workspaceId,
      entityType: CLIP_RELEASE_ENTITY,
    },
    select: { id: true, status: true, entityId: true },
  }));
  if (!approval) throw releaseError('APPROVAL_NOT_FOUND', 404);
  if (approval.entityId !== String(input.outputName ?? '')) throw releaseError('APPROVAL_OUTPUT_MISMATCH', 400);
  if (approval.status !== 'approved') throw releaseError('CLIP_NOT_APPROVED', 403);
  return approval;
}

export async function listClipReleases(workspaceId: string, take = 100): Promise<any[]> {
  return withWorkspaceTransaction<any[]>(workspaceId, (tx: any) => tx.approval.findMany({
    where: { workspaceId, entityType: CLIP_RELEASE_ENTITY },
    orderBy: { createdAt: 'desc' },
    take: Math.min(500, Math.max(1, Math.trunc(Number(take)) || 100)),
    select: { id: true, entityId: true, status: true, requestedBy: true, decidedBy: true, decidedAt: true, createdAt: true },
  }));
}

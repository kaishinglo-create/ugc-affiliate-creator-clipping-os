/**
 * Persistent, workspace-scoped research score reports for Phase G.
 *
 * This module only persists the facts produced by scoreContentCandidate. It
 * never derives, estimates or invents an engagement or revenue figure.
 */
import { withWorkspaceTransaction } from '../lib/db.js';
import type { ScoreReport } from './research-scoring.js';

const REPORT_SELECT = {
  id: true,
  workspaceId: true,
  candidateId: true,
  title: true,
  overall: true,
  origin: true,
  createdAt: true,
} as const;

function invalid(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export async function persistResearchReport(input: {
  workspaceId: string;
  title: string;
  report: ScoreReport;
  candidateId?: string | null;
  origin?: string;
  /** Workspace role of the caller. Persisting is an OWNER/ADMIN mutation. */
  role?: string;
}): Promise<any> {
  if (input.role !== 'OWNER' && input.role !== 'ADMIN') {
    throw Object.assign(new Error('INSUFFICIENT_ROLE'), { statusCode: 403 });
  }
  const workspaceId = String(input.workspaceId ?? '').trim();
  if (!workspaceId) throw invalid('INVALID_WORKSPACE');
  const title = String(input.title ?? '').trim().slice(0, 500);
  if (!title) throw invalid('INVALID_INPUT');
  const report = input.report;
  if (!report || !Array.isArray(report.dimensions) || report.dimensions.length === 0) {
    throw invalid('INVALID_SCORE_REPORT');
  }
  if (report.dimensions.some((dimension) =>
    !dimension || typeof dimension.key !== 'string'
    || (dimension.value !== null && !Number.isFinite(dimension.value))
    || !['provided', 'estimated', 'missing'].includes(dimension.source))) {
    throw invalid('INVALID_SCORE_REPORT');
  }
  const origin = String(input.origin ?? 'heuristic').trim().slice(0, 80) || 'heuristic';
  const candidateId = input.candidateId ? String(input.candidateId).trim().slice(0, 200) || null : null;
  return withWorkspaceTransaction<any>(workspaceId, (tx: any) => tx.researchReport.create({
    data: {
      workspaceId,
      candidateId,
      title,
      overall: Number.isFinite(report.overall as number) ? (report.overall as number) : null,
      // The full explainable report is stored verbatim; no value is rewritten.
      scoreJson: report as any,
      origin,
    },
    select: REPORT_SELECT,
  }));
}

export async function listResearchReports(workspaceId: string, take = 100): Promise<any[]> {
  return withWorkspaceTransaction<any[]>(workspaceId, (tx: any) => tx.researchReport.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(500, Math.max(1, Math.trunc(Number(take)) || 100)),
    select: REPORT_SELECT,
  }));
}

/** Full stored report including its explainable dimensions. */
export async function getResearchReport(workspaceId: string, id: string): Promise<any | null> {
  return withWorkspaceTransaction<any>(workspaceId, (tx: any) => tx.researchReport.findFirst({
    where: { id: String(id ?? ''), workspaceId },
  }));
}

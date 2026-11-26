/**
 * Self-improving rules learner.
 *
 * This module turns *stored* audit events into advisory improvement
 * suggestions. It is deterministic: the same rows, `now`, and options always
 * produce the same suggestions. It performs no model calls, no network calls,
 * and never writes to the database.
 *
 * There is intentionally no `applySuggestion` export. `OperationalPolicy` is a
 * generic JSON store in this schema, but no policy key has defined runtime
 * enforcement semantics. Writing one automatically would invent a guard that
 * nothing enforces and would make an advisory suggestion look applied. Each
 * suggestion therefore stays `status: 'suggested'` and a human must change the
 * real guard in code/configuration.
 */
import { withWorkspaceTransaction } from '../lib/db.js';

export const SELF_IMPROVEMENT_SOURCE = 'audit_events' as const;
export const DEFAULT_SELF_IMPROVEMENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_MIN_OCCURRENCES = 3;
export const DEFAULT_EVENT_LIMIT = 500;

/** Minimal shape of an AuditEvent row needed by the learner. */
export interface SelfImprovementEvent {
  workspaceId?: string | null;
  type: string;
  createdAt: Date | string | number;
  data?: unknown;
}

export interface SuggestionEvidence {
  rule: string;
  count: number;
  threshold: number;
  window: { from: string; to: string; durationMs: number };
  matchedTypes: { type: string; count: number }[];
}

export interface ImprovementSuggestion {
  id: string;
  workspaceId: string;
  reason: string;
  evidence: SuggestionEvidence;
  suggestedAction: string;
  confidence: number;
  source: 'audit_events';
  status: 'suggested';
}

export interface DeriveSuggestionsOptions {
  /** Restricts mixed inputs to one workspace; collectSelfImprovement always sets it. */
  workspaceId?: string;
  windowMs?: number;
  minOccurrences?: number;
}

export interface CollectSelfImprovementOptions extends DeriveSuggestionsOptions {
  /** Deterministic clock for tests/replays; defaults to the current time. */
  now?: Timestamp;
  /** Upper bound on rows read, so a busy workspace cannot make collection unbounded. */
  limit?: number;
}

export interface SelfImprovementReport {
  workspaceId: string;
  generatedAt: string;
  window: { from: string; to: string; durationMs: number };
  eventsExamined: number;
  truncated: boolean;
  suggestions: ImprovementSuggestion[];
}

type Timestamp = Date | string | number;

interface Rule {
  key: string;
  matches: (event: SelfImprovementEvent) => boolean;
  reason: (count: number, durationMs: number) => string;
  action: string;
}

const ENGINE_ERROR_TYPES = [
  'engine_tick_error',
  'engine_tick_failed',
  'engine_job_failed',
  'engine_job_error',
  'orchestration_engine_error',
  'orchestration_task_failed',
  'workflow_run_failed',
];

const APPROVAL_TYPES = ['approval_rejected', 'orchestration_approval_decided', 'workflow_step_blocked'];

/**
 * Types read from the database. Quota signals are carried by `ollama_request`
 * rows (data.outcome/status/errorCode), so that type is included as well.
 */
const RELEVANT_AUDIT_TYPES: string[] = [
  ...ENGINE_ERROR_TYPES,
  ...APPROVAL_TYPES,
  'ollama_request',
];

function dataObject(event: SelfImprovementEvent): Record<string, unknown> {
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return data as Record<string, unknown>;
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function isEngineError(event: SelfImprovementEvent): boolean {
  if (ENGINE_ERROR_TYPES.includes(event.type)) return true;
  // Forward-compatible with engine tick failures recorded under a variant name.
  return /^engine_tick_.*(error|failed)$/.test(event.type);
}

function isQuotaError(event: SelfImprovementEvent): boolean {
  if (/quota|budget_exceeded|out_of_credit/i.test(event.type)) return true;
  if (event.type !== 'ollama_request') return false;
  const data = dataObject(event);
  const outcome = lower(data.outcome);
  const status = lower(data.status);
  const errorCode = lower(data.errorCode);
  return (
    outcome === 'budget_exceeded' ||
    outcome.includes('quota') ||
    status === 'budget_exceeded' ||
    status === '429' ||
    status === '402' ||
    errorCode.includes('quota') ||
    errorCode.includes('credit') ||
    errorCode.includes('budget') ||
    errorCode.includes('http_402')
  );
}

function isApprovalRejection(event: SelfImprovementEvent): boolean {
  if (event.type === 'approval_rejected') return true;
  const data = dataObject(event);
  if (event.type === 'orchestration_approval_decided') return data.approved === false;
  if (event.type === 'workflow_step_blocked') return lower(data.reason).includes('approval_rejected');
  return false;
}

function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

const RULES: Rule[] = [
  {
    key: 'repeated_engine_orchestration_errors',
    matches: isEngineError,
    reason: (count, durationMs) =>
      `${count} engine/orchestration error events in the last ${formatDuration(durationMs)} indicate recurring execution failures.`,
    action:
      'Check the workspace kill switch and the engine lease-recovery guard before scheduling more ticks; keep the affected runs paused until the cause is understood.',
  },
  {
    key: 'repeated_quota_errors',
    matches: isQuotaError,
    reason: (count, durationMs) =>
      `${count} budget/quota audit events in the last ${formatDuration(durationMs)} indicate requests are being refused for lack of free quota.`,
    action:
      'Wait for free quota to reset (or reduce request volume) and review OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE with the workspace owner. Do not enable a paid fallback.',
  },
  {
    key: 'repeated_approval_rejections',
    matches: isApprovalRejection,
    reason: (count, durationMs) =>
      `${count} approval rejection events in the last ${formatDuration(durationMs)} indicate requested work is not meeting the reviewer's criteria.`,
    action:
      'Sharpen the approval criteria before requesting another decision: state the exact scope, budget, and expected output in the request.',
  },
];

function parseTimestamp(value: Timestamp | null | undefined): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  return null;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function roundConfidence(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Pure derivation. `events` should already be workspace-scoped (or carry
 * workspaceIds); when `options.workspaceId` is set, foreign rows are ignored.
 * No database access, mutation, logging, or model call happens here.
 */
export function deriveSuggestions(
  events: readonly SelfImprovementEvent[],
  now: Timestamp,
  options: DeriveSuggestionsOptions = {},
): ImprovementSuggestion[] {
  const nowMs = parseTimestamp(now);
  if (nowMs === null) return [];

  const windowMs = clamp(options.windowMs, DEFAULT_SELF_IMPROVEMENT_WINDOW_MS, 60_000, 30 * 86_400_000);
  const threshold = clamp(options.minOccurrences, DEFAULT_MIN_OCCURRENCES, 2, 20);
  const fromMs = nowMs - windowMs;
  const to = new Date(nowMs);
  const from = new Date(fromMs);
  const requestedWorkspaceId = options.workspaceId?.trim() || '';
  const workspaceId = requestedWorkspaceId || (
    events.find((event) => typeof event.workspaceId === 'string' && event.workspaceId.trim())?.workspaceId?.trim() ?? ''
  );

  const inWindow = events.filter((event) => {
    if (requestedWorkspaceId && event.workspaceId && String(event.workspaceId) !== requestedWorkspaceId) return false;
    const at = parseTimestamp(event.createdAt);
    return at !== null && at >= fromMs && at <= nowMs;
  });

  const suggestions: ImprovementSuggestion[] = [];
  for (const rule of RULES) {
    const matched = inWindow.filter((event) => rule.matches(event));
    if (matched.length < threshold) continue;

    const perType = new Map<string, number>();
    for (const event of matched) perType.set(event.type, (perType.get(event.type) ?? 0) + 1);
    const matchedTypes = [...perType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

    const count = matched.length;
    const confidence = roundConfidence(
      Math.min(0.95, count / (count + 3) + (count >= threshold * 2 ? 0.05 : 0)),
    );

    suggestions.push({
      id: `si:${workspaceId}:${rule.key}:${from.toISOString()}`,
      workspaceId,
      reason: rule.reason(count, windowMs),
      evidence: {
        rule: rule.key,
        count,
        threshold,
        window: { from: from.toISOString(), to: to.toISOString(), durationMs: windowMs },
        matchedTypes,
      },
      suggestedAction: rule.action,
      confidence,
      source: SELF_IMPROVEMENT_SOURCE,
      status: 'suggested',
    });
  }
  return suggestions;
}

/**
 * Read real AuditEvent rows inside the mandatory workspace transaction and
 * derive suggestions. Returns a report only; nothing is applied.
 */
export async function collectSelfImprovement(
  workspaceId: string,
  opts: CollectSelfImprovementOptions = {},
): Promise<SelfImprovementReport> {
  const now = opts.now ?? new Date();
  const nowMs = parseTimestamp(now);
  if (nowMs === null) throw new Error('INVALID_SELF_IMPROVEMENT_NOW');

  const windowMs = clamp(opts.windowMs, DEFAULT_SELF_IMPROVEMENT_WINDOW_MS, 60_000, 30 * 86_400_000);
  const limit = clamp(opts.limit, DEFAULT_EVENT_LIMIT, 1, 5_000);
  const from = new Date(nowMs - windowMs);
  const to = new Date(nowMs);

  const rows: SelfImprovementEvent[] = await withWorkspaceTransaction(workspaceId, (tx) =>
    tx.auditEvent.findMany({
      where: {
        workspaceId,
        createdAt: { gte: from, lte: to },
        type: { in: RELEVANT_AUDIT_TYPES },
      },
      select: { workspaceId: true, type: true, data: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    }),
  );

  return {
    workspaceId,
    generatedAt: to.toISOString(),
    window: { from: from.toISOString(), to: to.toISOString(), durationMs: windowMs },
    eventsExamined: rows.length,
    truncated: rows.length === limit,
    suggestions: deriveSuggestions(rows, to, {
      workspaceId,
      windowMs,
      minOccurrences: opts.minOccurrences,
    }),
  };
}

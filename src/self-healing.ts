/**
 * Self-healing / self-improving workflows.
 *
 * This module is deliberately isolated: it reads only the rows and state
 * snapshots handed to it, and it writes only through an injected state store.
 * It never imports the database client, calls a provider, uploads media,
 * changes code/policy, or bypasses an approval gate.
 *
 * Two entry points form the contract:
 *   - `proposeHealing` derives advisory/actionable proposals from real
 *     AuditEvent rows and always marks them `applied: false`.
 *   - `applyHealing` mutates state only when the caller supplies an explicit
 *     approval, a non-dry-run context, an allow-listed action, verifiable
 *     preconditions, and a successful external quality-gate verification.
 *
 * Every mutation snapshots the state before writing it. Any failure after a
 * write rolls all executed mutations back in reverse order.
 */

export const HEALING_SOURCE = 'audit_events' as const;
export const DEFAULT_HEALING_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_HEALING_MIN_OCCURRENCES = 1;
export const DEFAULT_HEALING_EVENT_LIMIT = 500;
export const DEFAULT_STALE_LEASE_MS = 60_000;
export const MAX_HEALING_EVENT_LIMIT = 5_000;

export type Timestamp = Date | string | number;

export type KnownErrorCode =
  | 'NOT_CONFIGURED'
  | 'MEDIA_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'AI_BUDGET_EXCEEDED'
  | 'RATE_LIMIT'
  | 'QUOTA'
  | 'TRANSIENT'
  | 'NETWORK'
  | 'APPROVAL_REQUIRED'
  | 'FFMPEG_FAILED'
  | 'TRANSCRIBE_FAILED';

export type ClassificationCode = KnownErrorCode | 'UNKNOWN';

/** Severity is descriptive; it never authorises a mutation by itself. */
export type HealingSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * `external_limit` is intentionally distinct from `input`/`unknown`: quota and
 * rate limits are external constraints, not code defects and never a reason to
 * circumvent the limit or switch providers.
 */
export type HealingCategory =
  | 'external_limit'
  | 'configuration'
  | 'media'
  | 'input'
  | 'transient'
  | 'approval'
  | 'tool_failure'
  | 'unknown';

export interface ErrorClassification {
  readonly code: ClassificationCode;
  readonly category: HealingCategory;
  readonly retryable: boolean;
  readonly requiresExternalSetup: boolean;
  readonly manualApproval: boolean;
  readonly severity: HealingSeverity;
  readonly action: string;
  readonly source: 'known_code' | 'alias' | 'http_status' | 'message' | 'fallback';
}

export const KNOWN_ERROR_CODES: readonly KnownErrorCode[] = [
  'NOT_CONFIGURED',
  'MEDIA_NOT_FOUND',
  'INVALID_INPUT',
  'AI_BUDGET_EXCEEDED',
  'RATE_LIMIT',
  'QUOTA',
  'TRANSIENT',
  'NETWORK',
  'APPROVAL_REQUIRED',
  'FFMPEG_FAILED',
  'TRANSCRIBE_FAILED',
];

/** The only mutations this module is allowed to plan or execute. */
export type HealingAction = 'clear_stale_lease' | 'promote_due_retry_wait';
export const SAFE_HEALING_ACTIONS: readonly HealingAction[] = [
  'clear_stale_lease',
  'promote_due_retry_wait',
];

export type QualityGateName = 'typecheck' | 'lint' | 'tests';
export const REQUIRED_QUALITY_GATES: readonly QualityGateName[] = ['typecheck', 'lint', 'tests'];

export interface QualityGateReport {
  /** An explicit `false` always fails; omitted means "derive from gates". */
  readonly ok?: boolean;
  readonly gates: Partial<Record<QualityGateName, boolean>>;
  readonly details?: Partial<Record<QualityGateName, string>>;
}

export interface HealingTarget {
  readonly kind: 'job' | 'orchestration_run';
  readonly id: string;
  readonly workspaceId: string;
}

/** Mutable projection of a row; the store adapter owns the real persistence. */
export interface HealingState {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: 'job' | 'orchestration_run';
  readonly status: string;
  readonly leaseOwner?: string | null;
  readonly leaseToken?: string | null;
  readonly leaseExpiresAt?: Timestamp | null;
  readonly heartbeatAt?: Timestamp | null;
  readonly runAt?: Timestamp | null;
  readonly attempts?: number;
  readonly updatedAt?: Timestamp | null;
}

export interface HealingStateStore {
  read(ref: HealingTarget): Promise<HealingState | null> | HealingState | null;
  write(state: HealingState): Promise<void> | void;
}

export interface HealingAuditEvent {
  readonly id: string;
  readonly type: string;
  readonly createdAt: Timestamp;
  readonly workspaceId?: string | null;
  readonly actor?: string | null;
  readonly data?: unknown;
}

export interface HealingEvidence {
  readonly rule: string;
  readonly count: number;
  readonly threshold: number;
  readonly eventIds: readonly string[];
  readonly types: readonly { readonly type: string; readonly count: number }[];
  readonly codes: readonly { readonly code: string; readonly count: number }[];
  readonly window: { readonly from: string; readonly to: string; readonly durationMs: number };
}

export interface HealingProposal {
  readonly id: string;
  readonly workspaceId: string;
  readonly rule: string;
  readonly reason: string;
  readonly classification: ErrorClassification;
  /** `null` means advisory only and can never be applied. */
  readonly action: HealingAction | null;
  readonly target: HealingTarget | null;
  readonly evidence: HealingEvidence;
  readonly confidence: number;
  readonly source: 'audit_events';
  /** Proposals are advisory until an approved apply workflow succeeds. */
  readonly applied: false;
}

export interface ProposeHealingOptions {
  readonly workspaceId: string;
  readonly now?: Timestamp;
  readonly windowMs?: number;
  readonly minOccurrences?: number;
  readonly limit?: number;
}

export interface HealingAuditLoaderInput {
  readonly workspaceId: string;
  readonly from: Date;
  readonly to: Date;
  readonly limit: number;
}

export type HealingAuditLoader = (
  input: HealingAuditLoaderInput,
) => Promise<readonly HealingAuditEvent[]> | readonly HealingAuditEvent[];

export interface HealingProposalReport {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly window: { readonly from: string; readonly to: string; readonly durationMs: number };
  readonly eventsExamined: number;
  readonly truncated: boolean;
  readonly proposals: readonly HealingProposal[];
}

export interface HealingVerifyInput {
  readonly workspaceId: string;
  readonly actor: string;
  readonly now: string;
  readonly proposals: readonly { readonly id: string; readonly rule: string; readonly action: HealingAction | null }[];
  readonly mutations: readonly ExecutedMutation[];
}

export type HealingVerify = (
  input: HealingVerifyInput,
) => Promise<QualityGateReport> | QualityGateReport;

export interface HealingContext {
  readonly workspaceId: string;
  readonly actor: string;
  /** Must be exactly `false` for a mutation; `true` is always a no-op. */
  readonly dryRun: boolean;
  /** Explicit, per-call approval. Absence or `false` denies every mutation. */
  readonly approved: boolean;
  readonly allowedActions: readonly HealingAction[];
  readonly store: HealingStateStore;
  readonly verify: HealingVerify;
  readonly now?: Timestamp;
  readonly staleLeaseMs?: number;
  readonly approvalReference?: string;
}

export interface ExecutedMutation {
  readonly proposalId: string;
  readonly action: HealingAction;
  readonly ref: HealingTarget;
  /** Snapshot taken from the store before the write. */
  readonly before: HealingState;
  readonly after: HealingState;
  readonly appliedAt: string;
}

export interface RollbackResult {
  readonly rolledBack: boolean;
  /** Reverted in reverse application order. */
  readonly reverted: readonly ExecutedMutation[];
  readonly errors: readonly string[];
}

export type HealingOutcome =
  | 'applied'
  | 'denied'
  | 'advisory_only'
  | 'not_due'
  | 'state_missing'
  | 'mutation_failed'
  | 'verify_failed';

export interface HealingApplyResult {
  readonly outcome: HealingOutcome;
  /** `true` only after every executed mutation passed verification. */
  readonly applied: boolean;
  readonly reason: string;
  readonly message: string;
  readonly proposalId: string;
  readonly workspaceId: string;
  readonly actor: string;
  readonly dryRun: boolean;
  readonly verification: QualityGateReport | null;
  readonly mutations: readonly ExecutedMutation[];
  readonly rolledBack: boolean;
  readonly rollbackErrors: readonly string[];
  /** Explicit rollback for an already applied result; idempotent. */
  rollback(): Promise<RollbackResult>;
}

interface ClassificationDefinition {
  readonly code: KnownErrorCode;
  readonly category: HealingCategory;
  readonly retryable: boolean;
  readonly requiresExternalSetup: boolean;
  readonly manualApproval: boolean;
  readonly severity: HealingSeverity;
  readonly action: string;
}

const DEFINITIONS: Readonly<Record<KnownErrorCode, ClassificationDefinition>> = {
  NOT_CONFIGURED: {
    code: 'NOT_CONFIGURED',
    category: 'configuration',
    retryable: false,
    requiresExternalSetup: true,
    manualApproval: true,
    severity: 'error',
    action: 'Ask the owner to configure the missing dependency in approved configuration; do not retry until setup exists.',
  },
  MEDIA_NOT_FOUND: {
    code: 'MEDIA_NOT_FOUND',
    category: 'media',
    retryable: false,
    requiresExternalSetup: true,
    manualApproval: false,
    severity: 'warning',
    action: 'Restore the source media manually and re-run; no automatic upload or provider call.',
  },
  INVALID_INPUT: {
    code: 'INVALID_INPUT',
    category: 'input',
    retryable: false,
    requiresExternalSetup: false,
    manualApproval: false,
    severity: 'info',
    action: 'Correct the input and resubmit; retrying the same input cannot help.',
  },
  AI_BUDGET_EXCEEDED: {
    code: 'AI_BUDGET_EXCEEDED',
    category: 'external_limit',
    retryable: false,
    requiresExternalSetup: true,
    manualApproval: true,
    severity: 'warning',
    action: 'Wait for free quota or ask the owner to review the limit; never bypass the limit or switch providers.',
  },
  RATE_LIMIT: {
    code: 'RATE_LIMIT',
    category: 'external_limit',
    retryable: false,
    requiresExternalSetup: true,
    manualApproval: true,
    severity: 'warning',
    action: 'Wait for the external rate limit to reset; never bypass the limit or enable a paid fallback.',
  },
  QUOTA: {
    code: 'QUOTA',
    category: 'external_limit',
    retryable: false,
    requiresExternalSetup: true,
    manualApproval: true,
    severity: 'warning',
    action: 'Wait for free quota or ask the owner to review the limit; an external quota is not a code defect and must not be bypassed.',
  },
  TRANSIENT: {
    code: 'TRANSIENT',
    category: 'transient',
    retryable: true,
    requiresExternalSetup: false,
    manualApproval: false,
    severity: 'warning',
    action: 'Let the existing scheduler retry with backoff; do not add a fallback provider.',
  },
  NETWORK: {
    code: 'NETWORK',
    category: 'transient',
    retryable: true,
    requiresExternalSetup: false,
    manualApproval: false,
    severity: 'warning',
    action: 'Let the existing scheduler retry with backoff; do not add a fallback provider.',
  },
  APPROVAL_REQUIRED: {
    code: 'APPROVAL_REQUIRED',
    category: 'approval',
    retryable: false,
    requiresExternalSetup: false,
    manualApproval: true,
    severity: 'info',
    action: 'Wait for explicit human approval; never auto-approve or bypass the gate.',
  },
  FFMPEG_FAILED: {
    code: 'FFMPEG_FAILED',
    category: 'tool_failure',
    retryable: false,
    requiresExternalSetup: false,
    manualApproval: false,
    severity: 'error',
    action: 'Inspect ffmpeg stderr and the input media; fix upstream and re-run manually.',
  },
  TRANSCRIBE_FAILED: {
    code: 'TRANSCRIBE_FAILED',
    category: 'tool_failure',
    retryable: false,
    requiresExternalSetup: false,
    manualApproval: false,
    severity: 'error',
    action: 'Inspect transcription logs and the source audio; fix upstream and re-run manually.',
  },
};

const ALIASES: Readonly<Record<string, KnownErrorCode>> = {
  AI_NOT_CONFIGURED: 'NOT_CONFIGURED',
  OLLAMA_NOT_CONFIGURED: 'NOT_CONFIGURED',
  FFMPEG_NOT_CONFIGURED: 'NOT_CONFIGURED',
  WHISPER_NOT_CONFIGURED: 'NOT_CONFIGURED',
  DISCOVERY_NOT_CONFIGURED: 'NOT_CONFIGURED',
  FILE_NOT_FOUND: 'MEDIA_NOT_FOUND',
  VALIDATION_FAILED: 'INVALID_INPUT',
  AI_OUTPUT_INVALID: 'TRANSIENT',
  AI_BUDGET_DISABLED: 'QUOTA',
  BUDGET_EXCEEDED: 'QUOTA',
  QUOTA_EXCEEDED: 'QUOTA',
  QUOTA_EXHAUSTED: 'QUOTA',
  OUT_OF_CREDIT: 'QUOTA',
  HTTP_402: 'QUOTA',
  OLLAMA_402: 'QUOTA',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT',
  TOO_MANY_REQUESTS: 'RATE_LIMIT',
  HTTP_429: 'RATE_LIMIT',
  NETWORK_ERROR: 'NETWORK',
  ECONNRESET: 'NETWORK',
  ECONNREFUSED: 'NETWORK',
  FETCH_FAILED: 'NETWORK',
  AI_TIMEOUT: 'TRANSIENT',
  OLLAMA_TIMEOUT: 'TRANSIENT',
  ETIMEDOUT: 'TRANSIENT',
  TIMEOUT: 'TRANSIENT',
  APPROVAL_PENDING: 'APPROVAL_REQUIRED',
  APPROVAL_REJECTED: 'APPROVAL_REQUIRED',
  APPROVAL_DENIED: 'APPROVAL_REQUIRED',
  WAITING_FOR_APPROVAL: 'APPROVAL_REQUIRED',
  FFPROBE_FAILED: 'FFMPEG_FAILED',
  WHISPER_SPAWN_FAILED: 'TRANSCRIBE_FAILED',
  TRANSCRIBE_TIMEOUT: 'TRANSCRIBE_FAILED',
};

const FALLBACK: ErrorClassification = {
  code: 'UNKNOWN',
  category: 'unknown',
  retryable: false,
  requiresExternalSetup: false,
  manualApproval: true,
  severity: 'warning',
  action: 'Inspect the error manually; no automatic repair is defined for this code.',
  source: 'fallback',
};

const QUOTA_PATTERN = /quota|rate[_ -]?limit|budget[_ -]?(exceeded|disabled)|out[_ -]?of[_ -]?credit|too many requests|\b402\b|\b429\b/i;
const STALE_LEASE_PATTERN = /stale[_ -]?lease|lease[_ -]?(expired|lost)|heartbeat[_ -]?(timeout|stale|lost)/i;
const RETRY_WAIT_PATTERN = /retry[_ -]?wait|retry[_ -]?due|requeue[_ -]?due/i;

function normaliseCode(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function fromDefinition(code: KnownErrorCode, source: ErrorClassification['source']): ErrorClassification {
  return { ...DEFINITIONS[code], source };
}

function quotaClassification(source: ErrorClassification['source']): ErrorClassification {
  return fromDefinition('QUOTA', source);
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';
  try {
    return JSON.stringify(value).slice(0, 4_000);
  } catch {
    return '';
  }
}

function isKnownErrorCode(value: string): value is KnownErrorCode {
  return (KNOWN_ERROR_CODES as readonly string[]).includes(value);
}

function statusCodeOf(value: unknown): number | null {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Classifies a known error code (or alias). Unknown codes fail closed: never
 * retryable, manual review required.
 */
export function classifyErrorCode(code: unknown): ErrorClassification {
  if (typeof code !== 'string') return FALLBACK;
  const normalised = normaliseCode(code);
  if (isKnownErrorCode(normalised)) return fromDefinition(normalised, 'known_code');
  const alias = ALIASES[normalised];
  if (alias) return fromDefinition(alias, 'alias');
  if (QUOTA_PATTERN.test(normalised)) return quotaClassification('message');
  if (/not[_ -]?configured|not[_ -]?found/.test(normalised)) return fromDefinition('NOT_CONFIGURED', 'message');
  if (/^(approval|permission|forbidden)/.test(normalised)) return fromDefinition('APPROVAL_REQUIRED', 'message');
  return FALLBACK;
}

function fromHttpStatus(status: number): ErrorClassification | null {
  if (status === 402) return quotaClassification('http_status');
  if (status === 429) return fromDefinition('RATE_LIMIT', 'http_status');
  if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504) {
    return fromDefinition('TRANSIENT', 'http_status');
  }
  return null;
}

function fromMessage(text: string): ErrorClassification | null {
  if (/not[_ -]?configured|not configured|missing credential/.test(text)) return fromDefinition('NOT_CONFIGURED', 'message');
  if (/media[_ -]?not[_ -]?found|file not found/.test(text)) return fromDefinition('MEDIA_NOT_FOUND', 'message');
  if (/invalid[_ -]?input|validation failed/.test(text)) return fromDefinition('INVALID_INPUT', 'message');
  if (STALE_LEASE_PATTERN.test(text) || RETRY_WAIT_PATTERN.test(text)) return fromDefinition('TRANSIENT', 'message');
  if (/approval|awaiting approval|not approved/.test(text)) return fromDefinition('APPROVAL_REQUIRED', 'message');
  if (/ffmpeg|ffprobe/.test(text)) return fromDefinition('FFMPEG_FAILED', 'message');
  if (/transcrib|whisper/.test(text)) return fromDefinition('TRANSCRIBE_FAILED', 'message');
  if (/timeout|timed out|econnreset|econnrefused|network|fetch failed|temporar/.test(text)) {
    return fromDefinition('NETWORK', 'message');
  }
  return null;
}

/**
 * Classifies an error value (string, code object, Error, or audit payload).
 * Quota/rate-limit signals are checked first so they can never be re-labelled
 * as a code defect or as a retryable transient failure.
 */
export function classifyError(input: unknown): ErrorClassification {
  if (input == null) return FALLBACK;
  if (typeof input === 'string' || typeof input === 'number') {
    const direct = classifyErrorCode(String(input));
    return direct.code === 'UNKNOWN' ? (fromMessage(String(input)) ?? FALLBACK) : direct;
  }
  if (typeof input !== 'object') return FALLBACK;

  const value = input as Record<string, unknown>;
  const data = value.data && typeof value.data === 'object' && !Array.isArray(value.data)
    ? value.data as Record<string, unknown>
    : {};
  const signals = [
    value.code,
    value.errorCode,
    value.reason,
    value.name,
    value.type,
    value.message,
    value.status,
    value.httpStatus,
    value.statusCode,
    data.code,
    data.errorCode,
    data.outcome,
    data.status,
    data.reason,
    data.error,
    data.message,
  ];
  const combinedText = signals.map(textOf).join(' ').slice(0, 8_000);
  if (QUOTA_PATTERN.test(combinedText)) return quotaClassification('message');

  for (const signal of signals) {
    if (typeof signal !== 'string' && typeof signal !== 'number') continue;
    const classified = classifyErrorCode(String(signal));
    if (classified.code !== 'UNKNOWN') return classified;
  }

  const status = statusCodeOf(value.status ?? value.httpStatus ?? value.statusCode ?? data.status);
  if (status !== null) {
    const byStatus = fromHttpStatus(status);
    if (byStatus) return byStatus;
  }

  return fromMessage(combinedText) ?? FALLBACK;
}

/** Classifies a real AuditEvent row without inventing any payload fields. */
export function classifyAuditEvent(
  event: Pick<HealingAuditEvent, 'type' | 'data'>,
): ErrorClassification {
  return classifyError({
    type: event.type,
    data: event.data,
  });
}

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

function dataObject(event: HealingAuditEvent): Record<string, unknown> {
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return {};
  return event.data as Record<string, unknown>;
}

function eventSignalText(event: HealingAuditEvent): string {
  const data = dataObject(event);
  return [
    event.type,
    data.code,
    data.errorCode,
    data.reason,
    data.error,
    data.message,
  ].map(textOf).join(' ');
}

function targetFromEvent(event: HealingAuditEvent, workspaceId: string): HealingTarget | null {
  const data = dataObject(event);
  const explicit = data.healingTarget;
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
    const candidate = explicit as Record<string, unknown>;
    if (
      (candidate.kind === 'job' || candidate.kind === 'orchestration_run') &&
      typeof candidate.id === 'string' && candidate.id.trim()
    ) {
      return { kind: candidate.kind, id: candidate.id.trim(), workspaceId };
    }
  }
  if (typeof data.jobId === 'string' && data.jobId.trim()) {
    return { kind: 'job', id: data.jobId.trim(), workspaceId };
  }
  if (typeof data.resourceId === 'string' && data.resourceId.trim() &&
      (data.resourceKind === 'job' || data.resourceKind === 'orchestration_run')) {
    return { kind: data.resourceKind, id: data.resourceId.trim(), workspaceId };
  }
  return null;
}

interface HealingRule {
  readonly key: string;
  readonly action: HealingAction | null;
  readonly classification: ErrorClassification;
  readonly reason: (count: number, durationMs: number) => string;
  readonly matches: (event: HealingAuditEvent) => boolean;
}

function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

const RULES: readonly HealingRule[] = [
  {
    key: 'stale_lease_recovery',
    action: 'clear_stale_lease',
    classification: fromDefinition('TRANSIENT', 'known_code'),
    reason: (count, durationMs) =>
      `${count} stale lease/heartbeat audit events in the last ${formatDuration(durationMs)}. Re-check the stored lease before clearing it; a live lease is never touched.`,
    matches: (event) => STALE_LEASE_PATTERN.test(eventSignalText(event)),
  },
  {
    key: 'retry_wait_due',
    action: 'promote_due_retry_wait',
    classification: fromDefinition('TRANSIENT', 'known_code'),
    reason: (count, durationMs) =>
      `${count} retry-wait audit events in the last ${formatDuration(durationMs)}. Re-queue only rows whose runAt is due and that hold no live lease.`,
    matches: (event) => RETRY_WAIT_PATTERN.test(eventSignalText(event)),
  },
  {
    key: 'quota_wait',
    action: null,
    classification: quotaClassification('known_code'),
    reason: (count, durationMs) =>
      `${count} external quota/budget audit events in the last ${formatDuration(durationMs)}. Wait for free quota or ask the owner to review limits; never bypass the limit.`,
    matches: (event) => {
      const code = classifyAuditEvent(event).code;
      return code === 'QUOTA' || code === 'RATE_LIMIT' || code === 'AI_BUDGET_EXCEEDED';
    },
  },
  {
    key: 'approval_required',
    action: null,
    classification: fromDefinition('APPROVAL_REQUIRED', 'known_code'),
    reason: (count, durationMs) =>
      `${count} approval audit events in the last ${formatDuration(durationMs)}. Request a new explicit decision; no approval gate is bypassed.`,
    matches: (event) => classifyAuditEvent(event).code === 'APPROVAL_REQUIRED',
  },
  {
    key: 'external_setup_required',
    action: null,
    classification: fromDefinition('NOT_CONFIGURED', 'known_code'),
    reason: (count, durationMs) =>
      `${count} configuration/media audit events in the last ${formatDuration(durationMs)}. Restore setup or media manually; no provider call or upload is attempted.`,
    matches: (event) => {
      const code = classifyAuditEvent(event).code;
      return code === 'NOT_CONFIGURED' || code === 'MEDIA_NOT_FOUND';
    },
  },
  {
    key: 'transient_observation',
    action: null,
    classification: fromDefinition('TRANSIENT', 'known_code'),
    reason: (count, durationMs) =>
      `${count} transient/network audit events in the last ${formatDuration(durationMs)}. Let the existing scheduler retry with backoff.`,
    matches: (event) => {
      const code = classifyAuditEvent(event).code;
      return code === 'TRANSIENT' || code === 'NETWORK';
    },
  },
  {
    key: 'tool_failure_observation',
    action: null,
    classification: fromDefinition('FFMPEG_FAILED', 'known_code'),
    reason: (count, durationMs) =>
      `${count} ffmpeg/transcription audit events in the last ${formatDuration(durationMs)}. Inspect the upstream input and tool logs manually.`,
    matches: (event) => {
      const code = classifyAuditEvent(event).code;
      return code === 'FFMPEG_FAILED' || code === 'TRANSCRIBE_FAILED';
    },
  },
  {
    key: 'input_correction',
    action: null,
    classification: fromDefinition('INVALID_INPUT', 'known_code'),
    reason: (count, durationMs) =>
      `${count} invalid-input audit events in the last ${formatDuration(durationMs)}. Correct the input before resubmitting.`,
    matches: (event) => classifyAuditEvent(event).code === 'INVALID_INPUT',
  },
];

function buildEvidence(
  rule: string,
  events: readonly HealingAuditEvent[],
  threshold: number,
  window: { readonly from: string; readonly to: string; readonly durationMs: number },
): HealingEvidence {
  const byType = new Map<string, number>();
  const byCode = new Map<string, number>();
  for (const event of events) {
    byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
    const code = classifyAuditEvent(event).code;
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  }
  const counts = (map: Map<string, number>): { type: string; count: number }[] =>
    [...map.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  return {
    rule,
    count: events.length,
    threshold,
    eventIds: events.map((event) => event.id),
    types: counts(byType),
    codes: counts(byCode).map(({ type, count }) => ({ code: type, count })),
    window,
  };
}

/**
 * Pure derivation from real AuditEvent rows. No database, clock, provider, or
 * mutation is used beyond the explicitly supplied `options.now`.
 */
export function proposeHealing(
  events: readonly HealingAuditEvent[],
  options: ProposeHealingOptions,
): HealingProposal[] {
  const nowMs = parseTimestamp(options.now);
  if (nowMs === null) return [];
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId) return [];

  const windowMs = clamp(options.windowMs, DEFAULT_HEALING_WINDOW_MS, 1_000, 30 * 86_400_000);
  const threshold = clamp(options.minOccurrences, DEFAULT_HEALING_MIN_OCCURRENCES, 1, 20);
  const limit = clamp(options.limit, DEFAULT_HEALING_EVENT_LIMIT, 1, MAX_HEALING_EVENT_LIMIT);
  const fromMs = nowMs - windowMs;
  const to = new Date(nowMs);
  const from = new Date(fromMs);
  const window = { from: from.toISOString(), to: to.toISOString(), durationMs: windowMs };

  const sorted = events
    .filter((event) => {
      if (typeof event.workspaceId === 'string' && event.workspaceId && event.workspaceId !== workspaceId) return false;
      const at = parseTimestamp(event.createdAt);
      return at !== null && at >= fromMs && at <= nowMs;
    })
    .sort((a, b) => (parseTimestamp(b.createdAt) ?? 0) - (parseTimestamp(a.createdAt) ?? 0) || a.id.localeCompare(b.id))
    .slice(0, limit);

  const proposals: HealingProposal[] = [];
  for (const rule of RULES) {
    const matched = sorted.filter(rule.matches);
    if (matched.length < threshold) continue;

    const groups = new Map<string, { target: HealingTarget | null; events: HealingAuditEvent[] }>();
    for (const event of matched) {
      const target = rule.action ? targetFromEvent(event, workspaceId) : null;
      const key = target ? `${target.kind}:${target.id}` : 'advisory';
      const group = groups.get(key) ?? { target, events: [] };
      group.events.push(event);
      groups.set(key, group);
    }

    for (const [key, group] of groups) {
      const matchedEvents = group.events;
      if (matchedEvents.length < threshold) continue;
      const confidence = roundConfidence(
        Math.min(0.9, matchedEvents.length / (matchedEvents.length + 2) + (matchedEvents.length >= 3 ? 0.05 : 0)),
      );
      proposals.push({
        id: `sh:${workspaceId}:${rule.key}:${key}:${from.toISOString()}`,
        workspaceId,
        rule: rule.key,
        reason: rule.reason(matchedEvents.length, windowMs),
        classification: rule.classification,
        action: rule.action && group.target ? rule.action : null,
        target: group.target,
        evidence: buildEvidence(rule.key, matchedEvents, threshold, window),
        confidence,
        source: HEALING_SOURCE,
        applied: false,
      });
    }
  }
  return proposals;
}

/** Collects AuditEvent rows through an injected, workspace-scoped loader. */
export async function collectHealingProposals(
  workspaceId: string,
  loader: HealingAuditLoader,
  options: Omit<ProposeHealingOptions, 'workspaceId'> = {},
): Promise<HealingProposalReport> {
  const id = workspaceId.trim();
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('INVALID_HEALING_WORKSPACE_ID');
  const nowMs = parseTimestamp(options.now ?? new Date());
  if (nowMs === null) throw new Error('INVALID_HEALING_NOW');

  const windowMs = clamp(options.windowMs, DEFAULT_HEALING_WINDOW_MS, 1_000, 30 * 86_400_000);
  const limit = clamp(options.limit, DEFAULT_HEALING_EVENT_LIMIT, 1, MAX_HEALING_EVENT_LIMIT);
  const from = new Date(nowMs - windowMs);
  const to = new Date(nowMs);

  const rows = await loader({ workspaceId: id, from, to, limit });
  const allRows = Array.isArray(rows) ? rows : [];
  const events = allRows.slice(0, limit);
  return {
    workspaceId: id,
    generatedAt: to.toISOString(),
    window: { from: from.toISOString(), to: to.toISOString(), durationMs: windowMs },
    eventsExamined: events.length,
    truncated: allRows.length > limit,
    proposals: proposeHealing(events, { ...options, workspaceId: id, now: to }),
  };
}

function cloneState(state: HealingState): HealingState {
  return { ...state };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reverts executed mutations in reverse order; a failed revert never hides others. */
export async function rollbackHealingMutations(
  mutations: readonly ExecutedMutation[],
  store: HealingStateStore,
): Promise<RollbackResult> {
  const reverted: ExecutedMutation[] = [];
  const errors: string[] = [];
  for (const mutation of [...mutations].reverse()) {
    try {
      await store.write(cloneState(mutation.before));
      reverted.push(mutation);
    } catch (error) {
      errors.push(`${mutation.ref.kind}:${mutation.ref.id}: ${errorMessage(error)}`);
    }
  }
  return {
    rolledBack: errors.length === 0 && reverted.length === mutations.length,
    reverted,
    errors,
  };
}

function noOpRollback(): Promise<RollbackResult> {
  return Promise.resolve({ rolledBack: true, reverted: [], errors: [] });
}

function buildMutation(
  proposal: HealingProposal,
  action: HealingAction,
  ref: HealingTarget,
  before: HealingState,
  after: HealingState,
  appliedAt: string,
): ExecutedMutation {
  return {
    proposalId: proposal.id,
    action,
    ref,
    before: cloneState(before),
    after: cloneState(after),
    appliedAt,
  };
}

function validateProposal(proposal: HealingProposal, context: HealingContext): string | null {
  if (proposal.applied !== false) return 'ALREADY_APPLIED';
  if (proposal.workspaceId !== context.workspaceId) return 'WORKSPACE_MISMATCH';
  if (!proposal.action) return 'ADVISORY_ONLY';
  if (!SAFE_HEALING_ACTIONS.includes(proposal.action)) return 'UNSAFE_ACTION';
  if (!context.allowedActions.includes(proposal.action)) return 'ACTION_NOT_ALLOWED';
  if (proposal.classification.manualApproval) return 'MANUAL_APPROVAL_REQUIRED';
  if (proposal.classification.requiresExternalSetup) return 'EXTERNAL_SETUP_REQUIRED';
  if (!proposal.classification.retryable) return 'NOT_RETRYABLE';
  if (!proposal.target || proposal.target.workspaceId !== context.workspaceId) return 'INVALID_TARGET';
  return null;
}

function validateState(
  action: HealingAction,
  state: HealingState,
  nowMs: number,
  staleMs: number,
): string | null {
  if (!state.workspaceId.trim() || !state.id.trim()) return 'INVALID_TARGET';
  const leaseExpiry = parseTimestamp(state.leaseExpiresAt);
  if (leaseExpiry !== null && leaseExpiry > nowMs) return 'LIVE_LEASE';

  if (action === 'clear_stale_lease') {
    const status = state.status.toLowerCase();
    if (status !== 'running' && status !== 'queued') return 'NOT_RUNNING';
    const heartbeat = parseTimestamp(state.heartbeatAt);
    const hasLeaseSignal = Boolean(state.leaseOwner || state.leaseToken || leaseExpiry !== null || heartbeat !== null);
    if (!hasLeaseSignal) return 'NO_STALE_LEASE';
    if (leaseExpiry === null && !(heartbeat !== null && heartbeat <= nowMs - staleMs)) {
      return 'NO_STALE_LEASE';
    }
    return null;
  }

  if (state.kind !== 'job') return 'NOT_A_JOB';
  if (state.status !== 'RETRY_WAIT') return 'NOT_RETRY_WAIT';
  const runAt = parseTimestamp(state.runAt);
  if (runAt === null || runAt > nowMs) return 'NOT_DUE';
  return null;
}

function nextState(action: HealingAction, state: HealingState, nowIso: string): HealingState {
  const clearedLease = {
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    updatedAt: nowIso,
  };
  if (action === 'clear_stale_lease') return { ...state, ...clearedLease };
  return { ...state, ...clearedLease, status: 'QUEUED' };
}

/**
 * Applies only explicitly approved, allow-listed repairs. The caller owns the
 * state store and the quality gates; this function has no ambient access.
 */
export async function applyHealing(
  proposals: HealingProposal | readonly HealingProposal[],
  context: HealingContext,
): Promise<HealingApplyResult> {
  const list: readonly HealingProposal[] = Array.isArray(proposals) ? proposals : [proposals];
  const primary = list[0];
  const base = {
    proposalId: primary?.id ?? '',
    workspaceId: typeof context?.workspaceId === 'string' ? context.workspaceId : '',
    actor: typeof context?.actor === 'string' ? context.actor : '',
    dryRun: context?.dryRun === true,
    verification: null,
    mutations: [] as readonly ExecutedMutation[],
    rolledBack: true,
    rollbackErrors: [] as readonly string[],
  };

  const deny = (outcome: HealingOutcome, reason: string, message: string): HealingApplyResult => ({
    ...base,
    outcome,
    applied: false,
    reason,
    message,
    async rollback() { return noOpRollback(); },
  });

  if (!context || typeof context !== 'object' || !context.store || typeof context.store.read !== 'function' ||
      typeof context.store.write !== 'function' || typeof context.verify !== 'function' ||
      !base.workspaceId.trim() || !base.actor.trim()) {
    return deny('denied', 'INVALID_CONTEXT', 'A complete healing context with actor, store and verify is required.');
  }
  if (context.dryRun !== false) {
    return deny('denied', 'DRY_RUN', 'Dry-run contexts never mutate state.');
  }
  if (context.approved !== true) {
    return deny('denied', 'APPROVAL_REQUIRED', 'Explicit approval is required before any mutation.');
  }
  if (!list.length) {
    return deny('denied', 'NO_PROPOSALS', 'No proposals were supplied.');
  }
  for (const proposal of list) {
    const reason = validateProposal(proposal, context);
    if (reason) return deny('denied', reason, `Proposal ${proposal.id} is not eligible for a controlled repair.`);
  }

  const nowMs = parseTimestamp(context.now ?? new Date());
  if (nowMs === null) return deny('denied', 'INVALID_NOW', 'The supplied clock is not a valid timestamp.');
  const staleMs = clamp(context.staleLeaseMs, DEFAULT_STALE_LEASE_MS, 1_000, 600_000);
  const nowIso = new Date(nowMs).toISOString();
  const executed: ExecutedMutation[] = [];

  const finishFailure = async (outcome: HealingOutcome, reason: string, message: string): Promise<HealingApplyResult> => {
    const rollback = await rollbackHealingMutations(executed, context.store);
    let alreadyRolledBack = rollback.rolledBack;
    return {
      ...base,
      outcome,
      applied: false,
      reason,
      message,
      mutations: [...executed],
      rolledBack: rollback.rolledBack,
      rollbackErrors: rollback.errors,
      async rollback(): Promise<RollbackResult> {
        if (alreadyRolledBack) return noOpRollback();
        const next = await rollbackHealingMutations(executed, context.store);
        alreadyRolledBack = next.rolledBack;
        return next;
      },
    };
  };

  try {
    for (const proposal of list) {
      const action = proposal.action as HealingAction;
      const ref = proposal.target as HealingTarget;
      const before = await context.store.read({ ...ref });
      if (!before) {
        return await finishFailure('state_missing', 'STATE_MISSING', `No state row for ${ref.kind}:${ref.id}.`);
      }
      if (before.workspaceId !== context.workspaceId || before.kind !== ref.kind || before.id !== ref.id) {
        return await finishFailure('state_missing', 'STATE_MISMATCH', `State row ${ref.kind}:${ref.id} does not match the approved target.`);
      }
      const stateReason = validateState(action, before, nowMs, staleMs);
      if (stateReason) {
        return await finishFailure('not_due', stateReason, `State ${ref.kind}:${ref.id} is not in a clearly recoverable state.`);
      }
      const after = nextState(action, before, nowIso);
      await context.store.write(cloneState(after));
      executed.push(buildMutation(proposal, action, ref, before, after, nowIso));
    }
  } catch (error) {
    return await finishFailure('mutation_failed', 'MUTATION_FAILED', `Store write failed: ${errorMessage(error)}`);
  }

  let verification: QualityGateReport;
  try {
    verification = await context.verify({
      workspaceId: context.workspaceId,
      actor: context.actor,
      now: nowIso,
      proposals: list.map(({ id, rule, action }) => ({ id, rule, action })),
      mutations: [...executed],
    });
  } catch (error) {
    return await finishFailure('verify_failed', 'VERIFY_THREW', `Quality-gate verification threw: ${errorMessage(error)}`);
  }

  const gates = verification?.gates ?? {};
  const failedGates = REQUIRED_QUALITY_GATES.filter((gate) => gates[gate] !== true);
  if (verification?.ok === false || failedGates.length > 0) {
    const missing = failedGates.length ? failedGates.join(', ') : 'ok=false';
    return await finishFailure('verify_failed', 'VERIFY_FAILED', `Quality gates failed: ${missing}.`);
  }

  let alreadyRolledBack = false;
  return {
    ...base,
    outcome: 'applied',
    applied: true,
    reason: 'APPLIED',
    message: `${executed.length} controlled repair(s) applied and verified.`,
    verification,
    mutations: [...executed],
    rolledBack: false,
    async rollback(): Promise<RollbackResult> {
      if (alreadyRolledBack) return noOpRollback();
      const next = await rollbackHealingMutations(executed, context.store);
      alreadyRolledBack = next.rolledBack;
      return next;
    },
  };
}

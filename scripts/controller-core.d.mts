export type FailureClass =
  | 'GLOBAL_FREE_QUOTA'
  | 'PROVIDER_LIMIT'
  | 'MODEL_RATE_LIMIT'
  | 'INFRA'
  | 'AUTH_BLOCKER'
  | 'CODE_FAIL';

export type CooldownReason = FailureClass | string;

export interface CooldownEntry {
  until: string;
  untilMs: number;
  reason?: string;
  level?: number;
}

export interface ActiveCooldowns {
  models: Record<string, CooldownEntry>;
  providers: Record<string, CooldownEntry>;
}

export interface QueueTask {
  taskId: string;
  text: string;
  attempts: number;
  firstSeenAt?: number;
  claimedAt?: number;
  requeuedAt?: number;
  recoveredLease?: boolean;
  at?: number;
  reason?: string;
  fingerprint?: string;
}

export interface ReplayResult {
  pending: QueueTask[];
  completed: QueueTask[];
  failed: QueueTask[];
  quarantined: QueueTask[];
  /** Tasks retired as stale discovery; terminal, but not a code failure. */
  obsolete: QueueTask[];
  /** Leases that were open at replay time and are now back in `pending`. */
  recovered: QueueTask[];
  /** Always empty after replay: no lease is trusted across a restart. */
  inFlight: QueueTask[];
}

export interface JournalEvent {
  type: 'enqueue' | 'claim' | 'requeue' | 'complete' | 'fail' | 'quarantine' | 'obsolete';
  taskId: string;
  text?: string;
  attempts?: number;
  at?: number | string;
  fingerprint?: string;
  reason?: string;
}

export interface LastUsedEntry {
  at?: number | string;
  lastUsedAt?: number | string;
  uses?: number;
}

export type LastUsed = Record<string, number | string | LastUsedEntry>;

export type CatalogEntry = string | { id?: string; providerID?: string; modelID?: string };
export type Catalog = CatalogEntry[] | { models?: CatalogEntry[] };

export type CooldownInput = Record<string, unknown> | ActiveCooldowns;

export const FAILURE_CLASSES: readonly FailureClass[];
export const FREE_MODELS_FILE: URL;
export const CHECKPOINT_PREFIXES: readonly string[];

export function cleanLogText(logText: unknown): string;
export function classifyFailure(logText: unknown, exitCode?: number | string | null): FailureClass;
export function backoffMs(level: number, retryAfterSeconds?: number | string | null): number;
export function readFreeModelAllowlist(file?: URL | string): readonly string[];
export function replayQueue(events: readonly JournalEvent[] | readonly unknown[]): ReplayResult;
export function providerOf(modelId: string): string;
export function normalizeCooldowns(raw?: CooldownInput | null, now?: number): ActiveCooldowns;
export function setCooldown(
  raw: CooldownInput | null | undefined,
  kind: 'model' | 'provider',
  id: string,
  until: number | string | { until: number | string },
  reason?: CooldownReason,
  now?: number,
): ActiveCooldowns;
export function activeCooldowns(raw?: CooldownInput | null, now?: number): ActiveCooldowns;
export function isCooled(raw: CooldownInput | null | undefined, modelId: string, now?: number): boolean;
export function eligibleModels(
  catalog: Catalog,
  cooldowns: CooldownInput | null | undefined,
  now?: number,
  lastUsed?: LastUsed,
  allowlist?: readonly string[],
): string[];
export function normalizeDirtyPath(value: unknown): string;
export function selectCheckpointPaths(
  baselineDirtyPaths: readonly unknown[],
  currentDirtyPaths: readonly unknown[],
  allowedPrefixes?: readonly string[],
): string[];
export function stableTaskId(text: unknown): string;

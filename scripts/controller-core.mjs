// Pure, side-effect-light logic for the autonomous controller.
// No DB, no network, no git, no model calls. The only file read is the
// proven-free model allowlist (scripts/free-models.json).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const FAILURE_CLASSES = Object.freeze([
  'GLOBAL_FREE_QUOTA',
  'PROVIDER_LIMIT',
  'MODEL_RATE_LIMIT',
  'INFRA',
  'AUTH_BLOCKER',
  'CODE_FAIL',
]);

export const FREE_MODELS_FILE = new URL('./free-models.json', import.meta.url);

export const CHECKPOINT_PREFIXES = Object.freeze([
  'src/',
  'lib/',
  'tests/',
  'prisma/schema.prisma',
  'docs/autonomous-build/STATE.md',
]);

const BACKOFF_LADDER_MS = Object.freeze([
  60_000, 120_000, 240_000, 480_000, 960_000, 3_600_000, 21_600_000,
]);
const MAX_BACKOFF_MS = 21_600_000; // 6h exponential cap
const MAX_RETRY_AFTER_MS = 86_400_000; // never wait more than 24h on an explicit directive

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
let freeModelCache = null;

/** Strip ANSI colour codes and normalise line endings before matching. */
export function cleanLogText(logText) {
  return String(logText ?? '')
    .replace(ANSI_RE, '')
    .replace(/\r/g, '')
    .toLowerCase();
}

/**
 * Classify an agent/verification failure. Order matters: the global free
 * quota message also contains "switch models" and must not be downgraded to a
 * model rate limit, and provider-wide quota is distinct from a model 429.
 */
export function classifyFailure(logText, exitCode) {
  const text = cleanLogText(logText);
  const code = Number.isFinite(Number(exitCode)) ? Number(exitCode) : null;

  // Real string (with ANSI colour codes in the log):
  // "Free usage limit reached. Connect a provider or subscribe to OpenCode Go
  //  to keep going, or switch models."
  if (
    text.includes('free usage limit reached') ||
    text.includes('connect a provider or subscribe') ||
    (text.includes('opencode go') && /subscribe|limit|quota|credits?/.test(text))
  ) {
    return 'GLOBAL_FREE_QUOTA';
  }

  const providerQuota =
    /provider[^\n]{0,60}(quota|limit|exhausted|capacity)/.test(text) ||
    /(quota|usage)[^\n]{0,60}(exceeded|exhausted|reached)/.test(text) ||
    /(daily|monthly|account|billing|spending)[^\n]{0,40}(quota|limit)/.test(text) ||
    /quota[^\n]{0,40}(provider|exhausted|exceeded)/.test(text);
  if (providerQuota) return 'PROVIDER_LIMIT';

  const modelRate =
    /\b429\b/.test(text) ||
    /rate[ -]?limit/.test(text) ||
    /too many requests/.test(text) ||
    /retry[ -]?after/.test(text) ||
    /throttl/.test(text);
  if (modelRate || code === 429) return 'MODEL_RATE_LIMIT';

  const authPhrase =
    /missing[ -]?credential/.test(text) ||
    /no credential/.test(text) ||
    /credential[^\n]{0,40}(missing|invalid|required)/.test(text) ||
    /unauthori[sz]ed|authentication[^\n]{0,30}(fail|required)|invalid[^\n]{0,20}(api[ -]?key|token)/.test(text) ||
    /payment required|insufficient[^\n]{0,20}(credit|balance)|billing[^\n]{0,30}(required|failed|disabled)/.test(text) ||
    /api[ -]?key[^\n]{0,30}(required|missing|invalid)|login required|forbidden/.test(text);
  if (authPhrase || code === 401 || code === 402 || code === 403) return 'AUTH_BLOCKER';

  const infra =
    code === 124 || code === 137 || (code !== null && code >= 500 && code <= 599) ||
    /\b5\d\d\b/.test(text) ||
    /econnreset|econnrefused|enotfound|etimedout|eai_again|socket hang up|network[^\n]{0,30}(fail|error|unavailable)|fetch failed|dns[^\n]{0,20}(fail|error)|connection[^\n]{0,30}(fail|reset|refused|timeout)|timed?[ -]?out|timeout/.test(text) ||
    /service unavailable|bad gateway|gateway timeout|temporarily unavailable|server error/.test(text);
  if (infra) return 'INFRA';

  return 'CODE_FAIL';
}

/** Absolute epoch milliseconds: epoch-seconds, epoch-ms, or an ISO/HTTP date. */
function parseTimeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return 0;
    // Epoch timestamps: seconds look <= 1e12, milliseconds are larger.
    return value <= 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return numeric <= 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Retry-After: relative seconds, or an HTTP date relative to now. */
function parseRetryAfterMs(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, value * 1000));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return Math.min(MAX_RETRY_AFTER_MS, Number(trimmed) * 1000);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, parsed - now));
    }
  }
  return null;
}

/** 1m, 2m, 4m, 8m, 16m, 1h, 6h (capped); Retry-After may extend, never shorten. */
export function backoffMs(level, retryAfterSeconds) {
  const index = Math.min(
    BACKOFF_LADDER_MS.length - 1,
    Math.max(0, Math.floor(Number(level) || 1) - 1),
  );
  const base = BACKOFF_LADDER_MS[index] ?? BACKOFF_LADDER_MS[0];
  const directed = parseRetryAfterMs(retryAfterSeconds);
  if (directed === null) return Math.min(MAX_BACKOFF_MS, base);
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(base, directed));
}

/** The only proven-free source; paid fallbacks are deliberately impossible. */
export function readFreeModelAllowlist(file = FREE_MODELS_FILE) {
  if (freeModelCache && String(file) === String(FREE_MODELS_FILE)) return freeModelCache;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const models = Array.isArray(parsed?.models)
    ? parsed.models.filter((value) => typeof value === 'string' && value.includes('/'))
    : [];
  if (!file || String(file) === String(FREE_MODELS_FILE)) freeModelCache = Object.freeze(models);
  return Object.freeze(models);
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function eventAt(event) {
  return typeof event.at === 'number' ? event.at : Date.parse(event.at || '') || Date.now();
}

function normaliseEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type ?? '').toLowerCase();
  if (!['enqueue', 'claim', 'requeue', 'complete', 'fail', 'quarantine', 'obsolete'].includes(type)) return null;
  const taskId = raw.taskId ?? raw.id ?? raw.task_id;
  if (!taskId) return null;
  return {
    type,
    taskId: String(taskId),
    text: String(raw.text ?? raw.task ?? raw.description ?? ''),
    attempts: numeric(raw.attempts, 0),
    fingerprint: raw.fingerprint === undefined ? undefined : String(raw.fingerprint),
    reason: raw.reason === undefined ? undefined : String(raw.reason),
    at: eventAt(raw),
  };
}

/**
 * Rebuild queue truth from the append-only journal. An interrupted lease
 * (claim with no terminal event) becomes pending again with unchanged attempts.
 */
export function replayQueue(events) {
  const pending = new Map();
  const inFlight = new Map();
  const terminal = new Set();
  const completed = [];
  const failed = [];
  const quarantined = [];
  const obsolete = [];
  const recovered = [];

  for (const raw of Array.isArray(events) ? events : []) {
    const event = normaliseEvent(raw);
    if (!event) continue;
    const { taskId } = event;
    const existing = pending.get(taskId) ?? inFlight.get(taskId);
    const base = existing ?? {
      taskId,
      text: event.text,
      attempts: event.attempts,
      firstSeenAt: event.at,
    };

    switch (event.type) {
      case 'enqueue':
        if (!terminal.has(taskId) && !existing) pending.set(taskId, { ...base, attempts: Math.max(base.attempts, event.attempts) });
        break;
      case 'claim':
        if (!terminal.has(taskId)) {
          inFlight.set(taskId, {
            ...base,
            text: event.text || base.text,
            attempts: event.attempts || base.attempts,
            claimedAt: event.at,
          });
          pending.delete(taskId);
        }
        break;
      case 'requeue':
        if (!terminal.has(taskId)) {
          const task = inFlight.get(taskId) ?? base;
          pending.set(taskId, {
            ...task,
            text: event.text || task.text,
            attempts: numeric(event.attempts, task.attempts),
            requeuedAt: event.at,
          });
          inFlight.delete(taskId);
        }
        break;
      case 'complete':
      case 'fail':
      case 'quarantine':
      case 'obsolete': {
        pending.delete(taskId);
        inFlight.delete(taskId);
        terminal.add(taskId);
        const record = {
          ...base,
          text: event.text || base.text,
          attempts: numeric(event.attempts, base.attempts),
          at: event.at,
          reason: event.reason,
          fingerprint: event.fingerprint,
        };
        if (event.type === 'complete') completed.push(record);
        else if (event.type === 'fail') failed.push(record);
        else if (event.type === 'quarantine') quarantined.push(record);
        else obsolete.push(record);
        break;
      }
      default:
        break;
    }
  }

  for (const [taskId, task] of inFlight) {
    const returned = { ...task, requeuedAt: Date.now(), recoveredLease: true };
    pending.set(taskId, returned);
    recovered.push(returned);
  }

  return { pending: [...pending.values()], completed, failed, quarantined, obsolete, recovered, inFlight: [] };
}

export function providerOf(modelId) {
  const id = String(modelId ?? '');
  return id.includes('/') ? id.slice(0, id.indexOf('/')) : id;
}

function cooldownEntry(value, now) {
  let until;
  let reason;
  let level;
  if (typeof value === 'object' && value !== null) {
    until = parseTimeMs(value.until ?? value.untilMs ?? value.expiresAt);
    reason = value.reason;
    level = value.level;
  } else {
    until = parseTimeMs(value);
  }
  if (until === null || until <= now) return null;
  return {
    until: new Date(until).toISOString(),
    untilMs: until,
    ...(reason ? { reason: String(reason) } : {}),
    ...(level !== undefined ? { level: numeric(level) } : {}),
  };
}

/** Drop expired entries and accept both structured and legacy cooldown shapes. */
export function normalizeCooldowns(raw, now = Date.now()) {
  const result = { models: {}, providers: {} };
  const source = raw && typeof raw === 'object' ? raw : {};
  const add = (target, id, value) => {
    const entry = cooldownEntry(value, now);
    if (entry && id) result[target][String(id)] = entry;
  };

  for (const [key, value] of Object.entries(source.models ?? {})) add('models', key, value);
  for (const [key, value] of Object.entries(source.providers ?? {})) add('providers', key, value);

  for (const [key, value] of Object.entries(source)) {
    if (key === 'models' || key === 'providers') continue;
    if (key.startsWith('provider:')) add('providers', key.slice('provider:'.length), value);
    else if (key.startsWith('provider/')) add('providers', key.slice('provider/'.length), value);
    else if (typeof value === 'object' && value !== null && value.provider && !value.model) {
      add('providers', value.provider, value);
    } else if (key.includes('/')) add('models', key, value);
    else add('providers', key, value);
  }
  return result;
}

export function setCooldown(raw, kind, id, until, reason, now = Date.now()) {
  const active = normalizeCooldowns(raw, now);
  const entry = cooldownEntry({ until, reason }, now);
  const target = kind === 'provider' ? 'providers' : 'models';
  if (entry && id) active[target][String(id)] = entry;
  return active;
}

export function activeCooldowns(raw, now = Date.now()) {
  return normalizeCooldowns(raw, now);
}

export function isCooled(raw, modelId, now = Date.now()) {
  const active = normalizeCooldowns(raw, now);
  const id = String(modelId ?? '');
  return Boolean(active.models[id] || active.providers[providerOf(id)]);
}

function catalogueIds(catalog) {
  const values = Array.isArray(catalog)
    ? catalog
    : Array.isArray(catalog?.models) ? catalog.models : [];
  const ids = [];
  for (const value of values) {
    if (typeof value === 'string') {
      const id = value.trim().split(/\s+/)[0];
      if (/^[^/\s]+\/[^/\s]+$/.test(id)) ids.push(id);
    } else if (value && typeof value === 'object') {
      const id = value.id ?? (value.providerID && value.modelID ? `${value.providerID}/${value.modelID}` : null);
      if (id && String(id).includes('/')) ids.push(String(id));
    }
  }
  return [...new Set(ids)];
}

/** Prove free via the allowlist file only, then select least-recently-used. */
export function eligibleModels(catalog, cooldowns, now = Date.now(), lastUsed = {}, allowlist) {
  const free = new Set(allowlist ?? readFreeModelAllowlist());
  const active = normalizeCooldowns(cooldowns, now);
  const used = lastUsed && typeof lastUsed === 'object' ? lastUsed : {};
  const lastAt = (id) => {
    const entry = used[id];
    const value = typeof entry === 'object' && entry !== null ? entry.at ?? entry.lastUsedAt : entry;
    const parsed = parseTimeMs(value);
    return parsed ?? 0;
  };
  return catalogueIds(catalog)
    .filter((id) => free.has(id) && !active.models[id] && !active.providers[providerOf(id)])
    .map((id, index) => ({ id, index, at: lastAt(id) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((entry) => entry.id);
}

const FORBIDDEN_PATH_RE = [
  /(^|\/)docs\/completion\/controller\//,
  /(^|\/)docs\/completion\/[^/]*\.(log|out|jsonl)/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)src\/generated\//,
  /(^|\/)generated\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)logs?\//,
  /\.log$/,
  /(^|\/)\.git\//,
  /(^|\/)\.mece-control\//,
];

/** Accept git porcelain lines as well as plain paths. */
export function normalizeDirtyPath(value) {
  let path = String(value ?? '').trim();
  if (/^[MADRCU?! ]{1,2}\s/.test(path)) path = path.replace(/^[MADRCU?! ]{1,2}\s+/, '');
  const arrow = path.indexOf(' -> ');
  if (arrow >= 0) path = path.slice(arrow + 4);
  path = path.replace(/^"|"$/g, '').replace(/^\.\//, '');
  return path;
}

function insidePrefix(path, prefix) {
  const clean = String(prefix).replace(/^\.\//, '');
  if (!clean) return false;
  if (clean.endsWith('/')) return path.startsWith(clean) && path.length > clean.length;
  return path === clean || path.startsWith(`${clean}/`);
}

/**
 * Only paths that became dirty after the task started and are inside the
 * allowlist. Baseline dirt, runtime state, secrets and logs are never eligible.
 */
export function selectCheckpointPaths(baselineDirtyPaths, currentDirtyPaths, allowedPrefixes = CHECKPOINT_PREFIXES) {
  const baseline = new Set((Array.isArray(baselineDirtyPaths) ? baselineDirtyPaths : []).map(normalizeDirtyPath));
  const prefixes = Array.isArray(allowedPrefixes) ? allowedPrefixes : CHECKPOINT_PREFIXES;
  const selected = new Set();
  for (const raw of Array.isArray(currentDirtyPaths) ? currentDirtyPaths : []) {
    const path = normalizeDirtyPath(raw);
    if (!path || baseline.has(path)) continue;
    if (FORBIDDEN_PATH_RE.some((pattern) => pattern.test(path))) continue;
    if (!prefixes.some((prefix) => insidePrefix(path, prefix))) continue;
    selected.add(path);
  }
  return [...selected].sort();
}

export function stableTaskId(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 12);
}

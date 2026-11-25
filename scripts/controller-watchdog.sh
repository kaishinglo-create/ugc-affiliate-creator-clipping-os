#!/usr/bin/env bash
# External, one-shot watchdog for a stopped autonomous controller.
# It never bypasses a quota cooldown, never daemonises and never uses a paid fallback.
# Usage: bash scripts/controller-watchdog.sh
# Overrides (for diagnostics/tests): CONTROLLER_STATUS_FILE, NODE_BIN,
# WATCHDOG_HEARTBEAT_MIN_AGE_SECONDS, WATCHDOG_ONCE_TIMEOUT_SECONDS.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
JOURNAL_FILE="$ROOT/docs/completion/controller/journal.jsonl"

TMP_ROOT="${TMPDIR:-/tmp/opencode}"
mkdir -p "$TMP_ROOT" 2>/dev/null || TMP_ROOT=/tmp
RESULT_FILE="$(mktemp "$TMP_ROOT/controller-watchdog.XXXXXX")" || exit 1
RUN_LOG=""
cleanup() {
  [ -n "$RESULT_FILE" ] && rm -f "$RESULT_FILE"
  [ -n "$RUN_LOG" ] && rm -f "$RUN_LOG"
}
trap cleanup EXIT

# Decide mode: only writes a whitelisted JSON result file, never starts anything.
decide_line="$("$NODE_BIN" - "$ROOT" decide "$RESULT_FILE" <<'NODE'
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.argv[2];
const RESULT_FILE = process.argv[4];
const now = Date.now();

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value <= 1e12 ? value * 1000 : value;
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

function readStatus() {
  const override = process.env.CONTROLLER_STATUS_FILE;
  if (override && override !== 'none') return JSON.parse(fs.readFileSync(override, 'utf8'));
  const result = spawnSync(process.execPath, ['scripts/autonomous-controller.mjs', '--status'], {
    cwd: ROOT, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('status command failed');
  return JSON.parse(result.stdout);
}

function activeCooldowns(status) {
  const entries = [];
  for (const group of ['models', 'providers']) {
    const source = status?.cooldowns?.[group];
    if (!source || typeof source !== 'object') continue;
    for (const [id, raw] of Object.entries(source)) {
      const value = raw && typeof raw === 'object' ? (raw.untilMs ?? raw.until ?? raw.expiresAt) : raw;
      const until = toMs(value);
      const reason = raw && typeof raw === 'object' ? raw.reason ?? null : null;
      if (until !== null && until > now) entries.push({ id, untilMs: until, reason });
    }
  }
  return entries;
}

function localResources() {
  let freeMemoryMb = null;
  let cgroupFreeMb = null;
  let diskFreeGb = null;
  try {
    const found = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (found) freeMemoryMb = Math.round(Number(found[1]) / 1024);
  } catch { /* non-Linux */ }
  for (const [maxPath, currentPath] of [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
  ]) {
    try {
      const max = fs.readFileSync(maxPath, 'utf8').trim();
      if (!/^\d+$/.test(max)) continue;
      const usage = Number(fs.readFileSync(currentPath, 'utf8').trim());
      if (Number.isFinite(usage)) cgroupFreeMb = Math.round(Math.max(0, Number(max) - usage) / 1048576);
      break;
    } catch { /* try next */ }
  }
  const df = spawnSync('df', ['-k', ROOT], { encoding: 'utf8', timeout: 10_000 });
  const columns = String(df.stdout ?? '').split(/\r?\n/)[1]?.trim().split(/\s+/);
  if (columns && columns.length >= 4 && Number.isFinite(Number(columns[3]))) {
    diskFreeGb = Math.round((Number(columns[3]) / 1048576) * 100) / 100;
  }
  const cpuCount = os.cpus().length || 1;
  const load1 = Math.round((os.loadavg()[0] ?? 0) * 100) / 100;
  const numericEnv = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const minMemoryMb = numericEnv('WATCHDOG_MIN_FREE_MEMORY_MB', 256);
  const minCgroupMb = numericEnv('WATCHDOG_MIN_CGROUP_MEMORY_MB', 256);
  const minDiskGb = numericEnv('WATCHDOG_MIN_DISK_GB', 1);
  const maxLoad = numericEnv('WATCHDOG_MAX_LOAD_MULTIPLIER', 2) * cpuCount;
  const ok = (freeMemoryMb === null || freeMemoryMb >= minMemoryMb)
    && (cgroupFreeMb === null || cgroupFreeMb >= minCgroupMb)
    && (diskFreeGb === null || diskFreeGb >= minDiskGb)
    && load1 <= maxLoad;
  return { ok, freeMemoryMb, cgroupFreeMb, diskFreeGb, load1, cpuCount, minMemoryMb, minDiskGb, maxLoad };
}

function finish(result) {
  const clean = {
    ...result,
    reason: String(result.reason ?? '').replace(/[\r\n\t]+/g, ' ').trim(),
    paidFallbackAttempted: false,
  };
  fs.writeFileSync(RESULT_FILE, `${JSON.stringify(clean, null, 2)}\n`);
  process.stdout.write(`${clean.decision}\t${clean.reason}\n`);
}

function skip(decision, reason, details) {
  finish({ decision, reason, started: false, success: false, details, at: new Date().toISOString() });
}

try {
  const status = readStatus();
  const pauseReason = typeof status.pauseReason === 'string' && status.pauseReason ? status.pauseReason : null;
  const resumeAtMs = toMs(status.resumeAt ?? null);
  const cooldowns = activeCooldowns(status);
  const blockedCooldowns = cooldowns.filter((entry) => ['GLOBAL_FREE_QUOTA', 'PROVIDER_LIMIT', 'MODEL_RATE_LIMIT'].includes(entry.reason));
  const quotaPause = Boolean(pauseReason && /QUOTA|LIMIT/i.test(pauseReason));
  const cooldownEvidence = Boolean(status.cooldowns && typeof status.cooldowns === 'object'
    && 'models' in status.cooldowns && 'providers' in status.cooldowns);
  const details = {
    status: typeof status.status === 'string' ? status.status : 'UNKNOWN',
    pauseReason,
    resumeAt: status.resumeAt ?? null,
    resumeAtMs,
    heartbeatAgeSeconds: Number.isFinite(status.heartbeatAgeSeconds) ? status.heartbeatAgeSeconds : null,
    queueDepth: Number.isFinite(status.queueDepth) ? status.queueDepth : 0,
    controllerResourcesOk: status.resources?.ok === true,
    activeCooldownCount: cooldowns.length,
    blockedCooldownCount: blockedCooldowns.length,
    cooldownExpired: quotaPause && cooldownEvidence && blockedCooldowns.length === 0
      && (resumeAtMs === null || resumeAtMs <= now),
  };

  if (status.status !== 'stopped') {
    skip('SKIPPED_NOT_STOPPED', 'controller is not stopped', details);
  } else if (blockedCooldowns.length > 0 || (resumeAtMs !== null && resumeAtMs > now)
    || (quotaPause && !cooldownEvidence)) {
    skip('SKIPPED_COOLDOWN', 'quota cooldown still active; no model call and no controller start', details);
  } else if (resumeAtMs === null || resumeAtMs > now) {
    skip('SKIPPED_NO_RESUME_AT', 'no passthrough resumeAt in the past', details);
  } else {
    const minAge = Number(process.env.WATCHDOG_HEARTBEAT_MIN_AGE_SECONDS);
    const threshold = Number.isFinite(minAge) && minAge >= 0 ? minAge : 60;
    if (details.heartbeatAgeSeconds === null) {
      skip('SKIPPED_HEARTBEAT_UNKNOWN', 'heartbeat age unavailable', details);
    } else if (details.heartbeatAgeSeconds < threshold) {
      skip('SKIPPED_HEARTBEAT_FRESH', `heartbeat younger than ${threshold}s`, details);
    } else if (details.queueDepth <= 0) {
      skip('SKIPPED_NO_QUEUE', 'no queued task', details);
    } else {
      const resources = localResources();
      details.localResources = resources;
      if (!details.controllerResourcesOk || !resources.ok) {
        skip('SKIPPED_RESOURCES', 'resource gates not ok', details);
      } else {
        finish({
          decision: 'ALLOW_ONCE',
          reason: quotaPause ? 'cooldown expired; one free-model task allowed' : 'stopped with pending tasks; one free-model task allowed',
          started: false,
          success: false,
          details,
          at: new Date().toISOString(),
        });
      }
    }
  }
} catch {
  skip('SKIPPED_STATUS_UNAVAILABLE', 'controller status could not be read', {});
}
NODE
)" || exit 1

decision="${decide_line%%$'\t'*}"

if [ "$decision" != ALLOW_ONCE ]; then
  cat "$RESULT_FILE"
  exit 0
fi

# One bounded execution only: no loop, no background process, no paid fallback.
journal_before=0
if [ -f "$JOURNAL_FILE" ]; then
  journal_before="$(wc -l < "$JOURNAL_FILE" 2>/dev/null || printf '0')"
fi
RUN_LOG="$(mktemp "$TMP_ROOT/controller-watchdog-run.XXXXXX")" || exit 1
timeout_seconds="${WATCHDOG_ONCE_TIMEOUT_SECONDS:-900}"
if command -v timeout >/dev/null 2>&1; then
  timeout "$timeout_seconds" "$NODE_BIN" scripts/autonomous-controller.mjs --once >"$RUN_LOG" 2>&1
  run_code=$?
else
  "$NODE_BIN" scripts/autonomous-controller.mjs --once >"$RUN_LOG" 2>&1
  run_code=$?
fi

WATCHDOG_JOURNAL_BEFORE="$journal_before" "$NODE_BIN" - "$ROOT" after "$RESULT_FILE" "$run_code" >/dev/null <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.argv[2];
const RESULT_FILE = process.argv[4];
const exitCode = Number(process.argv[5]);
const journalFile = path.join(ROOT, 'docs/completion/controller/journal.jsonl');
const before = Math.max(0, Number(process.env.WATCHDOG_JOURNAL_BEFORE) || 0);

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return null;
}

const status = (() => {
  const override = process.env.CONTROLLER_STATUS_FILE;
  if (override && override !== 'none') return JSON.parse(fs.readFileSync(override, 'utf8'));
  const result = spawnSync(process.execPath, ['scripts/autonomous-controller.mjs', '--status'], {
    cwd: ROOT, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
  });
  return result.status === 0 ? JSON.parse(result.stdout) : {};
})();

const events = [];
try {
  for (const line of fs.readFileSync(journalFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* ignore malformed line */ }
  }
} catch { /* journal may not exist yet */ }
const after = events.slice(before);
const terminal = after.filter((event) => ['complete', 'fail', 'quarantine'].includes(event?.type));
const success = exitCode === 0 && terminal.length > 0;
const summary = {
  at: new Date().toISOString(),
  decision: 'RAN_ONCE',
  reason: success ? 'one task finished; controller stopped again' : 'no terminal journal event after --once',
  started: true,
  success,
  exitCode,
  paidFallbackAttempted: false,
  details: {
    journalBefore: before,
    journalAfter: events.length,
    journalEventsAfter: after.length,
    terminalEventsAfter: terminal.length,
    lastJournalType: after.length ? String(after[after.length - 1]?.type ?? 'unknown') : null,
  },
  after: {
    status: typeof status.status === 'string' ? status.status : 'UNKNOWN',
    pauseReason: typeof status.pauseReason === 'string' && status.pauseReason ? status.pauseReason : null,
    resumeAt: status.resumeAt ?? null,
    resumeAtMs: toMs(status.resumeAt ?? null),
    heartbeatAgeSeconds: Number.isFinite(status.heartbeatAgeSeconds) ? status.heartbeatAgeSeconds : null,
    queueDepth: Number.isFinite(status.queueDepth) ? status.queueDepth : 0,
    completedCount: Array.isArray(status.completed) ? status.completed.length : null,
    lastExitCode: status.lastExitCode ?? null,
  },
};
fs.writeFileSync(RESULT_FILE, `${JSON.stringify(summary, null, 2)}\n`);
NODE
after_code=$?

cat "$RESULT_FILE"
if [ "$after_code" -ne 0 ]; then
  exit 1
fi
if grep -q '"success": true' "$RESULT_FILE"; then
  exit 0
fi
exit 1

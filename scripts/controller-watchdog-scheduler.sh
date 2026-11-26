#!/usr/bin/env bash
# Bounded, observable scheduler around the one-shot controller watchdog.
# It never starts the controller itself, never bypasses a cooldown and never
# uses a paid fallback. It stops after the first bounded watchdog execution.
# Usage: bash scripts/controller-watchdog-scheduler.sh
# Overrides: WATCHDOG_SCHEDULE_INTERVAL_SECONDS, WATCHDOG_SCHEDULE_TICKS,
# WATCHDOG_SCHEDULE_LOG_FILE, WATCHDOG_SCRIPT, WATCHDOG_RUNNER, NODE_BIN.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
WATCHDOG_RUNNER="${WATCHDOG_RUNNER:-bash}"
WATCHDOG_SCRIPT="${WATCHDOG_SCRIPT:-$ROOT/scripts/controller-watchdog.sh}"
INTERVAL="${WATCHDOG_SCHEDULE_INTERVAL_SECONDS:-300}"
TICKS="${WATCHDOG_SCHEDULE_TICKS:-1}"
LOG_FILE="${WATCHDOG_SCHEDULE_LOG_FILE:-$ROOT/.run/controller-watchdog-schedule.jsonl}"

if ! [[ "$INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  printf '{"error":"INVALID_INTERVAL"}\n'
  exit 2
fi
if ! [[ "$TICKS" =~ ^[1-9][0-9]*$ ]]; then
  printf '{"error":"INVALID_TICKS"}\n'
  exit 2
fi
if [ ! -f "$WATCHDOG_SCRIPT" ]; then
  printf '{"error":"WATCHDOG_SCRIPT_NOT_FOUND"}\n'
  exit 2
fi

TMP_ROOT="${TMPDIR:-/tmp/opencode}"
mkdir -p "$TMP_ROOT" "$(dirname "$LOG_FILE")" 2>/dev/null || {
  printf '{"error":"TEMP_DIR_UNAVAILABLE"}\n'
  exit 1
}

read_field() {
  "$NODE_BIN" - "$1" "$2" <<'NODE'
'use strict';
const fs = require('node:fs');
const file = process.argv[2];
const field = process.argv[3];
let data = {};
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* keep empty */ }
const value = data?.[field];
if (typeof value === 'boolean') process.stdout.write(String(value));
else if (value === null || value === undefined) process.stdout.write('');
else process.stdout.write(String(value).replace(/[\r\n\t]+/g, ' ').slice(0, 500));
NODE
}

executed=0
last_decision=''
stop_reason='TICK_LIMIT'
first_started_at=''

for ((tick = 1; tick <= TICKS; tick += 1)); do
  out_file="$(mktemp "$TMP_ROOT/controller-watchdog-schedule.XXXXXX")" || exit 1
  started_at="$("$NODE_BIN" -p 'new Date().toISOString()')"
  if [ -z "$first_started_at" ]; then first_started_at="$started_at"; fi

  "$WATCHDOG_RUNNER" "$WATCHDOG_SCRIPT" >"$out_file" 2>&1
  exit_code=$?

  decision="$(read_field "$out_file" decision)"
  started="$(read_field "$out_file" started)"
  success="$(read_field "$out_file" success)"
  paid_fallback="$(read_field "$out_file" paidFallbackAttempted)"
  [ -n "$decision" ] || decision='UNKNOWN'
  [ "$started" = 'true' ] || started='false'
  [ "$success" = 'true' ] || success='false'
  [ "$paid_fallback" = 'true' ] || paid_fallback='false'
  executed=$tick
  last_decision="$decision"

  WATCHDOG_SCHEDULE_TICK="$tick" \
  WATCHDOG_SCHEDULE_STARTED_AT="$started_at" \
  WATCHDOG_SCHEDULE_DECISION="$decision" \
  WATCHDOG_SCHEDULE_EXIT_CODE="$exit_code" \
  WATCHDOG_SCHEDULE_STARTED="$started" \
  WATCHDOG_SCHEDULE_SUCCESS="$success" \
  WATCHDOG_SCHEDULE_PAID_FALLBACK="$paid_fallback" \
  "$NODE_BIN" - "$LOG_FILE" <<'NODE'
'use strict';
const fs = require('node:fs');
const env = process.env;
const entry = {
  tick: Number(env.WATCHDOG_SCHEDULE_TICK),
  scheduledAt: env.WATCHDOG_SCHEDULE_STARTED_AT,
  finishedAt: new Date().toISOString(),
  decision: env.WATCHDOG_SCHEDULE_DECISION,
  exitCode: Number(env.WATCHDOG_SCHEDULE_EXIT_CODE),
  started: env.WATCHDOG_SCHEDULE_STARTED === 'true',
  success: env.WATCHDOG_SCHEDULE_SUCCESS === 'true',
  paidFallbackAttempted: env.WATCHDOG_SCHEDULE_PAID_FALLBACK === 'true',
};
fs.appendFileSync(process.argv[2], `${JSON.stringify(entry)}\n`);
NODE
  rm -f "$out_file"

  if [ "$decision" = 'RAN_ONCE' ] || [ "$decision" = 'ALLOW_ONCE' ]; then
    stop_reason='BOUNDED_EXECUTION_COMPLETED'
    break
  fi
  if [ "$decision" = 'UNKNOWN' ]; then
    stop_reason='INVALID_WATCHDOG_RESULT'
    break
  fi
  if [ "$tick" -lt "$TICKS" ]; then
    sleep "$INTERVAL"
  fi
done

"$NODE_BIN" - "$ROOT" "$LOG_FILE" "$executed" "$last_decision" "$stop_reason" "$first_started_at" <<'NODE'
'use strict';
const fs = require('node:fs');
const [root, logFile, executed, decision, stopReason, firstStartedAt] = process.argv.slice(2);
const script = `${root}/scripts/controller-watchdog.sh`;
let lastEntry = null;
try {
  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);
  lastEntry = JSON.parse(lines[lines.length - 1]);
} catch { /* no log yet */ }
const summary = {
  tool: 'controller-watchdog-scheduler',
  scriptPresent: fs.existsSync(script),
  executedTicks: Number(executed),
  firstScheduledAt: firstStartedAt || null,
  lastDecision: decision || null,
  stopReason,
  lastEntry,
  paidFallbackAttempted: lastEntry?.paidFallbackAttempted === true,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
NODE

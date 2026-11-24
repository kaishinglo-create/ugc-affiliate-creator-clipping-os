#!/usr/bin/env bash
# Thin watchdog: owns no controller state; only launches and restarts the .mjs controller.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL="$ROOT/docs/completion/controller"
STOP="$CONTROL/STOP"
LEGACY_STOP="$ROOT/docs/completion/CONTROLLER_STOP_REQUESTED"
LOCK="$CONTROL/supervisor.lock"
MAX_BACKOFF=300
backoff=5
intentional=0
mkdir -p "$CONTROL"
exec 9>"$LOCK" || exit 1
flock -n 9 || exit 75
stop_requested() { [ -f "$STOP" ] || [ -f "$LEGACY_STOP" ]; }
trap 'intentional=1' TERM INT
while [ "$intentional" -eq 0 ] && ! stop_requested; do
  setsid node "$ROOT/scripts/autonomous-controller.mjs" &
  CPID=$!
  STARTED=$(date +%s)
  wait "$CPID"
  rc=$?
  CPID=""
  if [ "$intentional" -eq 1 ] || stop_requested; then exit 0; fi
  case "$rc" in
    0|75|78) exit "$rc" ;;
  esac
  NOW=$(date +%s)
  if [ $((NOW - STARTED)) -ge 600 ]; then backoff=5; else backoff=$((backoff * 2)); fi
  [ "$backoff" -gt "$MAX_BACKOFF" ] && backoff=$MAX_BACKOFF
  DEADLINE=$(( $(date +%s) + backoff ))
  while [ $(date +%s) -lt "$DEADLINE" ]; do
    if [ "$intentional" -eq 1 ] || stop_requested; then exit 0; fi
    sleep 1
  done
done
exit 0

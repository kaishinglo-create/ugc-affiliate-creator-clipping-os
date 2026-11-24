#!/usr/bin/env bash
set -u
ROOT="/home/kaishinglo/ugc-affiliate-creator-clipping-os"
STATE="$ROOT/docs/completion/AUTONOMOUS_STATE.json"
LOG="$ROOT/docs/completion/autonomous-controller.log"
STOPFLAG="$ROOT/docs/completion/CONTROLLER_STOP_REQUESTED"
CONTROLLER="$ROOT/scripts/autonomous-controller.sh"
MAX_BACKOFF=300
backoff=5
intentional=0

trap 'intentional=1; echo "[$(date -Is)] supervisor stop requested" >> "$LOG"; touch "$STOPFLAG"; if [ -n "${CPID:-}" ]; then kill "$CPID" 2>/dev/null; fi; exit 0' TERM INT

if [ -f "$STOPFLAG" ]; then
  echo "[$(date -Is)] stop flag present, supervisor exiting" >> "$LOG"
  exit 0
fi

rm -f "$STOPFLAG"

while true; do
  if [ -f "$STOPFLAG" ]; then
    echo "[$(date -Is)] stop flag present, supervisor exiting" >> "$LOG"
    exit 0
  fi
  echo "[$(date -Is)] supervisor starting controller" >> "$LOG"
  bash "$CONTROLLER" &
  CPID=$!
  wait "$CPID"
  rc=$?
  unset CPID
  if [ "$intentional" -eq 1 ] || [ -f "$STOPFLAG" ]; then
    echo "[$(date -Is)] intentional stop, not restarting" >> "$LOG"
    exit 0
  fi
  echo "[$(date -Is)] controller exited rc=$rc, restarting in ${backoff}s" >> "$LOG"
  node -e 'const fs=require("fs");const p=process.argv[1];let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"));}catch{};s.status="recovering";s.lastExitCode=process.argv[2];fs.writeFileSync(p,JSON.stringify(s,null,2));' "$STATE" "$rc"
  sleep "$backoff"
  backoff=$(( backoff*2 ))
  [ "$backoff" -gt "$MAX_BACKOFF" ] && backoff=$MAX_BACKOFF
done
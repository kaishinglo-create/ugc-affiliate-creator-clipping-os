#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"
MAX_LOOPS="${MAX_LOOPS:-10}"
MODEL="${OPENCODE_MODEL:-}"
PROMPT_FILE="${MASTER_PROMPT_FILE:-$PROJECT_DIR/MASTER_PROMPT.md}"
STATE_FILE="$PROJECT_DIR/docs/autonomous-build/STATE.md"
LOG_DIR="$PROJECT_DIR/logs/autobuild"

if ! command -v opencode >/dev/null 2>&1; then echo "ERROR: OpenCode CLI is not installed or not on PATH."; exit 127; fi
if [[ ! -f "$PROMPT_FILE" || ! -f "$STATE_FILE" ]]; then echo "ERROR: Master prompt or build state file is missing."; exit 2; fi
if ! [[ "$MAX_LOOPS" =~ ^[1-9][0-9]*$ ]]; then echo "ERROR: MAX_LOOPS must be a positive integer."; exit 2; fi
if [[ -z "$MODEL" ]]; then echo "ERROR: Set OPENCODE_MODEL to an exact ID shown by opencode models."; echo "No default model is selected to prevent unintended paid-model fallback."; exit 2; fi
mkdir -p "$LOG_DIR"
echo "UGC OS autonomous build loop | model=$MODEL | max loops=$MAX_LOOPS"
echo "Safety: no publishing, outreach, or spending is authorized by this script."

for ((i=1; i<=MAX_LOOPS; i++)); do
  echo
  echo "========== LOOP $i / $MAX_LOOPS =========="
  log_file="$LOG_DIR/loop-$i.log"
  prompt="$(cat "$PROMPT_FILE")"$'\n\n'"Autonomous iteration $i of $MAX_LOOPS. Read repository state, implement one highest-priority tested improvement, update build state files, and report actual results. Never claim unverified success. If status is BLOCKED or COMPLETE, explain and stop."
  set +e
  opencode run --model "$MODEL" "$prompt" 2>&1 | tee "$log_file"
  command_status=${PIPESTATUS[0]}
  set -e
  if (( command_status != 0 )); then echo "OpenCode exited with status $command_status. Stopping."; exit "$command_status"; fi
  if grep -Eq '^\*\*Status:\*\* (BLOCKED|COMPLETE)' "$STATE_FILE"; then echo "Build state is BLOCKED or COMPLETE. Stopping."; exit 0; fi
done
echo "Loop budget exhausted. Review $STATE_FILE and $LOG_DIR before continuing."

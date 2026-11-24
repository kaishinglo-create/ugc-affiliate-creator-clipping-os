#!/usr/bin/env bash
set -u
ROOT="/home/kaishinglo/ugc-affiliate-creator-clipping-os"
STATE="$ROOT/docs/completion/AUTONOMOUS_STATE.json"
LOG="$ROOT/docs/completion/autonomous-controller.log"
TASKS="$ROOT/docs/completion/TASK_QUEUE.txt"
LOCK="$ROOT/docs/completion/controller.lock"
HEARTBEAT="$ROOT/docs/completion/heartbeat.txt"
COMPLETED="$ROOT/docs/completion/COMPLETED_TASKS.txt"
FAILED="$ROOT/docs/completion/FAILED_TASKS.txt"
BLOCKERS="$ROOT/docs/completion/EXTERNAL_BLOCKERS.txt"
DISCOVERED="$ROOT/docs/completion/DISCOVERED_TASKS.txt"
MODELS_STATE="$ROOT/docs/completion/model_cooldowns.txt"
FEATURES="$ROOT/docs/completion/FEATURE_MATRIX.json"
MAX_REPAIRS=3
AUDIT_EMPTY_LIMIT=3
LOW_MEM_MB=256
LOW_DISK_MB=512

mkdir -p "$ROOT/docs/completion" /tmp/opencode

# ---- lock with stale recovery ----
acquire_lock() {
  if [ -f "$LOCK" ]; then
    OLD=$(cat "$LOCK" 2>/dev/null || true)
    if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
      echo "[$(date -Is)] controller already running (PID $OLD)" >> "$LOG"
      exit 1
    else
      echo "[$(date -Is)] stale lock removed (PID $OLD)" >> "$LOG"
      rm -f "$LOCK"
    fi
  fi
  echo $$ > "$LOCK"
}
acquire_lock
trap 'rm -f "$LOCK"; node -e "const fs=require(\"fs\");const p=process.argv[1];let s={};try{s=JSON.parse(fs.readFileSync(p,\"utf8\"));}catch{};s.status=\"stopped\";s.stoppedAt=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(s,null,2));" "$STATE"' TERM INT EXIT

echo "[$(date -Is)] controller start (PID $$)" >> "$LOG"

# init files
[ -f "$STATE" ] || cat > "$STATE" <<'JSON'
{"status":"running","currentTask":null,"currentTaskId":null,"startedAt":null,"completed":[],"failed":[],"externalBlockers":[],"lastSuccessfulTest":null,"lastCheckpoint":null,"activeProvider":null,"ramUsage":null,"taskProgress":0,"completedCount":0,"failedCount":0,"uptimeSeconds":0}
JSON
[ -f "$TASKS" ] || : > "$TASKS"
[ -f "$COMPLETED" ] || : > "$COMPLETED"
[ -f "$FAILED" ] || : > "$FAILED"
[ -f "$BLOCKERS" ] || : > "$BLOCKERS"
[ -f "$MODELS_STATE" ] || : > "$MODELS_STATE"

# set startedAt if missing
node -e '
const fs=require("fs");
const p=process.argv[1];
let s={};
try{s=JSON.parse(fs.readFileSync(p,"utf8"));}catch{}
if(!s.startedAt) s.startedAt=new Date().toISOString();
fs.writeFileSync(p,JSON.stringify(s,null,2));
' "$STATE"

FREE_MODELS=(
  "opencode/deepseek-v4.1-flash-free"
  "opencode/nemotron-3.5-super-vl-free"
  "opencode/nemotron-3.5-lightning-free"
  "opencode/mimo-v2.6-flash-free"
  "opencode/hy4-flash-free"
  "opencode/iceman-free"
  "opencode/tidepool-alpha-free"
  "opencode/flint-40b-free"
  "opencode/big-pickle"
)

heartbeat() { date -Is > "$HEARTBEAT"; }

task_id() { printf '%s' "$1" | sha256sum | cut -c1-12; }

is_completed() {
  local id="$1"
  grep -q "^$id|" "$COMPLETED" 2>/dev/null
}

is_external_blocker() {
  echo "$1" | grep -qiE 'OLLAMA_API_KEY|DISCOVERY_MCP_CLIENT|MECE_DASHBOARD_TOKEN|credentials|blocked|external'
}

model_cooldown_active() {
  local m="$1" now; now=$(date +%s)
  if grep -q "^$m " "$MODELS_STATE" 2>/dev/null; then
    local until; until=$(grep "^$m " "$MODELS_STATE" | awk '{print $2}')
    [ "$now" -lt "$until" ] && return 0
  fi
  return 1
}

set_cooldown() {
  local m="$1" mins="${2:-10}" until=$(( $(date +%s) + mins*60 ))
  grep -v "^$m " "$MODELS_STATE" > "$MODELS_STATE.tmp" 2>/dev/null || true
  echo "$m $until" >> "$MODELS_STATE.tmp"
  mv "$MODELS_STATE.tmp" "$MODELS_STATE"
}

pick_model() {
  for m in "${FREE_MODELS[@]}"; do
    if ! model_cooldown_active "$m"; then echo "$m"; return 0; fi
  done
  sort -k2 -n "$MODELS_STATE" | head -1 | awk '{print $1}'
}

normalize_queue() {
  # convert plain lines to ID|task if needed
  local tmp="$TASKS.tmp"; : > "$tmp"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if echo "$line" | grep -q '|'; then
      echo "$line" >> "$tmp"
    else
      echo "$(task_id "$line")|$line" >> "$tmp"
    fi
  done < "$TASKS"
  mv "$tmp" "$TASKS"
  sort -u "$TASKS" -o "$TASKS"
}

run_opencode() {
  local task="$1" model="$2"
  cd "$ROOT"
  timeout -k 10 580 /home/kaishinglo/.opencode/bin/opencode run --auto --standalone \
    --model "$model" \
    "Task: $task. Work in $ROOT. Make minimal, verifiable changes. Run typecheck and lint. Do not commit. Do not modify generated files." \
    >> "$LOG" 2>&1
  echo $?
}

verify() {
  cd "$ROOT"
  # revert generated files if changed
  git checkout -- src/generated 2>/dev/null || true
  node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json >> "$LOG" 2>&1 || return 1
  node node_modules/eslint/bin/eslint.js . >> "$LOG" 2>&1 || return 1
  # full test suite
  node node_modules/vitest/vitest.mjs run >> "$LOG" 2>&1 || return 1
  return 0
}

git_checkpoint() {
  cd "$ROOT"
  # safety: no secrets in diff
  if git diff 2>/dev/null | grep -qiE 'API_KEY|SECRET|TOKEN|PASSWORD' ; then
    echo "[$(date -Is)] checkpoint skipped: possible secret in diff" >> "$LOG"; return 1
  fi
  # only if there are changes
  if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    return 0
  fi
  # preserve user changes: if HEAD has uncommitted baseline? We'll commit all current changes.
  git add -A 2>/dev/null
  if git diff --cached --quiet; then return 0; fi
  git commit -m "controller checkpoint: $1" --no-verify >> "$LOG" 2>&1 && echo "[$(date -Is)] checkpoint created" >> "$LOG"
}

discover_tasks() {
  : > "$DISCOVERED"
  # TODO/FIXME etc in src/public excluding generated
  grep -RInE 'TODO|FIXME|HACK|STUB|MOCK|PLACEHOLDER|NOT IMPLEMENTED' "$ROOT/src" "$ROOT/public" 2>/dev/null \
    | grep -vE '/generated/|node_modules' | head -40 | sed 's/^/Audit: /' >> "$DISCOVERED" || true

  # feature matrix incomplete
  if [ -f "$FEATURES" ]; then
    node -e '
      const fs=require("fs");
      const f=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      for(const x of f.features){
        if(x.status!=="complete"){
          console.log("Complete feature: "+x.name+" ("+x.status+") - criteria: "+x.criteria.join("; "));
        }
      }
    ' "$FEATURES" >> "$DISCOVERED" 2>/dev/null || true
  fi

  # roadmap next items from allowed docs only
  for f in "$ROOT/docs/autonomous-build"/*.md "$ROOT/docs/completion/FEATURE_MATRIX.md"; do
    [ -f "$f" ] || continue
    grep -iE 'Next:|Next step' "$f" 2>/dev/null | head -10 | sed 's/^/Roadmap: /' >> "$DISCOVERED" || true
  done

  # route external blockers
  : > "$DISCOVERED.tmp"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if is_external_blocker "$line"; then
      echo "$line" >> "$BLOCKERS"
    else
      echo "$line" >> "$DISCOVERED.tmp"
    fi
  done < "$DISCOVERED"
  mv "$DISCOVERED.tmp" "$DISCOVERED"

  # add IDs and dedup against completed
  if [ -s "$DISCOVERED" ]; then
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      id=$(task_id "$line")
      if is_completed "$id"; then continue; fi
      # check if already in queue
      if ! grep -q "^$id|" "$TASKS"; then
        echo "$id|$line" >> "$TASKS"
      fi
    done < "$DISCOVERED"
    sort -u "$TASKS" -o "$TASKS"
  fi
}

resource_ok() {
  local mem; mem=$(free -m 2>/dev/null | awk '/^Mem:/{print $7}')
  if [ -n "$mem" ] && [ "$mem" -lt "$LOW_MEM_MB" ]; then return 1; fi
  local disk; disk=$(df -m "$ROOT" 2>/dev/null | awk 'NR==2{print $4}')
  if [ -n "$disk" ] && [ "$disk" -lt "$LOW_DISK_MB" ]; then return 1; fi
  return 0
}

update_state() {
  # args: key value ...
  node - "$STATE" "$@" <<'NODE'
const fs=require('fs');
const p=process.argv[1];
let s={};
try{s=JSON.parse(fs.readFileSync(p,'utf8'));}catch{}
for(let i=2;i<process.argv.length;i+=2){
  const k=process.argv[i]; let v=process.argv[i+1];
  try{v=JSON.parse(v);}catch{}
  s[k]=v;
}
s.uptimeSeconds=Math.floor((Date.now()-new Date(s.startedAt).getTime())/1000);
fs.writeFileSync(p,JSON.stringify(s,null,2));
NODE
}

audit_empty_count=0
while true; do
  heartbeat
  if ! resource_ok; then
    echo "[$(date -Is)] resource low, pausing 300s" >> "$LOG"
    sleep 300; continue
  fi

  if [ ! -f "$LOCK" ] || [ "$(cat "$LOCK")" != "$$" ]; then
    echo "[$(date -Is)] lock lost, exiting" >> "$LOG"; exit 1
  fi

  normalize_queue
  # route external blockers out of queue
  if [ -s "$TASKS" ]; then
    : > "$TASKS.tmp"
    while IFS= read -r line; do
      t="${line#*|}"
      if is_external_blocker "$t"; then
        echo "$line" >> "$BLOCKERS"
      else
        echo "$line" >> "$TASKS.tmp"
      fi
    done < "$TASKS"
    mv "$TASKS.tmp" "$TASKS"
  fi
  sed -i '/^[[:space:]]*$/d' "$TASKS"

  if [ ! -s "$TASKS" ]; then
    echo "[$(date -Is)] queue empty, running audit discovery" >> "$LOG"
    before=$(wc -l < "$TASKS")
    discover_tasks
    after=$(wc -l < "$TASKS")
    if [ "$after" -le "$before" ]; then
      audit_empty_count=$((audit_empty_count+1))
    else
      audit_empty_count=0
    fi
    if [ ! -s "$TASKS" ]; then
      if [ "$audit_empty_count" -ge "$AUDIT_EMPTY_LIMIT" ]; then
        echo "[$(date -Is)] no executable tasks after repeated audits; pausing 600s" >> "$LOG"
        update_state status "paused"
        sleep 600
        audit_empty_count=0
        update_state status "running"
        continue
      fi
      echo "[$(date -Is)] no new tasks, pausing 60s" >> "$LOG"
      sleep 60
      continue
    fi
  fi

  line=$(head -n1 "$TASKS")
  sed -i '1d' "$TASKS"
  id="${line%%|*}"
  task="${line#*|}"
  [ -z "$id" ] && id=$(task_id "$task")

  echo "[$(date -Is)] starting task: $task (id=$id)" >> "$LOG"
  update_state currentTask "$task" currentTaskId "$id" status "running"

  model=$(pick_model)
  update_state activeProvider "$model"
  baseline_status=$(cd "$ROOT" && git status --porcelain | sha256sum | cut -d' ' -f1)

  repairs=0; success=0
  while [ $repairs -lt $MAX_REPAIRS ]; do
    rc=$(run_opencode "$task" "$model")
    echo "[$(date -Is)] opencode rc=$rc model=$model (repair $repairs)" >> "$LOG"
    if tail -3 "$LOG" | grep -qiE 'rate.?limit|429|quota|provider.*fail|unavailable'; then
      echo "[$(date -Is)] rate limit/provider issue on $model, cooldown 15m" >> "$LOG"
      set_cooldown "$model" 15
      model=$(pick_model)
      update_state activeProvider "$model"
    fi
    if verify; then
      echo "[$(date -Is)] VERIFY OK: $task" >> "$LOG"
      success=1
      break
    fi
    repairs=$((repairs+1))
    echo "[$(date -Is)] repair attempt $repairs for: $task" >> "$LOG"
  done

  if [ $success -eq 1 ]; then
    echo "$id|$task" >> "$COMPLETED"
    # update feature matrix status if applicable
    git_checkpoint "$task"
    lastcp=$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || echo "none")
    ram=$(free -m | awk '/^Mem:/{print $3"/"$2"MB"}')
    update_state status "running" currentTask "null" currentTaskId "null" lastSuccessfulTest "full-suite" lastCheckpoint "$lastcp" ramUsage "$ram" completedCount "$(wc -l < $COMPLETED)" failedCount "$(wc -l < $FAILED)"
  else
    echo "$id|$task" >> "$FAILED"
    set_cooldown "$model" 10
    update_state status "running" currentTask "null" currentTaskId "null" failedCount "$(wc -l < $FAILED)"
  fi

  heartbeat
done
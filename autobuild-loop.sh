#!/usr/bin/env bash
set -uo pipefail

PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"
PROMPT_FILE="${PROMPT_FILE:-$PROJECT_DIR/MASTER_PROMPT.md}"
MODEL="${OPENCODE_MODEL:-}"
MAX_LOOPS="${MAX_LOOPS:-200}"
SLEEP_SECONDS="${SLEEP_SECONDS:-3}"

STATE_DIR="$PROJECT_DIR/docs/autonomous-build"
LOG_DIR="$STATE_DIR/logs"

mkdir -p "$LOG_DIR"

if ! command -v opencode >/dev/null 2>&1; then
  echo "FEHLER: OpenCode CLI wurde nicht gefunden."
  exit 1
fi

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "FEHLER: Masterprompt fehlt: $PROMPT_FILE"
  exit 1
fi

if [[ -z "$MODEL" ]]; then
  echo "Setze OPENCODE_MODEL auf den exakten provider/model-Namen von Beam Free."
  echo "Verfügbare Modelle prüfen mit: opencode models"
  exit 1
fi

if ! [[ "$MAX_LOOPS" =~ ^[1-9][0-9]*$ ]]; then
  echo "FEHLER: MAX_LOOPS muss eine positive ganze Zahl sein."
  exit 1
fi

for ((i=1; i<=MAX_LOOPS; i++)); do
  TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
  LOG_FILE="$LOG_DIR/loop-${i}-${TIMESTAMP}.log"
  PROMPT="$(cat "$PROMPT_FILE")"

  PROMPT+=$'\n\n'
  PROMPT+="LOOP_NUMMER: $i von $MAX_LOOPS"$'\n'
  PROMPT+="Lies docs/autonomous-build/STATE.md, ACCEPTANCE.md und DECISIONS.md, falls vorhanden."$'\n'
  PROMPT+="Setze die nächste offene Aufgabe um. Führe echte Tests aus und aktualisiere die Fortschrittsdateien."$'\n'
  PROMPT+="Gib am Ende exakt LOOP_STATUS: CONTINUE, LOOP_STATUS: BLOCKED oder LOOP_STATUS: COMPLETE aus."$'\n'
  PROMPT+="Wenn ein externer Zugang fehlt, markiere BLOCKED und erkläre die Voraussetzung. Wiederhole nicht endlos denselben Fehler."$'\n'

  echo "=== OpenCode Loop $i/$MAX_LOOPS ==="
  echo "Modell: $MODEL"
  echo "Projekt: $PROJECT_DIR"
  echo "Log: $LOG_FILE"

  if ! opencode run \
      --dir "$PROJECT_DIR" \
      --model "$MODEL" \
      "$PROMPT" 2>&1 | tee "$LOG_FILE"; then
    PIPE_STATUS=${PIPESTATUS[0]:-1}
    echo "OpenCode-Aufruf fehlgeschlagen (Status $PIPE_STATUS)." | tee -a "$LOG_FILE"
    echo "Loop gestoppt. Prüfe Modellzugang und Log."
    exit 2
  fi

  if grep -q '^LOOP_STATUS: COMPLETE' "$LOG_FILE"; then
    echo "COMPLETE gemeldet. Prüfe die Abschlussnachweise manuell, bevor du den Stand als produktionsbereit einstufst."
    exit 0
  fi

  if grep -q '^LOOP_STATUS: BLOCKED' "$LOG_FILE"; then
    echo "BLOCKED gemeldet. Loop gestoppt, um Wiederholungen ohne Fortschritt zu vermeiden."
    exit 3
  fi

  sleep "$SLEEP_SECONDS"
done

echo "Maximale Anzahl an Loops erreicht: $MAX_LOOPS"
echo "Das Projekt ist NICHT automatisch als fertig bestätigt."
exit 4

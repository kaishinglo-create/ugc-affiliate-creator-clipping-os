#!/usr/bin/env bash
# Unified local service control for UGC OS.
# Usage: scripts/services.sh {start|stop|status|restart} [ugc|control|browser|all]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDDIR="/tmp/opencode/ugc-services"
mkdir -p "$PIDDIR" "$ROOT/.run"

ACTION="${1:-status}"
TARGET="${2:-all}"

log() { printf '[services] %s\n' "$*"; }

port_pid() {
  ss -ltnp 2>/dev/null | awk -v p=":$1" '$4 ~ p"$" { if (match($0, /pid=[0-9]+/)) { print substr($0, RSTART+4, RLENGTH-4); exit } }'
}

pid_file() { printf '%s/%s.pid' "$PIDDIR" "$1"; }

pid_alive() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

stop_tree() {
  local pid="$1"
  local child
  for child in $(ps -o pid= --ppid "$pid" 2>/dev/null); do stop_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}

service_pid() {
  local name="$1" port="$2" file
  file="$(pid_file "$name")"
  if [ -f "$file" ] && pid_alive "$(cat "$file")"; then cat "$file"; return 0; fi
  local found
  found="$(port_pid "$port")"
  if [ -n "$found" ]; then printf '%s' "$found"; return 0; fi
  return 1
}

start_service() {
  local name="$1"
  case "$name" in
    ugc)
      if service_pid ugc 3000 >/dev/null; then log "ugc already listening on :3000"; return 0; fi
      cd "$ROOT" || return 1
      nohup node node_modules/tsx/dist/cli.mjs watch src/index.ts >>"$ROOT/.run/dev.log" 2>&1 &
      echo $! >"$(pid_file ugc)"
      ;;
    control)
      if service_pid control 3031 >/dev/null; then log "control already listening on :3031"; return 0; fi
      cd "$ROOT" || return 1
      nohup node --env-file=.env .mece-control/server.mjs >>"$ROOT/.mece-control/server.log" 2>&1 &
      echo $! >"$(pid_file control)"
      ;;
    browser)
      if service_pid browser 3200 >/dev/null; then log "browser already listening on :3200"; return 0; fi
      cd "$ROOT/browser-runtime-host" || return 1
      nohup node --env-file=../.env server.mjs >>"$ROOT/.run/browser-host.log" 2>&1 &
      echo $! >"$(pid_file browser)"
      ;;
    *) log "unknown service: $name"; return 2 ;;
  esac
}

stop_service() {
  local name="$1" pid=""
  if pid="$(service_pid "$name" "${2:-0}")"; then
    stop_tree "$pid"
    rm -f "$(pid_file "$name")"
    log "$name stop signaled (pid $pid)"
  else
    log "$name not running"
  fi
}

status_service() {
  local name="$1" port="$2" url="$3" pid="none" code="000"
  pid="$(service_pid "$name" "$port" 2>/dev/null || true)"
  [ -n "$pid" ] || pid="none"
  if [ -n "$url" ]; then code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)"; fi
  printf '%-8s port=%-5s pid=%-8s http=%s\n' "$name" "$port" "$pid" "$code"
}

case "$ACTION" in
  start|restart)
    if [ "$ACTION" = restart ]; then
      for svc in ugc control browser; do
        [ "$TARGET" = all ] || [ "$TARGET" = "$svc" ] || continue
        case "$svc" in ugc) p=3000;; control) p=3031;; browser) p=3200;; esac
        stop_service "$svc" "$p"
      done
      sleep 2
    fi
    for svc in ugc control browser; do
      [ "$TARGET" = all ] || [ "$TARGET" = "$svc" ] || continue
      start_service "$svc"
    done
    ;;
  stop)
    for svc in ugc control browser; do
      [ "$TARGET" = all ] || [ "$TARGET" = "$svc" ] || continue
      case "$svc" in ugc) p=3000;; control) p=3031;; browser) p=3200;; esac
      stop_service "$svc" "$p"
    done
    ;;
  status)
    status_service ugc 3000 http://127.0.0.1:3000/health
    status_service control 3031 http://127.0.0.1:3031/
    status_service browser 3200 http://127.0.0.1:3200/status
    ;;
  *) log "usage: $0 {start|stop|status|restart} [ugc|control|browser|all]"; exit 2 ;;
esac

#!/usr/bin/env bash
# Unified local service control for UGC OS.
# Usage: scripts/services.sh {start|stop|status|restart|doctor} [ugc|control|browser|all]
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

doctor() {
  # Machine-readable readiness report on stdout only. Never print config values:
  # MECE token is reduced to a boolean and DATABASE_URL is parsed without output.
  node - "$ROOT" <<'NODE'
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.argv[2] || process.cwd();
const TIMEOUT = Number(process.env.SERVICES_DOCTOR_TIMEOUT_MS) > 0
  ? Number(process.env.SERVICES_DOCTOR_TIMEOUT_MS)
  : 2000;

function readDotenv(file) {
  const values = {};
  if (!file || file === 'none') return values;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[match[1]] = value;
    }
  } catch { /* optional file */ }
  return values;
}

const dotenv = readDotenv(process.env.SERVICES_DOTENV_FILE ?? path.join(ROOT, '.env'));
function config(name) {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : dotenv[name];
}

function tcpReachable(host, port, timeout = TIMEOUT) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function httpStatus(url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = http.get(url, (res) => { res.resume(); finish(res.statusCode ?? null); });
    req.setTimeout(TIMEOUT, () => { req.destroy(); finish(null); });
    req.once('error', () => finish(null));
  });
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value <= 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    if (/^\d+(\.\d+)?$/.test(value.trim())) {
      const numeric = Number(value);
      return numeric <= 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function activeCooldowns(status, now) {
  const entries = [];
  for (const group of ['models', 'providers']) {
    const source = status?.cooldowns?.[group];
    if (!source || typeof source !== 'object') continue;
    for (const [id, raw] of Object.entries(source)) {
      const value = raw && typeof raw === 'object' ? (raw.untilMs ?? raw.until ?? raw.expiresAt) : raw;
      const until = toMs(value);
      if (until !== null && until > now) {
        entries.push({ id, untilMs: until, reason: raw && typeof raw === 'object' ? raw.reason ?? null : null });
      }
    }
  }
  return entries;
}

function readControllerStatus() {
  const override = process.env.CONTROLLER_STATUS_FILE;
  if (override && override !== 'none') return JSON.parse(fs.readFileSync(override, 'utf8'));
  const result = spawnSync(process.execPath, ['scripts/autonomous-controller.mjs', '--status'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('controller status command failed');
  return JSON.parse(result.stdout);
}

async function checkPorts() {
  if (process.env.SERVICES_DOCTOR_PORTS === 'skip') {
    return { healthy: true, status: 'SKIPPED', services: [] };
  }
  const definitions = [
    { name: 'ugc', port: 3000, url: 'http://127.0.0.1:3000/health' },
    { name: 'control', port: 3031, url: 'http://127.0.0.1:3031/' },
    { name: 'browser', port: 3200, url: 'http://127.0.0.1:3200/status' },
  ];
  const services = await Promise.all(definitions.map(async ({ name, port, url }) => {
    const listening = await tcpReachable('127.0.0.1', port);
    const httpCode = listening ? await httpStatus(url) : null;
    const healthy = listening && httpCode !== null && httpCode >= 200 && httpCode < 400;
    return {
      name,
      port,
      listening,
      httpStatus: httpCode,
      healthy,
      status: healthy ? 'OK' : listening ? 'HTTP_ERROR' : 'UNREACHABLE',
    };
  }));
  return {
    healthy: services.every((service) => service.healthy),
    status: services.every((service) => service.healthy) ? 'OK' : 'UNAVAILABLE',
    services,
  };
}

function checkController() {
  try {
    const status = readControllerStatus();
    const now = Date.now();
    const resumeAt = toMs(status.resumeAt ?? null);
    const cooldowns = activeCooldowns(status, now);
    const globalCooldown = cooldowns.some((entry) => entry.reason === 'GLOBAL_FREE_QUOTA');
    const cooldownActive = cooldowns.length > 0 || (resumeAt !== null && resumeAt > now);
    const stopped = status.status === 'stopped';
    const note = !stopped ? 'OK' : cooldownActive ? 'COOLDOWN_ACTIVE' : 'STOPPED';
    const heartbeat = status.heartbeatAgeSeconds;
    return {
      healthy: note !== 'STOPPED',
      status: typeof status.status === 'string' ? status.status : 'UNKNOWN',
      pauseReason: typeof status.pauseReason === 'string' && status.pauseReason ? status.pauseReason : null,
      resumeAt: status.resumeAt ?? null,
      heartbeatAgeSeconds: Number.isFinite(heartbeat) ? heartbeat : null,
      queueDepth: Number.isFinite(status.queueDepth) ? status.queueDepth : 0,
      resourcesOk: status.resources?.ok === true,
      cooldownActive,
      globalCooldownActive: globalCooldown,
      note,
    };
  } catch {
    return {
      healthy: false,
      status: 'UNKNOWN',
      pauseReason: null,
      resumeAt: null,
      heartbeatAgeSeconds: null,
      queueDepth: 0,
      resourcesOk: false,
      cooldownActive: false,
      globalCooldownActive: false,
      note: 'STATUS_UNAVAILABLE',
    };
  }
}

function findBinary(candidates, executable) {
  const configured = candidates.find((value) => typeof value === 'string' && value.trim());
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      if (executable) fs.accessSync(candidate, fs.constants.X_OK);
      else {
        const stat = fs.statSync(candidate);
        if (!stat.isFile() || stat.size <= 0) continue;
      }
      return {
        configured: Boolean(configured),
        available: true,
        path: candidate,
        status: 'OK',
      };
    } catch { /* try next candidate */ }
  }
  return {
    configured: Boolean(configured),
    available: false,
    path: null,
    status: configured ? 'UNAVAILABLE' : 'NOT_CONFIGURED',
  };
}

function checkMedia() {
  const ffmpeg = findBinary([config('FFMPEG_BIN'), '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/data/data/com.termux/files/usr/bin/ffmpeg'], true);
  const ffprobe = findBinary([config('FFPROBE_BIN'), '/usr/bin/ffprobe', '/usr/local/bin/ffprobe', '/data/data/com.termux/files/usr/bin/ffprobe'], true);
  const whisperBinary = findBinary([
    config('WHISPER_BIN'),
    '/tmp/opencode/whisper.cpp/build/bin/whisper-cli',
    '/tmp/opencode/whisper.cpp/build/bin/main',
    '/usr/local/bin/whisper-cli',
  ], true);
  const whisperModel = findBinary([
    config('WHISPER_MODEL'),
    '/tmp/opencode/whisper.cpp/models/ggml-tiny.en.bin',
    '/tmp/opencode/whisper.cpp/models/ggml-tiny.bin',
    '/tmp/opencode/whisper.cpp/models/ggml-base.en.bin',
    '/tmp/opencode/whisper.cpp/models/ggml-base.bin',
  ], false);
  const items = { ffmpeg, ffprobe, whisperBinary, whisperModel };
  return { healthy: Object.values(items).every((item) => item.available), ...items };
}

function checkMece() {
  // Only the presence boolean is reported; the value is never copied to JSON.
  const value = config('MECE_DASHBOARD_TOKEN');
  const tokenConfigured = typeof value === 'string' && value.trim().length > 0;
  return {
    healthy: tokenConfigured,
    tokenConfigured,
    status: tokenConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED',
  };
}

async function checkDatabase() {
  const raw = config('DATABASE_URL');
  const configured = typeof raw === 'string' && raw.trim().length > 0;
  if (!configured) return { healthy: true, configured: false, reachable: null, status: 'NOT_CONFIGURED' };
  if (process.env.SERVICES_DOCTOR_DB_CHECK === '0') {
    return { healthy: true, configured: true, reachable: null, status: 'SKIPPED' };
  }
  let parsed;
  try { parsed = new URL(raw); } catch {
    return { healthy: false, configured: true, reachable: null, status: 'INVALID_CONFIG' };
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol) || !parsed.hostname) {
    return { healthy: true, configured: true, reachable: null, status: 'SKIPPED' };
  }
  const reachable = await tcpReachable(parsed.hostname, parsed.port || 5432);
  return { healthy: reachable, configured: true, reachable, status: reachable ? 'OK' : 'UNREACHABLE' };
}

(async () => {
  const [ports, database] = await Promise.all([checkPorts(), checkDatabase()]);
  const controller = checkController();
  const media = checkMedia();
  const mece = checkMece();
  const healthy = ports.healthy && controller.healthy && media.healthy && mece.healthy && database.healthy;
  const report = {
    tool: 'services-doctor',
    generatedAt: new Date().toISOString(),
    healthy,
    exitCode: healthy ? 0 : 1,
    checks: { ports, controller, media, mece, database },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.exitCode);
})().catch(() => {
  process.stdout.write(`${JSON.stringify({
    tool: 'services-doctor',
    generatedAt: new Date().toISOString(),
    healthy: false,
    exitCode: 1,
    checks: { ports: { healthy: false, services: [] } },
    error: 'DOCTOR_FAILED',
  }, null, 2)}\n`);
  process.exit(1);
});
NODE
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
  doctor)
    doctor
    exit $?
    ;;
  *) log "usage: $0 {start|stop|status|restart|doctor} [ugc|control|browser|all]"; exit 2 ;;
esac

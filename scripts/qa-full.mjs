#!/usr/bin/env node
/**
 * Deterministic full-suite QA runner for local/free infrastructure.
 *
 * The caller is expected to hold an exclusive lock (see `npm run qa:full`,
 * which uses flock). This runner starts a temporary, local PostgreSQL cluster
 * with a non-superuser role, applies migrations there, watches a single-worker
 * Vitest process, and writes progress plus a full report to /tmp/opencode.
 *
 * No credential value is written to any output file.
 */
import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOW = new Date();
const RUN_ID = `qa-full-${NOW.toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const OUT_DIR = process.env.QA_FULL_OUT_DIR ?? join('/tmp/opencode', 'qa-full', RUN_ID);
const LATEST_PROGRESS = join('/tmp/opencode', 'qa-full', 'latest-progress.json');
const TIMEOUT_MS = positiveEnv('QA_FULL_TIMEOUT_MS', 15 * 60_000);
const STALL_MS = positiveEnv('QA_FULL_STALL_MS', 180_000);
const SAMPLE_MS = positiveEnv('QA_FULL_SAMPLE_MS', 2_000);
const TEST_ARGS = ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1'];
const QA_ROLE = 'ugc_os_app';
const QA_DB = 'ugc_os_qa';

const paths = {
  stdout: join(OUT_DIR, 'vitest.stdout.log'),
  stderr: join(OUT_DIR, 'vitest.stderr.log'),
  combined: join(OUT_DIR, 'vitest.log'),
  trace: join(OUT_DIR, 'qa-trace.jsonl'),
  progress: join(OUT_DIR, 'progress.json'),
  progressLog: join(OUT_DIR, 'progress.log'),
  migration: join(OUT_DIR, 'migrate.log'),
  postgres: join(OUT_DIR, 'postgres.log'),
  reportJson: join(OUT_DIR, 'report.json'),
  reportMd: join(OUT_DIR, 'report.md'),
};

const report = {
  runId: RUN_ID,
  startedAt: NOW.toISOString(),
  finishedAt: null,
  outcome: 'running',
  exitCode: null,
  exitSignal: null,
  workspaceRoot: ROOT,
  database: null,
  services: {},
  watchdog: { enabled: true, timeoutMs: TIMEOUT_MS, stallMs: STALL_MS, triggered: false, reason: null, signals: [] },
  resources: { samples: [], summary: null },
  tests: null,
  traceFile: paths.trace,
  recovery: null,
  errors: [],
};

let phase = 'init';
let vitestPid = null;
let lastLogAt = Date.now();
let pgBinDir = null;
let pgDataDir = null;

function positiveEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function logLine(message) {
  const line = `${new Date().toISOString()} [${phase}] ${message}`;
  appendFileSync(paths.progressLog, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

function progress(extra = {}) {
  const payload = {
    runId: RUN_ID,
    status: report.outcome,
    phase,
    startedAt: report.startedAt,
    updatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - NOW.getTime(),
    vitestPid,
    lastLogAt: new Date(lastLogAt).toISOString(),
    ...extra,
  };
  writeFileSync(paths.progress, `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(LATEST_PROGRESS, `${JSON.stringify(payload, null, 2)}\n`);
}

function safeText(value) {
  return String(value ?? '')
    .replace(/\r/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' | ')
    .slice(0, 500);
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options });
  return {
    status: result.status,
    stdout: safeText(result.stdout),
    stderr: safeText(result.stderr),
    error: result.error ? safeText(result.error.message) : null,
  };
}

function parseDatabaseUrl() {
  const raw = String(process.env.DATABASE_URL ?? '');
  if (!raw) throw new Error('DATABASE_URL missing');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL is not PostgreSQL');
  return { url, password: decodeURIComponent(url.password || '') };
}

function pgPath(name) {
  if (!pgBinDir) throw new Error('PostgreSQL bin directory unavailable');
  return join(pgBinDir, name);
}

function detectPgBin() {
  const detected = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  const dir = (detected.stdout ?? '').trim();
  if (detected.status !== 0 || !existsSync(join(dir, 'initdb')) || !existsSync(join(dir, 'pg_ctl'))) {
    throw new Error('PostgreSQL initdb/pg_ctl not available');
  }
  pgBinDir = dir;
  return dir;
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function psqlAdmin(args, sql, env) {
  return runSync(pgPath('psql'), [
    '-h', '127.0.0.1',
    '-p', args.port,
    '-U', 'qa_admin',
    '-d', 'postgres',
    '-w', '-v', 'ON_ERROR_STOP=1', '-Atq',
  ], { env, input: sql });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error('could not allocate QA port'))));
    });
  });
}

function recoverStaleClusters() {
  if (!pgBinDir) return;
  const root = join('/tmp/opencode', 'qa-full');
  if (!existsSync(root)) return;
  const stopped = [];
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith('qa-full-')) continue;
    const dataDir = join(root, entry, 'pgdata');
    const pidFile = join(dataDir, 'postmaster.pid');
    if (!existsSync(pidFile)) continue;
    const pid = Number(readFileSync(pidFile, 'utf8').split('\n')[0]);
    if (!Number.isInteger(pid) || !existsSync(`/proc/${pid}/cmdline`)) continue;
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    if (!cmdline.includes(dataDir)) continue;
    const result = runSync(pgPath('pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
    stopped.push({ dataDir, pid, status: result.status });
  }
  if (stopped.length) {
    report.recovery = { staleClustersStopped: stopped };
    logLine(`stopped ${stopped.length} stale QA cluster(s) from previous runs`);
  }
}

async function prepareDatabase() {
  detectPgBin();
  recoverStaleClusters();

  const base = parseDatabaseUrl();
  const password = base.password || randomUUID();
  const port = await freePort();
  const socketDir = join(OUT_DIR, 'pgsock');
  pgDataDir = join(OUT_DIR, 'pgdata');
  mkdirSync(socketDir, { recursive: true });

  const init = runSync(pgPath('initdb'), [
    '-D', pgDataDir,
    '-U', 'qa_admin',
    '--auth=trust',
    '--encoding=UTF8',
    '--locale=C',
    '--no-instructions',
  ]);
  if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr || init.error || init.status}`);

  const start = runSync(pgPath('pg_ctl'), [
    '-D', pgDataDir,
    '-l', paths.postgres,
    '-w',
    '-o', `-p ${port} -h 127.0.0.1 -k ${socketDir}`,
    'start',
  ]);
  if (start.status !== 0) throw new Error(`pg_ctl start failed: ${start.stderr || start.error || start.status}`);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await tcpReachable('127.0.0.1', port, 500)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!await tcpReachable('127.0.0.1', port, 500)) throw new Error('QA PostgreSQL did not become reachable');

  const setupSql = `
    CREATE ROLE ${QA_ROLE} LOGIN PASSWORD ${sqlLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    CREATE DATABASE ${QA_DB} OWNER ${QA_ROLE};
  `;
  const setup = psqlAdmin({ port }, setupSql, { ...process.env, PGPASSWORD: '' });
  if (setup.status !== 0) throw new Error(`QA role/database setup failed: ${setup.stderr || setup.status}`);

  const qaUrl = new URL('postgresql://');
  qaUrl.protocol = 'postgresql:';
  qaUrl.hostname = '127.0.0.1';
  qaUrl.port = String(port);
  qaUrl.username = QA_ROLE;
  qaUrl.password = password;
  qaUrl.pathname = `/${QA_DB}`;

  report.database = {
    mode: 'ephemeral-postgresql',
    host: '127.0.0.1',
    port,
    database: QA_DB,
    role: QA_ROLE,
    roleSuperuser: false,
    roleBypassRls: false,
    dataDir: pgDataDir,
    log: paths.postgres,
    migrated: false,
    tableCount: null,
  };
  logLine(`isolated PostgreSQL ${QA_DB} listening on 127.0.0.1:${port}`);

  const env = {
    ...process.env,
    DATABASE_URL: qaUrl.toString(),
    AUTOMATION_ENGINE: 'off',
    MECE_TEST_CONTROL_PORT: '3132',
    MECE_TEST_OPENCODE_PORT: '4098',
    QA_TRACE_FILE: process.env.QA_TRACE_FILE || paths.trace,
  };

  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: ROOT, env, encoding: 'utf8',
  });
  writeFileSync(paths.migration, `${migration.stdout ?? ''}${migration.stderr ?? ''}`);
  report.database.migrated = migration.status === 0;
  if (!report.database.migrated) {
    throw new Error(`migrate deploy failed: ${safeText(migration.stderr || migration.stdout || migration.status)}`);
  }

  const count = runSync(pgPath('psql'), [
    '-h', '127.0.0.1', '-p', String(port), '-U', QA_ROLE, '-d', QA_DB,
    '-w', '-v', 'ON_ERROR_STOP=1', '-Atq',
    '-c', "select count(*) from information_schema.tables where table_schema='public'",
  ], { env: { ...process.env, PGPASSWORD: password } });
  report.database.tableCount = Number(count.stdout.trim()) || 0;
  if (report.database.tableCount < 10) throw new Error('QA database migration produced too few tables');
  return env;
}

function httpReachable(rawUrl, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(rawUrl); } catch { resolve(false); return; }
    if (!['http:', 'https:'].includes(url.protocol)) { resolve(false); return; }
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, (response) => { response.resume(); resolve(true); });
    request.setTimeout(timeoutMs, () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

function tcpReachable(host, port, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function sampleResources(pid) {
  const raw = spawnSync('ps', ['-eo', 'pid=,ppid=,pcpu=,rss=,etimes=,args='], { encoding: 'utf8' }).stdout ?? '';
  const rows = raw.split('\n').filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) return null;
    return { pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]), rssKb: Number(match[4]), ageSec: Number(match[5]) };
  }).filter(Boolean);
  const own = new Set(pid ? [pid] : []);
  let changed = true;
  while (changed && pid) {
    changed = false;
    for (const row of rows) {
      if (own.has(row.ppid) && !own.has(row.pid)) { own.add(row.pid); changed = true; }
    }
  }
  const selected = rows.filter((row) => own.has(row.pid));
  return {
    at: new Date().toISOString(),
    processCount: selected.length,
    totalRssMb: Math.round(selected.reduce((sum, row) => sum + row.rssKb, 0) / 1024),
    maxRssMb: Math.round(Math.max(0, ...selected.map((row) => row.rssKb)) / 1024),
    maxCpuPct: Math.max(0, ...selected.map((row) => row.cpu)),
    maxAgeSec: Math.max(0, ...selected.map((row) => row.ageSec)),
    load1: Number(os.loadavg()[0].toFixed(2)),
    freeMemMb: Math.round(os.freemem() / 1024 / 1024),
  };
}

function parseVitestResult(log) {
  const testFiles = log.match(/Test Files\s+(.+)/)?.[1]?.trim() ?? null;
  const tests = log.match(/Tests\s+(.+)/)?.[1]?.trim() ?? null;
  const duration = log.match(/Duration\s+(.+)/)?.[1]?.trim() ?? null;
  const failures = log.split('\n').filter((line) => /^\s*FAIL\s/.test(line)).map((line) => line.trim()).slice(0, 20);
  return { testFiles, tests, duration, failures, tail: log.slice(-4_000) };
}

async function prepareServices() {
  const browserUrl = process.env.BROWSER_RUNTIME_URL ?? null;
  report.services.browser = { expected: Boolean(browserUrl), reachableBefore: false, startedByQa: false, reachableAfter: false };
  if (browserUrl) {
    report.services.browser.reachableBefore = await httpReachable(browserUrl);
    if (!report.services.browser.reachableBefore) {
      logLine('browser runtime unreachable; starting owned browser service');
      const started = runSync('bash', ['scripts/services.sh', 'start', 'browser']);
      report.services.browser.startedByQa = started.status === 0;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (await httpReachable(browserUrl)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    report.services.browser.reachableAfter = await httpReachable(browserUrl);
    if (!report.services.browser.reachableAfter) throw new Error('BROWSER_RUNTIME_URL unreachable after service check');
  }

  const ugcRunning = await tcpReachable('127.0.0.1', 3000);
  const controlRunning = await tcpReachable('127.0.0.1', 3031);
  report.services.ugc = { port: 3000, runningBefore: ugcRunning, action: 'none' };
  report.services.control = { port: 3031, runningBefore: controlRunning, action: 'none' };
  if (ugcRunning || controlRunning) {
    throw new Error('UGC/Control must be stopped for engine tests; QA will not stop foreign or user processes');
  }
}

async function runVitest(env) {
  phase = 'tests';
  logLine('starting vitest with --maxWorkers=1');
  progress({ vitestStarted: true });
  const child = spawn(process.execPath, TEST_ARGS, {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  vitestPid = child.pid ?? null;
  report.process = { vitestPid, pgid: vitestPid };
  logLine(`vitest pid ${vitestPid}`);

  let stdout = '';
  let stderr = '';
  const append = (file, chunk) => { appendFileSync(file, chunk); appendFileSync(paths.combined, chunk); };
  child.stdout.on('data', (chunk) => { stdout += chunk; append(paths.stdout, chunk); lastLogAt = Date.now(); });
  child.stderr.on('data', (chunk) => { stderr += chunk; append(paths.stderr, chunk); lastLogAt = Date.now(); });

  const killOwn = (signal) => {
    if (!vitestPid) return;
    try { process.kill(-vitestPid, signal); report.watchdog.signals.push(signal); }
    catch { try { process.kill(vitestPid, signal); report.watchdog.signals.push(signal); } catch { /* already gone */ } }
  };

  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(monitor);
      clearTimeout(forceKillTimer);
      resolve({ code, signal });
    };
    let forceKillTimer = null;
    const monitor = setInterval(() => {
      const now = Date.now();
      const elapsed = now - NOW.getTime();
      const sample = sampleResources(vitestPid);
      report.resources.samples.push(sample);
      if (report.resources.samples.length > 600) report.resources.samples.shift();
      progress({ sample, watchdog: report.watchdog });
      if (!report.watchdog.triggered && elapsed >= TIMEOUT_MS) {
        report.watchdog.triggered = true;
        report.watchdog.reason = `timeout after ${elapsed}ms`;
        logLine(`watchdog: ${report.watchdog.reason}`);
        killOwn('SIGTERM');
        forceKillTimer = setTimeout(() => killOwn('SIGKILL'), 5_000);
      } else if (!report.watchdog.triggered && now - lastLogAt >= STALL_MS) {
        report.watchdog.triggered = true;
        report.watchdog.reason = `no output for ${now - lastLogAt}ms`;
        logLine(`watchdog: ${report.watchdog.reason}`);
        killOwn('SIGTERM');
        forceKillTimer = setTimeout(() => killOwn('SIGKILL'), 5_000);
      }
    }, SAMPLE_MS);
    child.once('error', (error) => { report.errors.push(safeText(error.message)); finish(1, null); });
    child.once('exit', (code, signal) => finish(code, signal));
  });

  report.exitCode = result.code;
  report.exitSignal = result.signal;
  report.tests = parseVitestResult(`${stdout}${stderr}`);
  report.resources.summary = {
    sampleCount: report.resources.samples.length,
    maxRssMb: Math.max(0, ...report.resources.samples.map((s) => s.maxRssMb)),
    totalRssMb: Math.max(0, ...report.resources.samples.map((s) => s.totalRssMb)),
    maxCpuPct: Math.max(0, ...report.resources.samples.map((s) => s.maxCpuPct)),
    maxLoad1: Math.max(0, ...report.resources.samples.map((s) => s.load1)),
  };
  report.outcome = report.exitCode === 0 && !report.watchdog.triggered ? 'passed' : 'failed';
  phase = 'finished';
  logLine(`vitest exit code=${report.exitCode} signal=${report.exitSignal ?? 'none'}`);
  return report.exitCode;
}

function writeReport() {
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - NOW.getTime();
  writeFileSync(paths.reportJson, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    `# QA full report — ${report.runId}`,
    '',
    `- Outcome: **${report.outcome}**`,
    `- Exit: code=${report.exitCode} signal=${report.exitSignal ?? 'none'}`,
    `- Duration: ${report.durationMs} ms`,
    `- Tests: ${report.tests?.tests ?? 'n/a'} (${report.tests?.testFiles ?? 'n/a'})`,
    `- Isolated database: ${report.database?.database ?? 'n/a'} on 127.0.0.1:${report.database?.port ?? 'n/a'}`,
    `- Trace: ${report.traceFile}`,
    `- Watchdog: ${report.watchdog.triggered ? `triggered (${report.watchdog.reason})` : 'not triggered'}`,
    `- Resource peak: ${report.resources.summary?.maxRssMb ?? 0} MiB RSS, ${report.resources.summary?.maxCpuPct ?? 0}% CPU, load1=${report.resources.summary?.maxLoad1 ?? 0}`,
    report.errors.length ? `- Errors: ${report.errors.join(' | ')}` : '- Errors: none',
    '',
    '## Vitest tail',
    '```text',
    report.tests?.tail ?? '',
    '```',
    '',
  ];
  writeFileSync(paths.reportMd, lines.join('\n'));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(dirname(LATEST_PROGRESS), { recursive: true });
  for (const file of [paths.combined, paths.stdout, paths.stderr, paths.trace]) writeFileSync(file, '');

  if (existsSync(LATEST_PROGRESS)) {
    try {
      const previous = JSON.parse(readFileSync(LATEST_PROGRESS, 'utf8'));
      if (previous.status === 'running') report.recovery = { previousRunId: previous.runId, previousPhase: previous.phase, previousPid: previous.vitestPid };
    } catch { /* ignore malformed progress */ }
  }
  phase = 'preflight';
  logLine(`QA run ${RUN_ID}`);

  if (!process.env.SESSION_JWT_SECRET || String(process.env.SESSION_JWT_SECRET).length < 32) {
    throw new Error('SESSION_JWT_SECRET must be at least 32 characters');
  }
  await prepareServices();
  progress();
  const env = await prepareDatabase();
  const exitCode = await runVitest(env);
  return exitCode;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  phase = 'failed';
  report.outcome = 'failed';
  report.errors.push(safeText(error?.message ?? error));
  logLine(`infrastructure failure: ${report.errors.at(-1)}`);
} finally {
  phase = 'cleanup';
  if (pgBinDir && pgDataDir && existsSync(pgDataDir)) {
    const stopped = runSync(pgPath('pg_ctl'), ['-D', pgDataDir, '-m', 'fast', '-w', 'stop']);
    report.database = report.database ?? {};
    report.database.stopped = stopped.status === 0;
    if (stopped.status !== 0) report.errors.push(safeText(stopped.stderr || 'postgres stop failed'));
  }
  if (report.services.browser?.startedByQa) {
    const stopped = runSync('bash', ['scripts/services.sh', 'stop', 'browser']);
    report.services.browser.reachableAfterRestore = await httpReachable(process.env.BROWSER_RUNTIME_URL ?? '');
    report.services.browser.stopResult = stopped.status;
  }
  writeReport();
  progress();
  process.exitCode = exitCode;
}

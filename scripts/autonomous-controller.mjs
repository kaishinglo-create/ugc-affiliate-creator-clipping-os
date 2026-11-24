#!/usr/bin/env node
// Autonomous controller. Single writer of the docs/completion/controller runtime.
// Never commits anything except explicit, allowlisted checkpoints; never pushes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CHECKPOINT_PREFIXES,
  backoffMs,
  cleanLogText,
  classifyFailure,
  eligibleModels,
  normalizeCooldowns,
  normalizeDirtyPath,
  providerOf,
  readFreeModelAllowlist,
  replayQueue,
  selectCheckpointPaths,
  setCooldown,
  stableTaskId,
} from './controller-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LEGACY_DIR = path.join(ROOT, 'docs/completion');
const CONTROL_DIR = path.join(LEGACY_DIR, 'controller');
const STATE_FILE = path.join(CONTROL_DIR, 'state.json');
const HEARTBEAT_FILE = path.join(CONTROL_DIR, 'heartbeat.json');
const COOLDOWNS_FILE = path.join(CONTROL_DIR, 'cooldowns.json');
const JOURNAL_FILE = path.join(CONTROL_DIR, 'journal.jsonl');
const CATALOG_FILE = path.join(CONTROL_DIR, 'model-catalog.json');
const LOG_FILE = path.join(CONTROL_DIR, 'controller.log');
const ATTEMPTS_DIR = path.join(CONTROL_DIR, 'attempts');
const LOCK_FILE = path.join(CONTROL_DIR, 'controller.lock');
const STOP_FILE = path.join(CONTROL_DIR, 'STOP');
const LEGACY_STOP_FILE = path.join(LEGACY_DIR, 'CONTROLLER_STOP_REQUESTED');
const FEATURE_MATRIX = path.join(LEGACY_DIR, 'FEATURE_MATRIX.json');
const NEXT_SESSION_FILE = path.join(LEGACY_DIR, 'NEXT_SESSION.md');
const VERSION = 1;
const HEARTBEAT_MS = 10_000;
const TICK_MS = 10_000;
const MAX_REPAIRS = 3;
const AUDIT_EMPTY_LIMIT = 3;
const DISCOVERY_INTERVAL_MS = 600_000;
const LOW_MEMORY_BYTES = 256 * 1024 * 1024;
const MIN_DISK_BYTES = 1024 * 1024 * 1024;
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const AGENT_TIMEOUT_MS = positiveEnv('CONTROLLER_AGENT_TIMEOUT_MS', 480_000);
const VERIFY_TIMEOUT_MS = 90_000;
const TARGETED_TIMEOUT_MS = 180_000;
const FULL_TIMEOUT_MS = positiveEnv('CONTROLLER_FULL_TEST_TIMEOUT_MS', 480_000);
const SECRET_RE = /API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE KEY|DATABASE_URL|OLLAMA_API_KEY|SESSION_JWT_SECRET|MECE_DASHBOARD_TOKEN|Bearer\s+[A-Za-z0-9._-]{16,}/i;

const instanceId = randomUUID();
let state = null;
let queue = [];
let cooldowns = { models: {}, providers: {} };
let lastUsed = {};
let catalog = { models: [], source: null, fetchedAt: null };
let heartbeatTimer = null;
let lockChild = null;
let lockFd = null;
let currentChild = null;
let stopRequested = false;
let shuttingDown = false;
let wakeSleep = () => {};

function positiveEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function iso() {
  return new Date().toISOString();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
}

function log(message) {
  appendLine(LOG_FILE, `[${iso()}] ${message}`);
}

function appendEvent(event) {
  appendLine(JOURNAL_FILE, JSON.stringify({ at: Date.now(), ...event }));
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim());
  } catch {
    return [];
  }
}

function persistState() {
  if (!state) return;
  state.updatedAt = iso();
  state.queueDepth = queue.length;
  state.uptimeSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(state.startedAt || iso())) / 1000));
  state.cooldowns = cooldowns;
  atomicWrite(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function freshState(previous = {}) {
  const startedAt = previous.startedAt || iso();
  const restarted = previous.owner && previous.owner.instanceId !== instanceId && previous.status !== 'stopped';
  return {
    version: VERSION,
    status: 'recovering',
    pauseReason: null,
    resumeAt: null,
    startedAt,
    updatedAt: iso(),
    owner: { pid: process.pid, instanceId, startedAt: iso() },
    currentTask: null,
    queueDepth: 0,
    completed: Array.isArray(previous.completed) ? previous.completed : [],
    failed: Array.isArray(previous.failed) ? previous.failed : [],
    model: {
      activeModel: previous.model?.activeModel ?? null,
      activeProvider: previous.model?.activeProvider ?? null,
      catalogSource: previous.model?.catalogSource ?? null,
      catalogAt: previous.model?.catalogAt ?? null,
    },
    cooldowns: { models: {}, providers: {} },
    resources: previous.resources ?? {},
    verification: previous.verification ?? { tier: null, result: null, at: null },
    uptimeSeconds: 0,
    lastCheckpoint: previous.lastCheckpoint ?? null,
    restartCount: (previous.restartCount ?? 0) + (restarted ? 1 : 0),
    lastExitCode: previous.lastExitCode ?? null,
    heartbeatAgeSeconds: 0,
    failureHistory: previous.failureHistory ?? {},
    quarantined: Array.isArray(previous.quarantined) ? previous.quarantined : [],
    obsolete: Array.isArray(previous.obsolete) ? previous.obsolete : [],
    stoppedAt: null,
  };
}

function emptyStatus() {
  return {
    version: VERSION,
    status: 'stopped',
    pauseReason: null,
    resumeAt: null,
    startedAt: null,
    updatedAt: iso(),
    owner: null,
    currentTask: null,
    queueDepth: 0,
    completed: [],
    failed: [],
    model: { activeModel: null, activeProvider: null, catalogSource: null, catalogAt: null },
    cooldowns: { models: {}, providers: {} },
    resources: {},
    verification: { tier: null, result: null, at: null },
    uptimeSeconds: 0,
    lastCheckpoint: null,
    restartCount: 0,
    lastExitCode: null,
    heartbeatAgeSeconds: null,
  };
}

function statusCommand() {
  const stateOnDisk = readJson(STATE_FILE, null);
  const heartbeat = readJson(HEARTBEAT_FILE, null);
  const status = { ...emptyStatus(), ...(stateOnDisk ?? {}) };
  if (heartbeat?.at) {
    status.heartbeatAgeSeconds = Math.max(0, Math.round((Date.now() - Date.parse(heartbeat.at)) / 1000));
  }
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

function stopCommand() {
  fs.mkdirSync(CONTROL_DIR, { recursive: true });
  atomicWrite(STOP_FILE, `${iso()}\n`);
  process.stdout.write(`stop requested (${STOP_FILE})\n`);
}

function stopFlagPresent() {
  return fs.existsSync(STOP_FILE) || fs.existsSync(LEGACY_STOP_FILE);
}

function writeHeartbeat() {
  const heartbeat = {
    at: iso(),
    pid: process.pid,
    instanceId,
    status: state?.status ?? 'stopped',
    currentTaskId: state?.currentTask?.taskId ?? null,
    queueDepth: queue.length,
  };
  atomicWrite(HEARTBEAT_FILE, `${JSON.stringify(heartbeat, null, 2)}\n`);
  if (state && !shuttingDown) {
    state.heartbeatAgeSeconds = 0;
    persistState();
  }
}

function interruptibleSleep(ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      wakeSleep = () => {};
      resolve(stopRequested || shuttingDown);
    };
    wakeSleep = finish;
    const step = () => {
      if (stopRequested || shuttingDown || Date.now() >= deadline) return finish();
      timer = setTimeout(step, Math.min(TICK_MS, deadline - Date.now()));
    };
    step();
  });
}

async function acquireLock() {
  fs.mkdirSync(CONTROL_DIR, { recursive: true });
  lockFd = fs.openSync(LOCK_FILE, 'a');
  lockChild = spawn('flock', ['-n', '3', 'cat'], {
    stdio: ['pipe', 'ignore', 'inherit', lockFd],
    cwd: ROOT,
  });
  const outcome = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    lockChild.once('exit', (code) => done({ ok: false, code }));
    lockChild.once('error', (error) => done({ ok: false, error }));
    setTimeout(() => done({ ok: true }), 250);
  });
  if (!outcome.ok) {
    log(`controller lock held or unavailable (${JSON.stringify(outcome)})`);
    try { lockChild.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.closeSync(lockFd); } catch { /* already closed */ }
    lockChild = null;
    lockFd = null;
    return false;
  }
  return true;
}

async function releaseLock() {
  if (!lockChild) return;
  const child = lockChild;
  lockChild = null;
  try { child.stdin.end(); } catch { /* closed */ }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const raced = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 1000))]);
  if (!raced) {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
  try { if (lockFd !== null) fs.closeSync(lockFd); } catch { /* closed */ }
  lockFd = null;
}

function killAgentGroup(signal) {
  if (!currentChild?.pid) return;
  try { process.kill(-currentChild.pid, signal); } catch { /* group already gone */ }
  try { currentChild.kill(signal); } catch { /* already gone */ }
}

function readJournal() {
  const events = [];
  for (const line of readLines(JOURNAL_FILE)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch {
      log(`ignoring malformed journal line: ${line.slice(0, 120)}`);
    }
  }
  return events;
}

function legacyTaskId(line, fallbackText = '') {
  const text = line.includes('|') ? line.slice(line.indexOf('|') + 1) : line;
  return (line.includes('|') ? line.slice(0, line.indexOf('|')) : stableTaskId(fallbackText || text)).trim() || stableTaskId(text);
}

function migrateLegacyJournal() {
  if (fs.existsSync(JOURNAL_FILE)) return false;
  const events = [];
  const queued = readLines(path.join(LEGACY_DIR, 'TASK_QUEUE.txt')).map((line) => ({
    taskId: legacyTaskId(line),
    text: line.includes('|') ? line.slice(line.indexOf('|') + 1) : line,
  }));
  for (const task of queued) {
    events.push({ type: 'enqueue', taskId: task.taskId, text: task.text, attempts: 0, at: Date.now(), source: 'legacy-queue' });
  }
  const idForText = (text) => queued.find((task) => task.text === text)?.taskId ?? stableTaskId(text);
  for (const line of readLines(path.join(LEGACY_DIR, 'COMPLETED_TASKS.txt'))) {
    const text = line.includes('|') ? line.slice(line.indexOf('|') + 1) : line;
    const taskId = idForText(text);
    events.push({ type: 'enqueue', taskId, text, attempts: 0, at: Date.now(), source: 'legacy-completed' });
    events.push({ type: 'complete', taskId, at: Date.now(), source: 'legacy-completed' });
  }
  for (const line of readLines(path.join(LEGACY_DIR, 'FAILED_TASKS.txt'))) {
    const text = line.includes('|') ? line.slice(line.indexOf('|') + 1) : line;
    const taskId = idForText(text);
    events.push({ type: 'enqueue', taskId, text, attempts: 0, at: Date.now(), source: 'legacy-failed' });
    events.push({ type: 'fail', taskId, at: Date.now(), reason: 'legacy-failed' });
  }
  const legacyState = readJson(path.join(LEGACY_DIR, 'AUTONOMOUS_STATE.json'), {});
  if (typeof legacyState.currentTask === 'string' && legacyState.currentTask.trim()) {
    const text = legacyState.currentTask.trim();
    if (!queued.some((task) => task.text === text)) {
      const taskId = stableTaskId(text);
      events.push({ type: 'enqueue', taskId, text, attempts: 0, at: Date.now(), source: 'legacy-current-task' });
    }
  }
  atomicWrite(JOURNAL_FILE, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  log(`migrated ${events.length} legacy journal events (legacy files untouched)`);
  return true;
}

/** Retire tasks produced by the old docs/autonomous-build/*.md scan. */
function obsoleteStaleRoadmapTasks() {
  if (!fs.existsSync(JOURNAL_FILE)) return 0;
  const events = readJournal();
  const retired = new Set(events.filter((event) => event.type === 'obsolete').map((event) => event.taskId));
  const stale = new Map();
  for (const event of events) {
    if (event.type !== 'enqueue' || retired.has(event.taskId)) continue;
    if (!/^Roadmap:\s/.test(String(event.text ?? ''))) continue;
    stale.set(event.taskId, String(event.text));
  }
  for (const [taskId, text] of stale) {
    appendEvent({ type: 'obsolete', taskId, text, reason: 'STALE_ROADMAP_DISCOVERY', at: Date.now() });
  }
  if (stale.size) log(`marked ${stale.size} stale roadmap task(s) obsolete`);
  return stale.size;
}

function loadJournalState() {
  const replay = replayQueue(readJournal());
  if (replay.recovered.length) {
    for (const task of replay.recovered) {
      appendEvent({
        type: 'requeue',
        taskId: task.taskId,
        text: task.text,
        attempts: task.attempts,
        reason: 'crash-recovery',
      });
    }
    log(`requeued ${replay.recovered.length} interrupted lease(s) with unchanged attempts`);
  }
  const recovered = replayQueue(readJournal());
  queue = recovered.pending;
  cooldowns = normalizeCooldowns(readJson(COOLDOWNS_FILE, {}));
  lastUsed = readJson(path.join(CONTROL_DIR, 'last-used.json'), {});
  state.completed = recovered.completed.map(({ taskId, text, at }) => ({ taskId, text, at }));
  state.failed = recovered.failed.map(({ taskId, text, at, reason }) => ({ taskId, text, at, reason }));
  state.quarantined = recovered.quarantined.map(({ taskId, text, at, reason }) => ({ taskId, text, at, reason }));
  state.obsolete = recovered.obsolete.map(({ taskId, text, at, reason }) => ({ taskId, text, at, reason }));
  persistState();
}

function parseCatalog(stdout) {
  const ids = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0] ?? '';
    if (/^[^/\s]+\/[^/\s]+$/.test(token)) ids.push(token);
  }
  return [...new Set(ids)];
}

function refreshCatalog(force = false) {
  const cached = readJson(CATALOG_FILE, null);
  const fresh = cached?.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < CATALOG_TTL_MS && Array.isArray(cached.models) && cached.models.length;
  if (fresh && !force) {
    catalog = { models: cached.models, source: cached.source || 'cache', fetchedAt: cached.fetchedAt };
    return catalog;
  }
  const result = spawnSync('opencode', ['models'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  const ids = result.status === 0 ? parseCatalog(result.stdout) : [];
  if (ids.length) {
    catalog = { models: ids, source: 'opencode models', fetchedAt: iso() };
  } else if (Array.isArray(cached?.models) && cached.models.length) {
    catalog = { models: cached.models, source: 'cache-fallback', fetchedAt: cached.fetchedAt };
  } else {
    catalog = { models: [], source: 'unavailable', fetchedAt: null };
  }
  atomicWrite(CATALOG_FILE, `${JSON.stringify(catalog, null, 2)}\n`);
  state.model.catalogSource = catalog.source;
  state.model.catalogAt = catalog.fetchedAt;
  return catalog;
}

function pickModel() {
  const eligible = eligibleModels(catalog.models, cooldowns, Date.now(), lastUsed, readFreeModelAllowlist());
  return eligible[0] ?? null;
}

function cooldownUntilAfter(untilMs) {
  if (Number.isFinite(untilMs)) return untilMs;
  return Date.now() + backoffMs(6);
}

function cooldownFloor() {
  const values = [
    ...Object.values(cooldowns.models ?? {}).map((entry) => entry.untilMs),
    ...Object.values(cooldowns.providers ?? {}).map((entry) => entry.untilMs),
  ].filter((value) => Number.isFinite(value) && value > Date.now());
  return values.length ? Math.min(...values) : Date.now() + backoffMs(6);
}

function writeCooldowns() {
  cooldowns = normalizeCooldowns(cooldowns);
  atomicWrite(COOLDOWNS_FILE, `${JSON.stringify(cooldowns, null, 2)}\n`);
  state.cooldowns = cooldowns;
}

async function checkpoint(taskId, baseline) {
  const current = dirtyPaths();
  const selected = selectCheckpointPaths(baseline, current, CHECKPOINT_PREFIXES);
  if (!selected.length) {
    log('checkpoint: no newly dirty allowlisted paths; lastCheckpoint unchanged');
    return null;
  }
  const add = await runCommand('git', ['add', '--', ...selected], { timeoutMs: 30_000 });
  if (add.code !== 0) {
    log(`checkpoint: git add failed (${add.code}); no commit created`);
    return null;
  }
  const diff = await runCommand('git', ['diff', '--cached', '--', ...selected], { timeoutMs: 30_000 });
  if (SECRET_RE.test(diff.output)) {
    await runCommand('git', ['reset', '--', ...selected], { timeoutMs: 30_000 });
    log('checkpoint: FAIL CLOSED - possible secret in staged diff; unstaged and did not commit');
    return null;
  }
  const commit = await runCommand('git', ['commit', '--no-verify', '-m', `controller checkpoint: ${taskId}`, '--', ...selected], { timeoutMs: 60_000 });
  if (commit.code !== 0) {
    log(`checkpoint: commit failed (${commit.code}); no push attempted`);
    return null;
  }
  const hash = (await runCommand('git', ['rev-parse', '--short', 'HEAD'], { timeoutMs: 15_000 })).output.trim();
  log(`checkpoint created: ${hash || 'unknown'} (${selected.length} path(s))`);
  return hash || null;
}

function dirtyPaths() {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return [];
  return String(result.stdout ?? '').split(/\r?\n/).map(normalizeDirtyPath).filter(Boolean);
}

/** Async process runner so the heartbeat timer keeps firing during long checks. */
function runCommand(command, args, { timeoutMs = 60_000, attemptLog = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const killGroup = (signal) => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch { /* gone */ }
      try { child.kill(signal); } catch { /* gone */ }
    };
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = `${stdout}\n${stderr}`.trim();
      if (attemptLog) appendLine(attemptLog, `\n$ ${command} ${args.join(' ')}\n[exit ${code}]\n${output.slice(-20_000)}\n`);
      resolve({ code, output, stdout, stderr, error, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5_000).unref();
      finish(124);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => finish(1, error));
    child.once('close', (code) => finish(timedOut ? 124 : (code ?? 1)));
  });
}

function attemptLogPath(taskId, attempt) {
  const safe = /^[0-9a-f]{12}$/.test(taskId) ? taskId : stableTaskId(taskId);
  return path.join(ATTEMPTS_DIR, `${safe}-${Math.max(0, attempt) + 1}.log`);
}

function agentPrompt(task, model) {
  return [
    `Task: ${task}`,
    `Work in ${ROOT}. Make minimal, verifiable changes using the free model ${model}.`,
    'Strictly forbidden: editing anything under docs/completion/controller/ (state, heartbeat, cooldowns, journal, logs, catalog, attempts), any controller log or lock/STOP file, FEATURE_MATRIX.json, FEATURE_MATRIX.md, docs/autonomous-build/*.md or any other roadmap doc, src/generated, .env, and generated files.',
    'Do not commit, push, merge, deploy, or create credentials. Report exactly what you verified and what remains unverified.',
  ].join(' ');
}

async function runAgent(task, model, attempt, taskId) {
  const logPath = attemptLogPath(taskId, attempt);
  fs.mkdirSync(ATTEMPTS_DIR, { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  appendLine(logPath, `\n[${iso}] model=${model} attempt=${attempt + 1}\n`);
  const binary = process.env.OPENCODE_BIN || 'opencode';
  const args = ['-n', '10', binary, 'run', '--auto', '--standalone', '--model', model, agentPrompt(task, model)];
  const child = spawn('nice', args, { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
  currentChild = child;
  const outcome = await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      currentChild = null;
      try { fs.closeSync(fd); } catch { /* closed */ }
      resolve({ code: timedOut ? 124 : (code ?? 1), signal, timedOut, logPath });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killAgentGroup('SIGTERM');
      setTimeout(() => killAgentGroup('SIGKILL'), 10_000).unref();
      finish(124, null);
    }, AGENT_TIMEOUT_MS);
    child.once('error', (error) => {
      appendLine(logPath, `[${iso}] spawn error: ${error.message}`);
      finish(1, null);
    });
    child.once('exit', (code, signal) => finish(code, signal));
  });
  let tail = '';
  try { tail = fs.readFileSync(logPath, 'utf8').slice(-20_000); } catch { /* unreadable */ }
  return { ...outcome, tail };
}

function targetedTests(changedPaths) {
  const files = new Set();
  for (const changed of changedPaths) {
    if (!changed.startsWith('tests/')) {
      if (!changed.startsWith('src/') && !changed.startsWith('lib/')) continue;
      const base = path.basename(changed).replace(/\.(ts|tsx|js|mjs)$/, '');
      const candidates = [base === 'index' ? path.basename(path.dirname(changed)) : base].filter(Boolean);
      for (const candidate of candidates) {
        const file = `tests/${candidate}.test.ts`;
        if (fs.existsSync(path.join(ROOT, file))) files.add(file);
      }
      continue;
    }
    if (changed.endsWith('.test.ts') && fs.existsSync(path.join(ROOT, changed))) files.add(changed);
  }
  return [...files].sort();
}

function verificationFailure(result, tier, attemptLog) {
  const classification = classifyFailure(result.output, result.code);
  const infra = classification === 'INFRA';
  state.verification = { tier, result: infra ? 'infra' : 'failed', classification, at: iso() };
  log(`verification tier ${tier} ${infra ? 'infra failure' : 'failed'} (${classification}, exit ${result.code})`);
  appendLine(attemptLog, `\n[${iso}] verification tier ${tier}: ${classification}\n`);
  return { ok: false, infra, classification };
}

async function verifyTask(baseline, attemptLog) {
  const changed = selectCheckpointPaths(baseline, dirtyPaths(), CHECKPOINT_PREFIXES);
  const tsc = await runCommand('node', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'], { timeoutMs: VERIFY_TIMEOUT_MS, attemptLog });
  if (tsc.code !== 0) return verificationFailure(tsc, 1, attemptLog);
  const lint = await runCommand('node', ['node_modules/eslint/bin/eslint.js', '.'], { timeoutMs: VERIFY_TIMEOUT_MS, attemptLog });
  if (lint.code !== 0) return verificationFailure(lint, 1, attemptLog);

  const tests = targetedTests(changed);
  if (tests.length) {
    const targeted = await runCommand('node', ['node_modules/vitest/vitest.mjs', 'run', ...tests, '--maxWorkers=1'], { timeoutMs: TARGETED_TIMEOUT_MS, attemptLog });
    if (targeted.code !== 0) return verificationFailure(targeted, 2, attemptLog);
    state.verification = { tier: 2, result: 'passed', at: iso(), files: tests };
  } else {
    state.verification = { tier: 2, result: 'skipped', at: iso(), files: [] };
  }

  const full = await runCommand('node', ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1'], { timeoutMs: FULL_TIMEOUT_MS, attemptLog });
  if (full.code !== 0) return verificationFailure(full, 3, attemptLog);
  state.verification = { tier: 3, result: 'passed', at: iso() };
  return { ok: true, infra: false, classification: null };
}

function resourceSnapshot() {
  let freeMemoryBytes = null;
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const available = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (available) freeMemoryBytes = Number(available[1]) * 1024;
  } catch { /* not Linux */ }
  let cgroupFreeBytes = null;
  for (const [maxPath, currentPath] of [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
  ]) {
    try {
      const max = fs.readFileSync(maxPath, 'utf8').trim();
      if (!/^\d+$/.test(max)) continue;
      const usage = Number(fs.readFileSync(currentPath, 'utf8').trim());
      if (Number.isFinite(usage)) cgroupFreeBytes = Math.max(0, Number(max) - usage);
      break;
    } catch { /* try next */ }
  }
  const disk = spawnSync('df', ['-k', ROOT], { encoding: 'utf8', timeout: 10_000 });
  const diskLine = String(disk.stdout ?? '').split(/\r?\n/)[1]?.trim().split(/\s+/);
  // df -k columns: Filesystem 1K-blocks Used Available Use% Mounted-on
  const diskFreeBytes = diskLine?.length >= 4 ? Number(diskLine[3]) * 1024 : null;
  const cpuCount = os.cpus().length || 1;
  const load1 = os.loadavg()[0] ?? 0;
  const ok =
    (freeMemoryBytes === null || freeMemoryBytes >= LOW_MEMORY_BYTES) &&
    (cgroupFreeBytes === null || cgroupFreeBytes >= LOW_MEMORY_BYTES) &&
    (diskFreeBytes === null || diskFreeBytes >= MIN_DISK_BYTES) &&
    load1 <= 2 * cpuCount;
  return {
    ok,
    checkedAt: iso(),
    freeMemoryMb: freeMemoryBytes === null ? null : Math.round(freeMemoryBytes / 1048576),
    cgroupFreeMb: cgroupFreeBytes === null ? null : Math.round(cgroupFreeBytes / 1048576),
    diskFreeGb: diskFreeBytes === null ? null : Math.round((diskFreeBytes / 1073741824) * 100) / 100,
    load1: Math.round(load1 * 100) / 100,
    cpuCount,
  };
}

function knownIds() {
  return new Set([
    ...queue.map((task) => task.taskId),
    ...state.completed.map((task) => task.taskId || stableTaskId(task.text)),
    ...state.failed.map((task) => task.taskId || stableTaskId(task.text)),
    ...state.quarantined.map((task) => task.taskId || stableTaskId(task.text)),
    ...(state.obsolete ?? []).map((task) => task.taskId || stableTaskId(task.text)),
  ]);
}

function nextSessionTasks() {
  const texts = [];
  let inList = false;
  for (const line of readLines(NEXT_SESSION_FILE)) {
    if (/^##\s+Nächste sinnvolle Aufgaben/i.test(line)) {
      inList = true;
      continue;
    }
    if (inList && /^##\s+/.test(line)) break;
    if (!inList) continue;
    const match = line.match(/^\s*\d+\.\s+(.+)$/);
    if (!match) continue;
    const text = `Next: ${match[1].trim()}`;
    if (/controller\/|\.env|generated|\.log|node_modules/.test(text)) continue;
    texts.push(text);
  }
  return texts;
}

function discoverTasks() {
  const texts = [];
  const matrix = readJson(FEATURE_MATRIX, { features: [] });
  for (const feature of Array.isArray(matrix.features) ? matrix.features : []) {
    if (!feature?.name || feature.status === 'complete') continue;
    const criteria = Array.isArray(feature.criteria) ? feature.criteria.join('; ') : '';
    texts.push(`Complete feature: ${feature.name} (${feature.status}) - criteria: ${criteria}`);
  }
  // Historical `Next:` lines in docs/autonomous-build/*.md describe completed
  // phases. Only the maintained NEXT_SESSION.md list is executable discovery.
  texts.push(...nextSessionTasks());
  const known = knownIds();
  let added = 0;
  for (const text of texts) {
    const taskId = stableTaskId(text);
    if (known.has(taskId)) continue;
    known.add(taskId);
    appendEvent({ type: 'enqueue', taskId, text, attempts: 0, at: Date.now(), source: 'discovery' });
    queue.push({ taskId, text, attempts: 0 });
    added += 1;
  }
  persistState();
  return added;
}

function requeueTask(task, reason) {
  appendEvent({ type: 'requeue', taskId: task.taskId, text: task.text, attempts: task.attempts ?? 0, reason });
  state.currentTask = null;
  persistState();
}

function terminalEvent(type, task, extra = {}) {
  appendEvent({ type, taskId: task.taskId, text: task.text, attempts: task.attempts ?? 0, ...extra });
  state.currentTask = null;
  persistState();
}

function recordFailureFingerprint(task, classification, output, attempt) {
  const normalised = cleanLogText(output).slice(0, 2_000).replace(/\d+/g, '#');
  const fingerprint = stableTaskId(`${classification}|${normalised}`);
  const history = state.failureHistory[task.taskId] ?? [];
  history.push({ fingerprint, classification, attempt, at: iso() });
  state.failureHistory[task.taskId] = history.slice(-10);
  persistState();
  return history.filter((entry) => entry.fingerprint === fingerprint).length;
}

function quotaWait(task, reason, untilMs) {
  requeueTask(task, reason);
  state.status = 'quota_wait';
  state.pauseReason = reason;
  state.resumeAt = cooldownUntilAfter(untilMs);
  state.lastExitCode = null;
  persistState();
  log(`${reason}: requeued ${task.taskId} with ${task.attempts ?? 0} attempt(s); resumeAt=${state.resumeAt}`);
}

function handleLimit(task, model, classification, output, attempt) {
  const level = classification === 'GLOBAL_FREE_QUOTA' ? 7 : classification === 'PROVIDER_LIMIT' ? 6 : Math.min(5, attempt + 2);
  const retryAfter = String(output ?? '').match(/retry[ -]?after:\s*(\d+)/i)?.[1];
  const untilMs = Date.now() + backoffMs(level, retryAfter);
  cooldowns = setCooldown(cooldowns, 'model', model, untilMs, classification);
  if (classification === 'PROVIDER_LIMIT' || classification === 'GLOBAL_FREE_QUOTA') {
    cooldowns = setCooldown(cooldowns, 'provider', providerOf(model), untilMs, classification);
  }
  writeCooldowns();
  quotaWait(task, classification, untilMs);
}

async function processTask(task) {
  const attempts = task.attempts ?? 0;
  appendEvent({ type: 'claim', taskId: task.taskId, text: task.text, attempts, at: Date.now() });
  state.status = 'running';
  state.pauseReason = null;
  state.resumeAt = null;
  state.currentTask = { taskId: task.taskId, text: task.text, attempts, claimedAt: iso(), model: null, verification: null };
  persistState();
  log(`claimed ${task.taskId} (attempts=${attempts}): ${task.text.slice(0, 180)}`);
  const baseline = dirtyPaths();

  for (let repair = 0; repair <= MAX_REPAIRS; repair += 1) {
    if (shuttingDown || stopRequested || !state.currentTask) return 'interrupted';
    const model = pickModel();
    if (!model) {
      quotaWait(task, 'NO_FREE_MODEL', cooldownFloor());
      log('no provably free model eligible; no paid fallback used');
      return 'quota_wait';
    }
    state.currentTask.model = model;
    state.model.activeModel = model;
    state.model.activeProvider = providerOf(model);
    persistState();

    const attemptLog = attemptLogPath(task.taskId, repair);
    const agent = await runAgent(task.text, model, repair, task.taskId);
    // Shutdown may have requeued this task while the child was running. Do
    // not touch the cleared currentTask or record a verdict after that.
    if (shuttingDown || stopRequested || !state.currentTask) return 'interrupted';
    log(`agent exit=${agent.code}${agent.timedOut ? ' (timeout)' : ''} model=${model} repair=${repair} task=${task.taskId}`);
    const classification = classifyFailure(agent.tail, agent.code);
    if (['GLOBAL_FREE_QUOTA', 'PROVIDER_LIMIT', 'MODEL_RATE_LIMIT'].includes(classification)) {
      handleLimit(task, model, classification, agent.tail, repair);
      return 'limit';
    }
    if (agent.code !== 0) {
      if (classification === 'INFRA') {
        requeueTask(task, 'INFRA');
        state.status = 'resource_wait';
        state.pauseReason = 'INFRA';
        state.resumeAt = Date.now() + backoffMs(repair + 1);
        persistState();
        log(`infrastructure failure for ${task.taskId}; repair attempts unchanged`);
        return 'infra';
      }
      const repeats = recordFailureFingerprint(task, classification, agent.tail, repair);
      if (repeats >= 2) {
        terminalEvent('quarantine', task, { reason: 'REPEATED_FAILURE', fingerprint: stableTaskId(cleanLogText(agent.tail).slice(0, 2_000)) });
        state.quarantined.push({ taskId: task.taskId, text: task.text, at: iso(), reason: 'REPEATED_FAILURE' });
        persistState();
        log(`quarantined ${task.taskId}: identical failure fingerprint repeated ${repeats}x`);
        return 'quarantine';
      }
      if (classification === 'AUTH_BLOCKER') {
        terminalEvent('quarantine', task, { reason: 'AUTH_BLOCKER' });
        state.quarantined.push({ taskId: task.taskId, text: task.text, at: iso(), reason: 'AUTH_BLOCKER' });
        persistState();
        return 'quarantine';
      }
      log(`code failure ${classification} for ${task.taskId}; repair ${repair + 1}/${MAX_REPAIRS}`);
      continue;
    }

    lastUsed[model] = { at: Date.now(), uses: (lastUsed[model]?.uses ?? 0) + 1 };
    atomicWrite(path.join(CONTROL_DIR, 'last-used.json'), `${JSON.stringify(lastUsed, null, 2)}\n`);

    const verification = await verifyTask(baseline, attemptLog);
    if (shuttingDown || stopRequested || !state.currentTask) return 'interrupted';
    if (verification.ok) {
      const checkpointHash = await checkpoint(task.taskId, baseline);
      state.lastCheckpoint = checkpointHash;
      terminalEvent('complete', task, { at: Date.now() });
      state.completed.push({ taskId: task.taskId, text: task.text, at: iso(), checkpoint: checkpointHash });
      state.status = 'running';
      state.pauseReason = null;
      state.resumeAt = null;
      state.verification = { tier: 3, result: 'passed', at: iso() };
      persistState();
      log(`completed ${task.taskId}`);
      return 'complete';
    }
    if (verification.infra) {
      requeueTask(task, 'VERIFY_INFRA');
      state.status = 'resource_wait';
      state.pauseReason = 'VERIFY_INFRA';
      state.resumeAt = Date.now() + backoffMs(repair + 1);
      persistState();
      return 'infra';
    }
    if (verification.classification === 'CODE_FAIL' && state.verification?.tier === 3) {
      // Tier 3 is deliberately run at most once per task. A full-suite code
      // failure terminates this task instead of re-running the whole suite.
      terminalEvent('fail', task, { reason: 'FULL_SUITE_FAILED' });
      state.failed.push({ taskId: task.taskId, text: task.text, at: iso(), reason: 'FULL_SUITE_FAILED' });
      persistState();
      log(`failed ${task.taskId}: full suite did not pass; no second full run`);
      return 'fail';
    }
    if (repair >= MAX_REPAIRS) break;
    log(`verification code failure for ${task.taskId}; repair ${repair + 1}/${MAX_REPAIRS}`);
  }

  terminalEvent('fail', task, { reason: 'MAX_REPAIRS' });
  state.failed.push({ taskId: task.taskId, text: task.text, at: iso(), reason: 'MAX_REPAIRS' });
  persistState();
  log(`failed ${task.taskId} after ${MAX_REPAIRS} repairs`);
  return 'fail';
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopRequested = true;
  wakeSleep();
  if (state) {
    state.status = 'stopping';
    persistState();
    if (state.currentTask) {
      const task = state.currentTask;
      appendEvent({ type: 'requeue', taskId: task.taskId, text: task.text, attempts: task.attempts ?? 0, reason: 'shutdown' });
      state.currentTask = null;
      persistState();
      log(`requeued ${task.taskId} on shutdown with ${task.attempts ?? 0} attempt(s)`);
    }
  }
  killAgentGroup('SIGTERM');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  writeHeartbeat();
  const onDisk = readJson(STATE_FILE, null);
  if (onDisk?.owner?.instanceId === instanceId) {
    state.status = 'stopped';
    state.stoppedAt = iso();
    state.currentTask = null;
    state.lastExitCode = exitCode;
    persistState();
  } else {
    log('did not write stopped: current owner belongs to another controller instance');
  }
  await releaseLock();
  process.exit(exitCode);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--status')) {
    statusCommand();
    return;
  }
  if (args.has('--stop')) {
    stopCommand();
    return;
  }
  const once = args.has('--once');
  if (!await acquireLock()) {
    process.exit(75);
  }

  fs.mkdirSync(ATTEMPTS_DIR, { recursive: true });
  const previous = readJson(STATE_FILE, null);
  state = freshState(previous ?? {});
  state.status = 'recovering';
  persistState();
  log(`controller start pid=${process.pid} instance=${instanceId}${once ? ' (--once)' : ''}`);

  process.on('SIGTERM', () => { log('SIGTERM received'); void shutdown(0); });
  process.on('SIGINT', () => { log('SIGINT received'); void shutdown(0); });

  const migrated = migrateLegacyJournal();
  obsoleteStaleRoadmapTasks();
  loadJournalState();
  refreshCatalog();
  if (migrated) log('legacy migration complete; legacy files left untouched');

  heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_MS);
  writeHeartbeat();
  state.status = 'running';
  persistState();

  let lastDiscovery = Date.now();
  let auditEmpty = 0;
  let sawTask = false;

  while (!stopRequested && !shuttingDown) {
    if (stopFlagPresent()) {
      log('STOP flag detected');
      break;
    }
    const resources = resourceSnapshot();
    state.resources = resources;
    if (!resources.ok) {
      state.status = 'resource_wait';
      state.pauseReason = 'RESOURCES';
      state.resumeAt = Date.now() + 60_000;
      persistState();
      log(`resource wait: ${JSON.stringify(resources)}`);
      if (await interruptibleSleep(60_000)) break;
      continue;
    }
    if (state.status === 'resource_wait') {
      state.status = 'running';
      state.pauseReason = null;
      state.resumeAt = null;
    }
    if (Date.now() - lastDiscovery >= DISCOVERY_INTERVAL_MS || queue.length === 0) {
      const added = discoverTasks();
      lastDiscovery = Date.now();
      if (added === 0 && queue.length === 0) auditEmpty += 1;
      else auditEmpty = 0;
      if (queue.length === 0 && auditEmpty >= AUDIT_EMPTY_LIMIT) {
        state.status = 'paused';
        state.pauseReason = 'NO_EXECUTABLE_TASKS';
        state.resumeAt = Date.now() + 600_000;
        persistState();
        log(`no executable tasks after ${auditEmpty} audits; paused 600s`);
        if (await interruptibleSleep(600_000)) break;
        auditEmpty = 0;
        continue;
      }
    }
    cooldowns = normalizeCooldowns(cooldowns);
    if (state.resumeAt && Date.now() < state.resumeAt) {
      if (state.status === 'running' && state.pauseReason) {
        state.status = state.pauseReason === 'NO_FREE_MODEL' || state.pauseReason.includes('LIMIT') ? 'quota_wait' : 'resource_wait';
      }
      persistState();
      if (await interruptibleSleep(Math.max(1000, state.resumeAt - Date.now()))) break;
      continue;
    }
    if (state.resumeAt && Date.now() >= state.resumeAt) {
      state.resumeAt = null;
      state.pauseReason = null;
      state.status = 'running';
      persistState();
    }
    if (!queue.length) {
      if (once) break;
      if (await interruptibleSleep(TICK_MS)) break;
      continue;
    }

    const task = queue[0];
    const result = await processTask(task);
    if (['complete', 'fail', 'quarantine'].includes(result)) {
      queue = queue.filter((entry) => entry.taskId !== task.taskId);
      sawTask = true;
    } else {
      // Requeued tasks stay in the queue with unchanged attempts; rotate to
      // avoid a single cooling model starving every other task.
      queue = [...queue.slice(1), queue[0]].filter(Boolean);
      if (result !== 'infra') sawTask = true;
    }
    if (once && sawTask) break;
    if (await interruptibleSleep(TICK_MS)) break;
  }

  await shutdown(0);
}

main().catch((error) => {
  log(`fatal controller error: ${error?.stack || error}`);
  process.exitCode = 78;
  void shutdown(78);
});

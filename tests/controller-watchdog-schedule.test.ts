import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCHEDULER = join(ROOT, 'scripts/controller-watchdog-scheduler.sh');
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-schedule-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function run(env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [SCHEDULER], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 });
}

function lines(file: string): string[] {
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
}

function fakeWatchdog(dir: string, body: string): string {
  const script = join(dir, 'fake-watchdog.sh');
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$(date +%s%3N)" >> "$FAKE_MARKER"\n${body}\n`);
  chmodSync(script, 0o755);
  return script;
}

describe('scripts/controller-watchdog-scheduler.sh', () => {
  it('executes the watchdog on real, timed intervals', () => {
    const dir = tempDir();
    const marker = join(dir, 'invocations.txt');
    const log = join(dir, 'schedule.jsonl');
    const script = fakeWatchdog(dir, 'printf \'{"decision":"SKIPPED_COOLDOWN","started":false,"success":false,"paidFallbackAttempted":false}\\n\'');
    const result = run({
      WATCHDOG_SCRIPT: script,
      WATCHDOG_SCHEDULE_INTERVAL_SECONDS: '0.12',
      WATCHDOG_SCHEDULE_TICKS: '3',
      WATCHDOG_SCHEDULE_LOG_FILE: log,
      FAKE_MARKER: marker,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.executedTicks).toBe(3);
    expect(summary.lastDecision).toBe('SKIPPED_COOLDOWN');
    expect(summary.stopReason).toBe('TICK_LIMIT');
    expect(summary.paidFallbackAttempted).toBe(false);

    const times = lines(marker).map(Number);
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(60);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(60);

    const entries = lines(log).map((line) => JSON.parse(line));
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.tick)).toEqual([1, 2, 3]);
    expect(entries.every((entry) => entry.started === false && entry.success === false)).toBe(true);
  });

  it('stops after the first bounded watchdog run', () => {
    const dir = tempDir();
    const marker = join(dir, 'invocations.txt');
    const counter = join(dir, 'counter.txt');
    const log = join(dir, 'schedule.jsonl');
    writeFileSync(counter, '0');
    const body = [
      'n=$(cat "$COUNTER_FILE"); n=$((n+1)); printf \'%s\' "$n" > "$COUNTER_FILE"',
      'if [ "$n" -ge 2 ]; then',
      '  printf \'{"decision":"RAN_ONCE","started":true,"success":false,"paidFallbackAttempted":false,"exitCode":1}\\n\'',
      'else',
      '  printf \'{"decision":"SKIPPED_COOLDOWN","started":false,"success":false,"paidFallbackAttempted":false,"exitCode":0}\\n\'',
      'fi',
    ].join('\n');
    const script = fakeWatchdog(dir, body);
    const result = run({
      WATCHDOG_SCRIPT: script,
      WATCHDOG_SCHEDULE_INTERVAL_SECONDS: '0.02',
      WATCHDOG_SCHEDULE_TICKS: '5',
      WATCHDOG_SCHEDULE_LOG_FILE: log,
      FAKE_MARKER: marker,
      COUNTER_FILE: counter,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.executedTicks).toBe(2);
    expect(summary.stopReason).toBe('BOUNDED_EXECUTION_COMPLETED');
    expect(lines(marker)).toHaveLength(2);
    expect(lines(log)).toHaveLength(2);
  });

  it('runs the real watchdog on a timetable without invoking --once during cooldown', () => {
    const dir = tempDir();
    const log = join(dir, 'schedule.jsonl');
    const fakeBin = join(dir, 'bin');
    const marker = join(dir, 'node-args.txt');
    const statusFile = join(dir, 'status.json');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'node'), [
      '#!/bin/sh',
      'case " $* " in',
      '  *" --once "*)',
      '    printf \'%s\\n\' "$*" > "$FAKE_NODE_MARKER"',
      '    exit 97',
      '    ;;',
      'esac',
      'exec "$REAL_NODE_BIN" "$@"',
      '',
    ].join('\n'));
    chmodSync(join(fakeBin, 'node'), 0o755);

    const future = Date.now() + 3_600_000;
    const cooldown = { until: future, untilMs: future, reason: 'GLOBAL_FREE_QUOTA' };
    writeFileSync(statusFile, JSON.stringify({
      version: 1,
      status: 'stopped',
      pauseReason: 'GLOBAL_FREE_QUOTA',
      resumeAt: future,
      updatedAt: new Date().toISOString(),
      heartbeatAgeSeconds: 3600,
      queueDepth: 5,
      resources: { ok: true },
      cooldowns: { models: { 'opencode/big-pickle': cooldown }, providers: { opencode: cooldown } },
    }));

    const result = run({
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      REAL_NODE_BIN: process.execPath,
      FAKE_NODE_MARKER: marker,
      CONTROLLER_STATUS_FILE: statusFile,
      SERVICES_DOTENV_FILE: 'none',
      WATCHDOG_SCHEDULE_INTERVAL_SECONDS: '0.1',
      WATCHDOG_SCHEDULE_TICKS: '2',
      WATCHDOG_SCHEDULE_LOG_FILE: log,
      WATCHDOG_MAX_LOAD_MULTIPLIER: '100',
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.executedTicks).toBe(2);
    expect(summary.lastDecision).toBe('SKIPPED_COOLDOWN');
    expect(summary.paidFallbackAttempted).toBe(false);
    expect(lines(log)).toHaveLength(2);
    expect(() => readFileSync(marker, 'utf8')).toThrow();
    expect(result.stdout).not.toContain('--once');
  });
});

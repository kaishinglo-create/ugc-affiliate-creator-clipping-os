import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'services-doctor-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runBash(script: string, args: string[], env: NodeJS.ProcessEnv, timeout = 30_000) {
  return spawnSync('bash', [script, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout });
}

function writeStatus(dir: string, overrides: Record<string, unknown> = {}) {
  const futureMs = Date.now() + 3_600_000;
  const cooldown = {
    until: new Date(futureMs).toISOString(),
    untilMs: futureMs,
    reason: 'GLOBAL_FREE_QUOTA',
  };
  const status = {
    version: 1,
    status: 'stopped',
    pauseReason: 'GLOBAL_FREE_QUOTA',
    resumeAt: futureMs,
    updatedAt: new Date().toISOString(),
    heartbeatAgeSeconds: 3_600,
    queueDepth: 5,
    resources: { ok: true },
    cooldowns: {
      models: { 'opencode/big-pickle': cooldown },
      providers: { opencode: cooldown },
    },
    ...overrides,
  };
  const file = join(dir, 'status.json');
  writeFileSync(file, JSON.stringify(status));
  return { file, status };
}

function doctorEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SERVICES_DOCTOR_PORTS;
  return { ...env, ...extra };
}

function parseJson(stdout: string): any {
  return JSON.parse(stdout);
}

describe('scripts/services.sh doctor', () => {
  it('reports whitelisted fields as JSON without printing secrets', () => {
    const dir = tempDir();
    const { file } = writeStatus(dir);
    const token = 'DOCTOR_SECRET_TOKEN_51f0c9a7b2d4';
    const result = runBash('scripts/services.sh', ['doctor'], doctorEnv({
      CONTROLLER_STATUS_FILE: file,
      SERVICES_DOTENV_FILE: 'none',
      SERVICES_DOCTOR_PORTS: 'skip',
      SERVICES_DOCTOR_DB_CHECK: '0',
      MECE_DASHBOARD_TOKEN: token,
      DATABASE_URL: `postgresql://user:${token}@127.0.0.1:5432/ugc`,
    }));

    expect(result.error).toBeUndefined();
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
    expect(result.status).toBe(0);

    const report = parseJson(result.stdout);
    expect(report.tool).toBe('services-doctor');
    expect(report.healthy).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(Object.keys(report.checks)).toEqual(['ports', 'controller', 'media', 'mece', 'database']);
    for (const check of Object.values(report.checks) as Array<{ healthy: boolean }>) {
      expect(typeof check.healthy).toBe('boolean');
    }

    expect(report.checks.controller).toMatchObject({
      status: 'stopped',
      pauseReason: 'GLOBAL_FREE_QUOTA',
      resumeAt: expect.any(Number),
      heartbeatAgeSeconds: expect.any(Number),
      queueDepth: 5,
      note: 'COOLDOWN_ACTIVE',
      healthy: true,
    });
    expect(report.checks.controller).not.toHaveProperty('completed');
    expect(report.checks.controller).not.toHaveProperty('owner');

    expect(report.checks.media.ffmpeg).toHaveProperty('status');
    expect(report.checks.media.ffprobe).toHaveProperty('status');
    expect(report.checks.media.whisperBinary).toHaveProperty('status');
    expect(report.checks.media.whisperModel).toHaveProperty('status');

    expect(report.checks.mece.tokenConfigured).toBe(true);
    expect(report.checks.mece).not.toHaveProperty('token');
    expect(report.checks.database.status).toBe('SKIPPED');
    expect(report.checks.database).not.toHaveProperty('url');
  });

  it('checks all three ports with explicit listening and HTTP fields', () => {
    const dir = tempDir();
    const { file } = writeStatus(dir);
    const result = runBash('scripts/services.sh', ['doctor'], doctorEnv({
      CONTROLLER_STATUS_FILE: file,
      SERVICES_DOTENV_FILE: 'none',
      SERVICES_DOCTOR_DB_CHECK: '0',
      MECE_DASHBOARD_TOKEN: 'doctor-port-check-token',
    }));

    expect(result.error).toBeUndefined();
    const report = parseJson(result.stdout);
    expect(report.checks.ports.services).toHaveLength(3);
    expect(report.checks.ports.services.map((service: any) => service.name)).toEqual(['ugc', 'control', 'browser']);
    expect(report.checks.ports.services.map((service: any) => service.port)).toEqual([3000, 3031, 3200]);
    for (const service of report.checks.ports.services) {
      expect(typeof service.listening).toBe('boolean');
      expect(service.httpStatus === null || typeof service.httpStatus === 'number').toBe(true);
      expect(typeof service.healthy).toBe('boolean');
    }
  });

  it('marks absent optional configuration as NOT_CONFIGURED with healthy flags', () => {
    const dir = tempDir();
    const { file } = writeStatus(dir);
    const result = runBash('scripts/services.sh', ['doctor'], doctorEnv({
      CONTROLLER_STATUS_FILE: file,
      SERVICES_DOTENV_FILE: 'none',
      SERVICES_DOCTOR_PORTS: 'skip',
      SERVICES_DOCTOR_DB_CHECK: '0',
      MECE_DASHBOARD_TOKEN: '',
      DATABASE_URL: '',
    }));

    expect(result.error).toBeUndefined();
    const report = parseJson(result.stdout);
    expect(report.checks.mece.status).toBe('NOT_CONFIGURED');
    expect(report.checks.mece.tokenConfigured).toBe(false);
    expect(report.checks.database.status).toBe('NOT_CONFIGURED');
    expect(report.checks.database.configured).toBe(false);
    expect(report.checks.database.reachable).toBeNull();
    expect(report.exitCode).toBe(report.healthy ? 0 : 1);
    for (const check of Object.values(report.checks) as Array<{ healthy: boolean }>) {
      expect(typeof check.healthy).toBe('boolean');
    }
  });
});

describe('scripts/controller-watchdog.sh', () => {
  function watchdogEnv(dir: string, statusFile: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const fakeBin = join(dir, 'bin');
    const marker = join(dir, 'node-args.txt');
    const fakeNode = join(fakeBin, 'node');
    const fakeNodeSource = [
      '#!/bin/sh',
      'case " $* " in',
      '  *" --once "*)',
      '    printf \'%s\\n\' "$*" > "$FAKE_NODE_MARKER"',
      '    exit 97',
      '    ;;',
      'esac',
      'exec "$REAL_NODE_BIN" "$@"',
      '',
    ].join('\n');

    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeNode, fakeNodeSource);
    chmodSync(fakeNode, 0o755);

    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_BIN;
    return {
      ...env,
      PATH: `${fakeBin}:${env.PATH ?? ''}`,
      REAL_NODE_BIN: process.execPath,
      FAKE_NODE_MARKER: marker,
      CONTROLLER_STATUS_FILE: statusFile,
      WATCHDOG_HEARTBEAT_MIN_AGE_SECONDS: '60',
      // Test hosts can be busy from parallel agents; the default gate stays 2x CPUs.
      WATCHDOG_MAX_LOAD_MULTIPLIER: '100',
      ...extra,
    };
  }

  it('reports SKIPPED_COOLDOWN and never invokes --once while resumeAt is in the future', () => {
    const dir = tempDir();
    const { file, status } = writeStatus(dir);
    expect(Number(status.resumeAt)).toBeGreaterThan(Date.now());
    const env = watchdogEnv(dir, file);
    const result = runBash('scripts/controller-watchdog.sh', [], env);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const report = parseJson(result.stdout);
    expect(report.decision).toBe('SKIPPED_COOLDOWN');
    expect(report.started).toBe(false);
    expect(report.success).toBe(false);
    expect(report.paidFallbackAttempted).toBe(false);
    expect(report.details.pauseReason).toBe('GLOBAL_FREE_QUOTA');
    expect(report.details.blockedCooldownCount).toBeGreaterThan(0);
    expect(result.stdout).not.toContain('--once');

    const marker = env.FAKE_NODE_MARKER as string;
    expect(() => readFileSync(marker, 'utf8')).toThrow();

    // Static guard: the bounded run is only reachable after the skip branch.
    const source = readFileSync(join(ROOT, 'scripts/controller-watchdog.sh'), 'utf8');
    const guardAt = source.indexOf('if [ "$decision" != ALLOW_ONCE ]');
    const onceAt = source.indexOf('scripts/autonomous-controller.mjs --once');
    expect(guardAt).toBeGreaterThan(-1);
    expect(onceAt).toBeGreaterThan(guardAt);
    expect(source).not.toMatch(/nohup[^\n]*--once/);
  });

  it('allows at most one bounded --once after the cooldown, with proof from status/journal', () => {
    const dir = tempDir();
    const { file } = writeStatus(dir, {
      resumeAt: Date.now() - 60_000,
      cooldowns: { models: {}, providers: {} },
    });
    const env = watchdogEnv(dir, file);
    const result = runBash('scripts/controller-watchdog.sh', [], env);

    expect(result.error).toBeUndefined();
    const report = parseJson(result.stdout);
    expect(report.decision).toBe('RAN_ONCE');
    expect(report.started).toBe(true);
    expect(report.details.cooldownExpired === true || report.details.pauseReason !== 'GLOBAL_FREE_QUOTA').toBe(true);
    expect(report.exitCode).toBe(97);
    expect(report.success).toBe(false);
    expect(report.after.status).toBe('stopped');
    expect(report.paidFallbackAttempted).toBe(false);

    // The fake node records invocations; no real controller/model process ran.
    const calls = readFileSync(env.FAKE_NODE_MARKER as string, 'utf8').trim().split(/\r?\n/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--once');
  });
});

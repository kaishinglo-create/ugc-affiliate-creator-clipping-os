import 'dotenv/config';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname;
const CONTROL_PORT = Number(process.env.MECE_TEST_CONTROL_PORT || 3131);
const OPENCODE_PORT = Number(process.env.MECE_TEST_OPENCODE_PORT || 4097);
const BASE = `http://127.0.0.1:${CONTROL_PORT}`;
const TOKEN = String(process.env.MECE_DASHBOARD_TOKEN || '').trim();

describe('MECE control-center chat runtime', () => {
  let child: ChildProcess | null = null;
  let stderr = '';

  beforeAll(async () => {
    expect(TOKEN.length).toBeGreaterThanOrEqual(32);
    expect(Number.isInteger(CONTROL_PORT)).toBe(true);
    expect(Number.isInteger(OPENCODE_PORT)).toBe(true);

    // The configurable port must be free. This test never kills a foreign
    // process and never starts a model request.
    let occupied = false;
    try {
      await fetch(`http://127.0.0.1:${OPENCODE_PORT}/api/session`, {
        signal: AbortSignal.timeout(1_000),
      });
      occupied = true;
    } catch { /* free */ }
    expect(occupied, `port ${OPENCODE_PORT} must be free for this test`).toBe(false);

    child = spawn(process.execPath, ['--env-file=.env', '.mece-control/server.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        MECE_CONTROL_PORT: String(CONTROL_PORT),
        MECE_OPENCODE_PORT: String(OPENCODE_PORT),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        // /api/chat/model is a lightweight authenticated readiness route;
        // /api/chat/state spawns `opencode --version` and can be slow under load.
        const response = await fetch(`${BASE}/api/chat/model`, {
          headers: { 'x-control-token': TOKEN },
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return;
      } catch { /* server still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`MECE test server did not start: ${stderr.slice(0, 500)}`);
  }, 60_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    // Only clean up the exact test-owned OpenCode child on the configured port.
    try {
      const sockets = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' });
      const line = sockets.split(/\r?\n/).find((entry) => entry.includes(`:${OPENCODE_PORT} `));
      const match = line?.match(/pid=(\d+)/);
      const args = match ? execFileSync('ps', ['-p', match[1], '-o', 'args='], { encoding: 'utf8' }) : '';
      if (match && args.includes(`--port=${OPENCODE_PORT}`) && args.includes('opencode serve')) {
        process.kill(Number(match[1]), 'SIGTERM');
      }
    } catch { /* no listener or ss unavailable */ }
  });

  it('uses the configured port and establishes an authenticated OpenCode session', async () => {
    const before = await fetch(`${BASE}/api/chat/state`, {
      headers: { 'x-control-token': TOKEN },
    });
    expect(before.status).toBe(200);
    const initial = await before.json();
    expect(initial.port).toBe(OPENCODE_PORT);
    expect(initial.startedOnPort).toBe(CONTROL_PORT);
    expect(initial.url).toBeNull();
    expect(initial.startupError).toBeNull();

    // Session listing is a real OpenCode HTTP request without a model call.
    // It forces the lazy probe that must detect the running instance.
    const sessions = await fetch(`${BASE}/api/chat/sessions`, {
      headers: { 'x-control-token': TOKEN },
    });
    const sessionsBody = await sessions.json();
    expect(sessions.status, JSON.stringify(sessionsBody).slice(0, 500)).toBe(200);
    expect(Array.isArray(sessionsBody.sessions)).toBe(true);

    const after = await fetch(`${BASE}/api/chat/state`, {
      headers: { 'x-control-token': TOKEN },
    });
    const state = await after.json();
    expect(state.port).toBe(OPENCODE_PORT);
    expect(state.url).toBe(`http://127.0.0.1:${OPENCODE_PORT}`);
    expect(typeof state.reusedExisting).toBe('boolean');
    expect(state.startupError).toBeNull();
    expect(JSON.stringify(state)).not.toContain(TOKEN);
  }, 30_000);

  it('validates chat agent/model selection without issuing a model request', async () => {
    const unauth = await fetch(`${BASE}/api/chat/model`, {
      headers: { 'x-control-token': 'invalid-token-that-is-long-enough-000' },
    });
    expect(unauth.status).toBe(401);

    const modelResponse = await fetch(`${BASE}/api/chat/model`, {
      headers: { 'x-control-token': TOKEN },
    });
    expect(modelResponse.status).toBe(200);
    const modelState = await modelResponse.json();
    expect(modelState.available.length).toBeGreaterThan(0);
    expect(modelState.available.every((model: string) => model.startsWith('opencode/'))).toBe(true);
    expect(modelState.available).toContain(modelState.model);

    const rejected = await fetch(`${BASE}/api/chat/message`, {
      method: 'POST',
      headers: { 'x-control-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionID: 'bad/session', text: 'no model call', model: modelState.model }),
    });
    expect(rejected.status).toBe(400);

    const disallowed = await fetch(`${BASE}/api/chat/message`, {
      method: 'POST',
      headers: { 'x-control-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionID: 'valid-session', text: 'no model call', model: 'openai/gpt-4o' }),
    });
    expect(disallowed.status).toBe(400);
  }, 30_000);
});

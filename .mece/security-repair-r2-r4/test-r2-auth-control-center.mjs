import { spawn } from 'node:child_process';
import process from 'node:process';

const TOKEN = 'a'.repeat(40);
const PORT = 3031; // server fixed
const CHILD = spawn(process.execPath, ['.mece-control/server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, MECE_DASHBOARD_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,
});

let output = '';
CHILD.stdout.on('data', (d) => output += d.toString());
CHILD.stderr.on('data', (d) => output += d.toString());

async function waitForServer () {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await request('/api/bootstrap').then(() => true).catch(() => false)) return;    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('control center did not become ready');
}

async function request (path, { method='GET', origin, token } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };}

async function cleanup () {
  return new Promise((resolve) => {
    CHILD.kill('SIGTERM');
    CHILD.on('close', resolve);
    setTimeout(resolve, 3000);
  });
}

try {
  await waitForServer();

  const noToken = await request('/api/bootstrap');
  if (noToken.status !== 401) throw new Error(`missing token: expected 401, got ${noToken.status}`);

  const badToken = await request('/api/bootstrap', { token: 'b'.repeat(40) });
  if (badToken.status !== 401) throw new Error(`bad token: expected 401, got ${badToken.status}`);

  const good = await request('/api/bootstrap', { token: TOKEN });
  if (good.status !== 200 || good.json?.dashboardAuthEnabled !== true) throw new Error(`good token: unexpected response ${good.status}`);

  const badOrigin = await request('/api/bootstrap', { token: TOKEN, origin: 'https://evil.example' });
  if (badOrigin.status !== 403) throw new Error(`bad origin: expected 403, got ${badOrigin.status}`);

  const missingOriginGood = await request('/api/bootstrap', { token: TOKEN });
  if (missingOriginGood.status !== 200) throw new Error(`allowed originless: expected 200, got ${missingOriginGood.status}`);

  const shell = await request('/');
  if (shell.status !== 200) throw new Error(`shell expected 200, got ${shell.status}`);

  const config = await request('/api/config', { token: TOKEN });
  if (config.status !== 200) throw new Error(`protected config GET expected 200, got ${config.status}`);

  console.log('R2 auth control-center checks: PASS (6/6 assertions)');
} catch (error) {
  console.error('R2 auth control-center checks: FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  process.stderr.write(output);
  await cleanup();
  process.exitCode = 1;
} finally {
  if (CHILD.exitCode == null) await cleanup();
}

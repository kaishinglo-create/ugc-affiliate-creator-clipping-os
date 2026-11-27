// Reproducible Playwright entry point. Loads local configuration without
// printing secrets, starts only the missing loopback services, runs the suite
// from the repo root and stops only the services it started itself.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
if (existsSync(envFile)) loadDotenv({ path: envFile, quiet: true });

for (const name of ['DATABASE_URL', 'SESSION_JWT_SECRET', 'MECE_DASHBOARD_TOKEN']) {
  if (!process.env[name]) {
    console.error(`[e2e] ${name} is required in the environment or .env.`);
    process.exit(2);
  }
}

const playwrightCli = [
  join(root, 'browser-runtime-host/node_modules/playwright/cli.js'),
  join(root, 'node_modules/playwright/cli.js'),
].find(existsSync);
if (!playwrightCli) {
  console.error('[e2e] Playwright CLI not found; install it under browser-runtime-host.');
  process.exit(2);
}

const services = [
  { name: 'ugc', url: 'http://127.0.0.1:3000/health' },
  { name: 'control', url: 'http://127.0.0.1:3031/' },
];
const started = [];

function run(command, args) {
  return spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
}

async function reachable(url, timeoutMs = 2000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(url)) return true;
    await new Promise((done) => setTimeout(done, 500));
  }
  return reachable(url);
}

async function cleanup() {
  for (const name of started.reverse()) {
    run('bash', ['scripts/services.sh', 'stop', name]);
    const service = services.find((entry) => entry.name === name);
    if (!service) continue;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await reachable(service.url))) {
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  started.length = 0;
}

async function main() {
  for (const service of services) {
    if (await reachable(service.url)) continue;
    const result = run('bash', ['scripts/services.sh', 'start', service.name]);
    if (result.status !== 0) throw new Error(`could not start ${service.name}`);
    started.push(service.name);
    if (!(await waitFor(service.url))) throw new Error(`${service.name} did not become ready`);
  }

  const child = spawn(
    process.execPath,
    [playwrightCli, 'test', '--config=playwright.config.ts', ...process.argv.slice(2)],
    { cwd: root, stdio: 'inherit', env: process.env },
  );
  const forwardSignal = (signal) => { child.kill(signal); };
  process.once('SIGINT', forwardSignal);
  process.once('SIGTERM', forwardSignal);
  const code = await new Promise((done) => {
    child.once('error', () => done(1));
    child.once('exit', (exitCode, signal) => done(signal ? 1 : (exitCode ?? 1)));
  });
  process.removeListener('SIGINT', forwardSignal);
  process.removeListener('SIGTERM', forwardSignal);
  return code;
}

try {
  const code = await main();
  await cleanup();
  process.exit(code);
} catch (error) {
  console.error(`[e2e] ${error instanceof Error ? error.message : String(error)}`);
  await cleanup();
  process.exit(2);
}

/**
 * Reproducible 27-check MECE browser check (Phase G final acceptance).
 * Run from repo root with:
 *   node --env-file=.env scripts/phase-g-mece-browsercheck.mjs
 * or: npm run verify:mece-browser
 *
 * Requires a local UGC service (:3000) and MECE control center (:3031).
 * Override with UGC_BASE / MECE_BASE. The dashboard token is read from the
 * environment only, is never printed, and is redacted from failures.
 */
import { chromium } from '../browser-runtime-host/node_modules/playwright/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.MECE_BASE || 'http://127.0.0.1:3031';
const UGC = process.env.UGC_BASE || 'http://127.0.0.1:3000';
const OUT = process.env.PHASE_G_EVIDENCE_DIR || join(tmpdir(), 'ugc-phase-g-mece-browsercheck');
const TOKEN = String(process.env.MECE_DASHBOARD_TOKEN || '').trim();
if (TOKEN.length < 32) throw new Error('MECE_DASHBOARD_TOKEN missing/too short');
await mkdir(OUT, { recursive: true });

let passed = 0;
const failures = [];
const redact = (value) => String(value).replaceAll(TOKEN, '[REDACTED]');
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = redact(String(error?.message || error).split('\n')[0]);
    failures.push({ name, message });
    console.log(`FAIL ${name}: ${message}`);
  }
}
const ok = (condition, message) => { if (!condition) throw new Error(message); };
async function json(path, token = '') {
  const response = await fetch(BASE + path, { headers: token ? { 'x-control-token': token } : {} });
  return { status: response.status, body: response.ok ? await response.json() : null };
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
try {
  const bootstrap = await json('/api/bootstrap', TOKEN);
  const root = await fetch(BASE + '/');
  const tasks = await json('/api/tasks', TOKEN);

  await check('01 control center root returns HTTP 200', async () => ok(root.status === 200, `HTTP ${root.status}`));
  await check('02 /api/status is 401 without token', async () => ok((await json('/api/status')).status === 401, 'not 401'));
  await page.goto(BASE + '/');
  await check('03 login panel visible before authentication', async () => ok(await page.locator('#login').isVisible(), 'login hidden'));
  await check('04 token input visible before authentication', async () => ok(await page.locator('#tokenInput').isVisible(), 'input hidden'));
  await check('05 unlock heading rendered', async () => ok((await page.getByRole('heading', { name: 'Control Center freischalten' }).count()) === 1, 'heading missing'));
  const rawHtml = await root.text();
  await check('06 served HTML contains no token value', async () => ok(!rawHtml.includes(TOKEN), 'token in HTML'));

  await page.locator('#tokenInput').fill('wrong-token-000000000000000000000000000000');
  await page.locator('#tokenSave').click();
  await page.waitForTimeout(1500);
  await check('07 wrong token keeps login visible', async () => ok(await page.locator('#login').isVisible(), 'login disappeared'));
  await check('08 wrong token produces visible error', async () => ok(/ungueltig|verweigert|token|401|freischaltung/i.test(await page.locator('#tokenStatus').innerText()), 'no error text'));
  await check('09 rejected token is not persisted in sessionStorage', async () => ok((await page.evaluate(() => sessionStorage.getItem('mece_control_token'))) === null, 'token persisted'));
  await check('10 /api/status is 401 with wrong token', async () => ok((await json('/api/status', 'wrong-token-000000000000000000000000000000')).status === 401, 'not 401'));

  await page.locator('#tokenInput').fill(TOKEN);
  await page.locator('#tokenSave').click();
  await page.locator('#login').waitFor({ state: 'hidden', timeout: 30_000 });
  await check('11 valid token unlocks dashboard', async () => ok(!(await page.locator('#login').isVisible()), 'login still visible'));
  await check('12 controller status shown in header', async () => ok((await page.locator('#state').innerText()).includes('Controller:'), 'status missing'));
  await check('13 project path from real bootstrap shown', async () => ok((await page.locator('#projectHead').innerText()).includes(bootstrap.body.config.projectPath), 'project path missing'));
  await check('14 UGC reachability derived from runtime', async () => ok((await page.locator('#projectHead').innerText()).includes(bootstrap.body.ugc.reachable ? 'UGC online' : 'UGC offline'), 'ugc status missing'));
  const renderedHtml = await page.content();
  await check('15 rendered DOM contains no token value', async () => ok(!renderedHtml.includes(TOKEN), 'token in DOM'));
  await check('16 visible text contains no token value', async () => ok(!(await page.locator('body').innerText()).includes(TOKEN), 'token in text'));
  await check('17 accepted token lives in sessionStorage only', async () => ok(Boolean(await page.evaluate(() => sessionStorage.getItem('mece_control_token'))), 'no session token'));

  const tabNames = ['agents', 'automations', 'mcp', 'chat', 'tasks', 'runs', 'settings'];
  for (const [index, name] of tabNames.entries()) {
    await check(`${String(18 + index).padStart(2, '0')} ${name} tab renders a non-empty panel`, async () => {
      const button = page.locator(`button.tab[data-tab="${name}"]`);
      await button.click();
      const panel = page.locator(`section.panel#${name}`);
      ok(await button.isVisible(), 'button not visible');
      ok(await panel.isVisible(), 'panel not visible');
      ok((await panel.innerText()).trim().length > 0, 'panel empty');
    });
  }
  await check('25 chat models are free-only and populated', async () => {
    await page.locator('button.tab[data-tab="chat"]').click();
    const options = await page.locator('#chatModel option').allTextContents();
    ok(options.length >= 10, `only ${options.length} models`);
    ok(options.every((model) => model.startsWith('opencode/')), 'non-free model offered');
  });
  await check('26 /api/tasks reflects journal and controller state', async () => {
    ok(tasks.body.source === 'journal', `source=${tasks.body.source}`);
    ok(tasks.body.controller.status === bootstrap.body.controller.status, 'controller status mismatch');
    ok(tasks.body.controller.updatedAt === bootstrap.body.controller.updatedAt, 'updatedAt mismatch');
  });
  await check('27 UGC dashboard is reachable and links the control center', async () => {
    const response = await fetch(UGC + '/');
    ok(response.status === 200, `UGC HTTP ${response.status}`);
    ok((await response.text()).includes(`href="${BASE}/"`), 'no control link');
  });
} finally {
  await browser.close();
}
const result = { at: new Date().toISOString(), checks: 27, passed, failed: failures.length, failures };
await writeFile(join(OUT, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`RESULT ${passed}/27 (failed ${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);

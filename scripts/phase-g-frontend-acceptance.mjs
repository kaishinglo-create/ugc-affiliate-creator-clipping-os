/**
 * Phase G final frontend acceptance: all 15 UGC tabs in a real browser.
 * Run from repo root with:
 *   node scripts/phase-g-frontend-acceptance.mjs
 * or: npm run verify:frontend
 *
 * Requires a local UGC service (:3000); override with UGC_BASE. A throwaway
 * workspace is created through the real signup form with a synthetic
 * @example.test identity. No secret or credential is printed or written.
 */
import { chromium } from '../browser-runtime-host/node_modules/playwright/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.UGC_BASE || 'http://127.0.0.1:3000';
const OUT = process.env.PHASE_G_EVIDENCE_DIR || join(tmpdir(), 'ugc-phase-g-frontend-acceptance');
await mkdir(OUT, { recursive: true });
const suffix = randomUUID().replace(/-g/g, '').slice(0, 10);
const email = `phaseg-ui-${suffix}@example.test`;
const password = `PhaseG-${suffix}-pw`;
const slug = `phaseg-ui-${suffix}`;
const tabs = [
  ['overview', 'Overview'], ['radar', 'Product Radar'], ['creators', 'Creators'],
  ['campaigns', 'Campaigns'], ['scripts', 'Script Studio'], ['clipping', 'Clipping Studio'],
  ['youtube', 'YouTube Intelligence'], ['phaseg', 'Phase G Studio'], ['content', 'Content Factory'],
  ['calendar', 'Publishing Calendar'], ['analytics', 'Analytics & Revenue'], ['agents', 'Agent Control'],
  ['integrations', 'Integrations'], ['api-integrations', 'API Integration Center'], ['agent-browser', 'Agent Browser'],
];
const ok = (condition, message) => { if (!condition) throw new Error(message); };
const results = [];
const failures = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) {
    const message = String(error?.message || error).split('\n')[0];
    results.push({ name, status: 'FAIL', message });
    failures.push({ name, message });
    console.log(`FAIL ${name}: ${message}`);
  }
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(String(error.message)));
page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('401 (Unauthorized)')) consoleErrors.push(message.text()); });
try {
  await page.goto(BASE + '/');
  await check('01 unauthenticated app renders login form', async () => {
    ok(await page.locator('#show-signup').isVisible(), 'signup link missing');
  });
  await page.locator('#show-signup').click();
  await page.locator('#signup-form input[name="email"]').fill(email);
  await page.locator('#signup-form input[name="password"]').fill(password);
  await page.locator('#signup-form input[name="name"]').fill('Phase G UI');
  await page.locator('#signup-form input[name="workspaceName"]').fill('Phase G UI');
  await page.locator('#signup-form input[name="workspaceSlug"]').fill(slug);
  await page.locator('#signup-form button[type="submit"]').click();
  await page.locator('#page .heading h1').first().waitFor({ timeout: 20_000 });

  await check('02 badge reports workspace data, not live data', async () => {
    await page.waitForFunction(() => {
      const badge = document.querySelector('#live-badge');
      return badge && !badge.textContent.includes('LOADING');
    }, undefined, { timeout: 15_000 });
    const badge = (await page.locator('#live-badge').innerText()).trim();
    ok(badge === '● WORKSPACE DATA', `badge=${badge}`);
  });

  for (const [index, [view, title]] of tabs.entries()) {
    await check(`${String(index + 3).padStart(2, '0')} tab ${view} renders real ${title} view`, async () => {
      await page.locator(`button.nav[data-view="${view}"]`).click();
      await page.waitForFunction((expected) => {
        const crumb = document.querySelector('#crumb');
        const heading = document.querySelector('#page h1');
        const badge = document.querySelector('#live-badge');
        return crumb && heading && badge && crumb.textContent.trim() === expected
          && heading.textContent.trim().length > 0 && !badge.textContent.includes('LOADING');
      }, title, { timeout: 15_000 });
      const text = await page.locator('#page').innerText();
      const badge = (await page.locator('#live-badge').innerText()).trim();
      ok(text.length > 40, 'view body empty');
      ok(!/DEMO DATA|Demo mode|offline demo|● LIVE DATA/.test(text), 'misleading demo/live label');
      ok(badge === '● WORKSPACE DATA' || (badge === '● STALE DATA' && text.includes('Data could not be refreshed')), `badge=${badge}`);
    });
  }

  await check('18 Phase G honesty notices are present', async () => {
    await page.locator('button.nav[data-view="phaseg"]').click();
    const text = await page.locator('#page').innerText();
    ok(text.includes('operator assertion, not as proof of verified rights'), 'rights notice missing');
    ok(text.includes('Auto clip ranking sends no highlights and returns an empty ranking'), 'ranking notice missing');
    ok(await page.locator('#phaseg-srt').count() === 1, 'SRT input missing');
  });
  await check('19 no browser page errors during full tab tour', async () => {
    ok(consoleErrors.length === 0, `${consoleErrors.length} error(s): ${consoleErrors[0] || ''}`);
  });
} finally {
  await browser.close();
}
const result = { at: new Date().toISOString(), checks: results.length, passed: results.length - failures.length, failures, results };
await writeFile(join(OUT, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`RESULT ${result.passed}/${result.checks}`);
process.exit(failures.length === 0 ? 0 : 1);

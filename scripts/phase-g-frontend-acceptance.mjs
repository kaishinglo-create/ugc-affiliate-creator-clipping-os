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

  await check('19 Phase H calendar shows publishing plans, queue, approvals and adapters', async () => {
    await page.locator('button.nav[data-view="calendar"]').click();
    for (const id of ['h5-publishing-queue', 'h5-publishing-schedules', 'h5-publishing-approvals', 'h5-publishing-adapters', 'h5-verification']) {
      ok(await page.locator(`[data-testid="${id}"]`).count() === 1, `${id} missing`);
    }
    const verification = await page.locator('[data-testid="h5-verification"]').innerText();
    ok(verification.includes('LOCAL_IMPLEMENTED'), 'LOCAL_IMPLEMENTED missing');
    ok(verification.includes('EXTERNAL_LIVE_VERIFIED: NONE'), 'external verification not separated');
  });
  await check('20 Phase H agents view reuses the publishing status panels', async () => {
    await page.locator('button.nav[data-view="agents"]').click();
    ok(await page.locator('[data-testid="h5-publishing-queue"]').count() === 1, 'queue panel missing in agents');
  });
  await check('21 Phase H analytics shows truth-first affiliate revenue and sources', async () => {
    await page.locator('button.nav[data-view="analytics"]').click();
    for (const id of ['h5-affiliate-revenue', 'h5-affiliate-links', 'h5-analytics-sources']) {
      ok(await page.locator(`[data-testid="${id}"]`).count() === 1, `${id} missing`);
    }
    const text = await page.locator('[data-testid="h5-affiliate-summary"]').innerText();
    ok(text.includes('Only real supplied commissions'), 'commission honesty notice missing');
  });
  await check('22 Phase H campaigns cross-links revenue without adding a tab', async () => {
    await page.locator('button.nav[data-view="campaigns"]').click();
    ok(await page.locator('[data-testid="h5-campaign-affiliate-links"]').count() === 1, 'campaign links panel missing');
    ok(await page.locator('[data-testid="h5-campaign-revenue-link"]').count() === 1, 'revenue cross-link missing');
    ok(await page.locator('button.nav[data-view]').count() === 15, 'unexpected new tab');
  });
  await check('23 no browser page errors during full tab tour', async () => {
    ok(consoleErrors.length === 0, `${consoleErrors.length} error(s): ${consoleErrors[0] || ''}`);
  });
} finally {
  await browser.close();
}
const result = { at: new Date().toISOString(), checks: results.length, passed: results.length - failures.length, failures, results };
await writeFile(join(OUT, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`RESULT ${result.passed}/${result.checks}`);
process.exit(failures.length === 0 ? 0 : 1);

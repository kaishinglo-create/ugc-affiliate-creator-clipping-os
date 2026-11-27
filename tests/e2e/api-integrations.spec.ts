// @ts-expect-error Playwright is installed only under browser-runtime-host.
import { test, expect } from '../../browser-runtime-host/node_modules/playwright/test.mjs';
import { randomUUID } from 'node:crypto';

type Fixtures = { page: any };

const UGC_BASE = 'http://127.0.0.1:3000';

async function fetchWithRetry(url: string, init: RequestInit = {}): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

type Session = { cookie: string; workspaceId: string };

async function createSession(): Promise<Session> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const email = `e2e-api-integrations-${suffix}@example.test`;
  const password = `E2E-Api-${suffix}-pw`;
  const workspaceSlug = `e2e-api-integrations-${suffix}`;
  const response = await fetchWithRetry(`${UGC_BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'E2E API', workspaceName: 'E2E API', workspaceSlug }),
  });
  expect(response.status).toBe(201);
  const body = await response.json();
  return { cookie: (response.headers.get('set-cookie') || '').split(';')[0], workspaceId: body.workspace.id };
}

async function api(path: string, session: Session): Promise<any> {
  const response = await fetchWithRetry(`${UGC_BASE}${path}`, {
    headers: { cookie: session.cookie, 'x-workspace-id': session.workspaceId },
  });
  expect(response.status).toBe(200);
  return response.json();
}

test('API Integration Center renders real provider data without secrets', async ({ page }: Fixtures) => {
  const session = await createSession();
  try {
    const registry = await api('/api/api-integrations', session);
    expect(registry.providers.length).toBeGreaterThanOrEqual(14);
    expect(registry.providers.every((p: any) => p.connection.status !== 'CONNECTED')).toBe(true);

    const separator = session.cookie.indexOf('=');
    await page.context().addCookies([{
      name: session.cookie.slice(0, separator),
      value: session.cookie.slice(separator + 1),
      url: UGC_BASE,
    }]);
    await page.goto(`${UGC_BASE}/`);
    await expect(page.locator('#login')).toBeHidden();
    // boot() finishes with an async loadView('overview') that can replace the
    // DOM after a nav click. Wait until that initial load has settled.
    await expect(page.locator('#crumb')).toHaveText('Overview');
    await page.waitForLoadState('networkidle');

    const nav = page.locator('button.nav[data-view="api-integrations"]');
    await expect(nav).toBeVisible();
    await nav.click();
    await expect(page.locator('#crumb')).toHaveText('API Integration Center');
    const cards = page.locator('article.card[data-provider]');
    // The view title renders before the provider data resolves; wait for the
    // first real card instead of racing the async load (assertion unchanged).
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBe(registry.providers.length);
    await expect(page.locator('body')).toContainText('CONNECTED is shown only after a successful official API call');
    await expect(page.locator('button[data-action="api-integration-test"]').first()).toBeVisible();

    await page.locator('button[data-action="api-integration-detail"][data-provider="youtube_google"]').click();
    await expect(page.locator('#page')).toContainText('Google Cloud / YouTube Data API');
    await expect(page.locator('#page')).toContainText('Manual steps');
    await expect(page.locator('#page')).toContainText('Required permissions');
    await expect(page.locator('#page')).toContainText('Developer portal');

    const rendered = await page.content();
    expect(rendered.includes('client_secret='), 'rendered page must not include secrets').toBe(false);
    expect(rendered.includes('Bearer '), 'rendered page must not include bearer tokens').toBe(false);
  } finally {
    await fetchWithRetry(`${UGC_BASE}/api/auth/logout`, { method: 'POST', headers: { cookie: session.cookie, 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
  }
});

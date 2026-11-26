// Playwright is installed only under browser-runtime-host, not in this
// project's node_modules. Import its public ./test entry point directly.
// @ts-expect-error Playwright has no declaration at this relative path.
import { test, expect } from '../../browser-runtime-host/node_modules/playwright/test.mjs';
// The controller's queue replay is plain JavaScript from the live app.
import { replayQueue } from '../../scripts/controller-core.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

type Fixtures = { page: any };

const MECE_BASE = 'http://127.0.0.1:3031';
const UGC_BASE = 'http://127.0.0.1:3000';
const DASHBOARD_TOKEN = String(process.env.MECE_DASHBOARD_TOKEN || '').trim();

function requiredToken(): string {
  if (!DASHBOARD_TOKEN) {
    throw new Error('MECE_DASHBOARD_TOKEN is missing; run Playwright with node --env-file=.env');
  }
  return DASHBOARD_TOKEN;
}

// Plain fetch keeps credentials in headers that are never echoed by
// Playwright's APIRequestContext call log.
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

async function controlGet(path: string): Promise<any> {
  const response = await fetchWithRetry(`${MECE_BASE}${path}`, {
    headers: { 'x-control-token': requiredToken() },
  });
  if (!response.ok) throw new Error(`MECE ${path} returned HTTP ${response.status}`);
  return response.json();
}

async function fetchBootstrap(): Promise<any> {
  const bootstrap = await controlGet('/api/bootstrap');
  expect(bootstrap.version).toMatch(/\d/);
  expect(bootstrap.ugc && typeof bootstrap.ugc.reachable === 'boolean').toBeTruthy();
  expect(bootstrap.controller && typeof bootstrap.controller.status === 'string').toBeTruthy();
  return bootstrap;
}

async function unlockDashboard(page: any): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#tokenInput')).toBeVisible();
  await page.locator('#tokenInput').fill(requiredToken());
  await page.locator('#tokenSave').click();
  await expect(page.locator('#login')).toBeHidden();
  await expect(page.locator('#state')).toContainText(/Controller:|Bereit/);
}

type UgcSession = { cookie: string; workspaceId: string; email: string; password: string };

async function createUgcSession(): Promise<UgcSession> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const email = `e2e-control-${suffix}@example.test`;
  const password = `E2E-control-${suffix}-pw`;
  const workspaceSlug = `e2e-control-${suffix}`;
  const response = await fetchWithRetry(`${UGC_BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'E2E Control', workspaceName: 'E2E Control', workspaceSlug }),
  });
  expect(response.status, 'signup should establish a workspace session').toBe(201);
  const body = await response.json();
  const workspaceId = body.workspace.id as string;
  expect(workspaceId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  return { cookie: (response.headers.get('set-cookie') || '').split(';')[0], workspaceId, email, password };
}

async function ugcGet(path: string, cookie = '', workspaceId = ''): Promise<Response> {
  return fetchWithRetry(`${UGC_BASE}${path}`, {
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
    },
  });
}

async function ugcPost(path: string, body: unknown, cookie = ''): Promise<Response> {
  return fetchWithRetry(`${UGC_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function ugcLogout(session: UgcSession): Promise<void> {
  await ugcPost('/api/auth/logout', {}, session.cookie).catch(() => undefined);
}

test('unauthenticated root shows login and /api/status is 401', async ({ page }: Fixtures) => {
  await page.goto('/');
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#tokenInput')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Control Center freischalten' })).toBeVisible();

  const apiStatus = await fetchWithRetry(`${MECE_BASE}/api/status`);
  expect(apiStatus.status).toBe(401);
  const browserStatus = await page.evaluate(async () => (await fetch('/api/status')).status);
  expect(browserStatus).toBe(401);

  const html = await (await fetchWithRetry(`${MECE_BASE}/`)).text();
  if (DASHBOARD_TOKEN) {
    // Boolean comparison keeps the secret out of any assertion diff.
    expect(html.includes(DASHBOARD_TOKEN), 'served HTML must not contain the dashboard token').toBe(false);
  }
});

test('wrong token is rejected and cleared from sessionStorage; login stays visible', async ({ page }: Fixtures) => {
  const wrongToken = 'invalid-control-token-000000000000000000';
  await page.goto('/');
  await expect(page.locator('#login')).toBeVisible();

  await page.locator('#tokenInput').fill(wrongToken);
  await page.locator('#tokenSave').click();

  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#tokenInput')).toBeVisible();
  await expect(page.locator('#tokenStatus')).toHaveText(/ungueltig|verweigert|token|401/i);
  const storedToken = await page.evaluate(() => sessionStorage.getItem('mece_control_token'));
  expect(storedToken).toBeNull();

  const apiStatus = await fetchWithRetry(`${MECE_BASE}/api/status`, {
    headers: { 'x-control-token': wrongToken },
  });
  expect(apiStatus.status).toBe(401);
});

test('valid token unlocks the dashboard with real runtime/UGC status and no token leakage', async ({ page }: Fixtures) => {
  const bootstrap = await fetchBootstrap();
  await unlockDashboard(page);

  await expect(page.locator('#projectHead')).toContainText(bootstrap.config.projectPath);
  await expect(page.locator('#projectHead')).toContainText(`OpenCode ${bootstrap.version}`);
  await expect(page.locator('#projectHead')).toContainText(bootstrap.ugc.reachable ? 'UGC online' : 'UGC offline');
  await expect(page.locator('#state')).toContainText(`Controller: ${bootstrap.controller.status}`);

  const rawHtml = await (await fetchWithRetry(`${MECE_BASE}/`)).text();
  const renderedHtml = await page.content();
  const visibleText = await page.locator('body').innerText();
  expect(rawHtml.includes(requiredToken()), 'server HTML must not contain the token').toBe(false);
  expect(renderedHtml.includes(requiredToken()), 'rendered DOM must not contain the token').toBe(false);
  expect(visibleText.includes(requiredToken()), 'visible page text must not contain the token').toBe(false);

  const storedToken = await page.evaluate(() => sessionStorage.getItem('mece_control_token'));
  expect(Boolean(storedToken), 'token should only be held in sessionStorage').toBe(true);
});

test('all dashboard tabs render real data from the MECE runtime', async ({ page }: Fixtures) => {
  const bootstrap = await fetchBootstrap();
  await unlockDashboard(page);

  for (const name of ['agents', 'automations', 'mcp', 'chat', 'tasks', 'runs', 'settings']) {
    const button = page.locator(`button.tab[data-tab="${name}"]`);
    const panel = page.locator(`section.panel#${name}`);
    await expect(button).toBeVisible();
    await button.click();
    await expect(panel).toBeVisible();
    await expect(panel).not.toBeEmpty();
  }

  expect(bootstrap.agents.length).toBeGreaterThan(0);
  expect(bootstrap.automations.length).toBeGreaterThan(0);

  await page.locator('button.tab[data-tab="agents"]').click();
  await expect(page.locator('#agentList')).toContainText(bootstrap.agents[0].name);
  await page.locator('button.tab[data-tab="automations"]').click();
  await expect(page.locator('#automationList')).toContainText(bootstrap.automations[0].name);

  await page.locator('button.tab[data-tab="mcp"]').click();
  if (bootstrap.mcp.length > 0) {
    await expect(page.locator('#mcpList')).toContainText(bootstrap.mcp[0].name);
  } else {
    await expect(page.locator('#mcpList')).toContainText('Keine MCP-Server konfiguriert.');
  }

  await page.locator('button.tab[data-tab="chat"]').click();
  await expect(page.locator('#chatInput')).toBeVisible();
  await expect(page.locator('#chatMessages')).toBeVisible();
  await expect(page.locator('#chatModelError')).not.toContainText('Modelle nicht geladen');
  expect((await page.locator('#chatAgent option').allTextContents()).length).toBe(bootstrap.chatAgents.length);
  expect((await page.locator('#chatModel option').allTextContents()).length).toBeGreaterThanOrEqual(10);

  await page.locator('button.tab[data-tab="tasks"]').click();
  await expect(page.locator('#controllerState')).toContainText(`Status: ${bootstrap.controller.status}`);
  await expect(page.locator('#controllerState')).not.toContainText('Lade Controller-Status');

  await page.locator('button.tab[data-tab="runs"]').click();
  await expect(page.locator('#runState')).toContainText(bootstrap.job?.state || 'Idle');
  await expect(page.locator('#log')).toBeVisible();
  await expect(page.locator('#runHistory')).toBeVisible();

  await page.locator('button.tab[data-tab="settings"]').click();
  await expect(page.locator('#settingsForm input[name="projectPath"]')).toHaveValue(bootstrap.config.projectPath);
  await expect(page.locator('#settingsForm input[name="model"]')).toHaveValue(bootstrap.config.model);
  expect(await page.locator('#settingsForm select[name="agent"] option').count()).toBe(bootstrap.agents.length);
  expect(await page.locator('#settingsForm select[name="automation"] option').count()).toBe(bootstrap.automations.length);
});

test('chat model select is free-only, persists a choice, and can be reset', async ({ page }: Fixtures) => {
  const initial = await controlGet('/api/chat/model');
  const originalModel = initial.model as string;
  const available = initial.available as string[];

  await unlockDashboard(page);
  await page.locator('button.tab[data-tab="chat"]').click();
  await expect(page.locator('#chat')).toBeVisible();

  const options = await page.locator('#chatModel option').allTextContents();
  expect(available.length).toBeGreaterThanOrEqual(10);
  expect(options.length).toBeGreaterThanOrEqual(10);
  expect(options).toEqual(available);
  expect(options.every((model: string) => model.startsWith('opencode/')), 'only opencode/* models may be offered').toBe(true);
  expect(
    options.some((model: string) => /^(openai|anthropic|google|gemini|mistral|deepseek|openrouter|x-ai|azure|bedrock|ollama)\//i.test(model)),
    'no paid provider may be offered',
  ).toBe(false);

  async function persistedModel(): Promise<string> {
    return ((await controlGet('/api/chat/model')) as any).model as string;
  }

  const target = available.find((model) => model !== originalModel) ?? originalModel;
  try {
    await page.locator('#chatModel').selectOption(target);
    await expect.poll(persistedModel, { message: 'model selection should persist via /api/chat/model' }).toBe(target);
    await page.reload();
    await page.locator('button.tab[data-tab="chat"]').click();
    await expect(page.locator('#chat')).toBeVisible();
    await expect(page.locator('#chatModel')).toHaveValue(target);
  } finally {
    await page.locator('button.tab[data-tab="chat"]').click();
    await expect(page.locator('#chat')).toBeVisible();
    await page.locator('#chatModel').selectOption(originalModel);
    await expect.poll(persistedModel, { message: 'original model should be restored' }).toBe(originalModel);
  }
});

test('/api/tasks reflects the controller journal and runtime state, not legacy files', async ({ page }: Fixtures) => {
  const bootstrap = await fetchBootstrap();
  const tasks = await controlGet('/api/tasks');

  const journalPath = resolve(process.cwd(), 'docs/completion/controller/journal.jsonl');
  const hasJournal = existsSync(journalPath);
  expect(tasks.source, 'task source should follow the controller runtime').toBe(hasJournal ? 'journal' : 'legacy');
  expect(tasks.controller.status).toBe(bootstrap.controller.status);
  expect(tasks.controller.updatedAt).toBe(bootstrap.controller.updatedAt);
  expect(tasks.controller.queueDepth).toBe(bootstrap.controller.queueDepth);

  if (hasJournal) {
    const events = readFileSync(journalPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 100)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
    const replay = replayQueue(events);
    expect(tasks.queued).toEqual(replay.pending.map((task: any) => task.text).slice(0, 100));
    expect(tasks.completed).toEqual(replay.completed.map((task: any) => task.text).slice(0, 100));
    expect(tasks.failed).toEqual([
      ...replay.failed.map((task: any) => task.text),
      ...replay.quarantined.map((task: any) => `${task.text} [quarantined: ${task.reason || 'unknown'}]`),
    ].slice(0, 100));
  }

  await unlockDashboard(page);
  await page.locator('button.tab[data-tab="tasks"]').click();
  await expect(page.locator('#controllerState')).toContainText(`Status: ${tasks.controller.status}`);
  if (tasks.queued.length > 0) {
    const sample = String(tasks.queued[0]).split('|').pop()!.trim();
    await expect(page.locator('#taskQueue')).toContainText(sample);
  }
});

test('UGC dashboard HTML links to the MECE control center', async ({ page }: Fixtures) => {
  const response = await fetchWithRetry(`${UGC_BASE}/`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('href="http://127.0.0.1:3031/"');

  const session = await createUgcSession();
  try {
    const separator = session.cookie.indexOf('=');
    await page.context().addCookies([{
      name: session.cookie.slice(0, separator),
      value: session.cookie.slice(separator + 1),
      url: UGC_BASE,
    }]);
    await page.goto(`${UGC_BASE}/`);
    const link = page.locator('a[href="http://127.0.0.1:3031/"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('target', '_blank');
  } finally {
    await ugcLogout(session);
  }
});

test('UGC /api/control/status is auth-gated and works with a workspace session', async () => {
  const unauthenticated = await ugcGet('/api/control/status');
  expect(unauthenticated.status).toBe(401);

  const session = await createUgcSession();
  try {
    let bridge: any;
    // The upstream status call is time-boxed to 2.5s by the app and the local
    // opencode version probe is occasionally slower; sample a few times.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const authorized = await ugcGet('/api/control/status', session.cookie, session.workspaceId);
      expect(authorized.status, 'workspace session should reach the bridge').toBe(200);
      bridge = await authorized.json();
      if (bridge.reachable) break;
    }

    expect(typeof bridge.reachable).toBe('boolean');
    expect(JSON.stringify(bridge).includes(requiredToken()), 'bridge payload must not contain the token').toBe(false);
    if (bridge.reachable) {
      expect(bridge.url).toBe(`${MECE_BASE}/`);
      const upstream = await controlGet('/api/status');
      expect(bridge.version).toBe(upstream.version);
      expect(bridge.controller.status).toBe(upstream.controller.status);
      expect(bridge.ugc.reachable).toBe(upstream.ugc.reachable);
    } else {
      expect(['CONTROL_UNAVAILABLE', 'CONTROL_AUTH_FAILED', 'CONTROL_TOKEN_NOT_CONFIGURED']).toContain(bridge.reason);
    }

    const logout = await ugcPost('/api/auth/logout', {}, session.cookie);
    expect(logout.status).toBe(200);
    const afterLogout = await ugcGet('/api/control/status', session.cookie, session.workspaceId);
    expect(afterLogout.status).toBe(401);

    const login = await ugcPost('/api/auth/login', { email: session.email, password: session.password });
    expect(login.status, 'login should re-establish the workspace session').toBe(200);
    const loginCookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const afterLogin = await ugcGet('/api/control/status', loginCookie, session.workspaceId);
    expect(afterLogin.status).toBe(200);
  } finally {
    await ugcLogout(session);
  }
});

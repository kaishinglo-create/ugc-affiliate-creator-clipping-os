import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const appSource = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
const indexSource = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

type AnyFn = (...args: any[]) => any;
type ResponseSpec = { status?: number; body?: any; contentType?: string; blob?: any };
type Responses = Record<string, ResponseSpec | any>;

let htmlRegistry: ((html: string) => void) | null = null;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:]*)\s*=\s*"([^"]*)"/g)) attrs[match[1]] = match[2];
  return attrs;
}

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

class StubElement {
  id: string;
  tagName: string;
  textContent = '';
  hidden: boolean;
  value: string;
  checked: boolean;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  files: any[] = [];
  fields: Record<string, string> = {};
  attrs: Record<string, string>;
  children: any[] = [];
  closed = false;
  open = false;
  classList: any;
  private _innerHTML = '';
  private _listeners: Record<string, AnyFn[]> = {};

  constructor(id = '', tag = 'DIV', attrs: Record<string, string> = {}) {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.hidden = Object.prototype.hasOwnProperty.call(attrs, 'hidden');
    this.value = attrs.value || '';
    this.checked = Object.prototype.hasOwnProperty.call(attrs, 'checked');
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('data-')) this.dataset[camel(key.slice(5))] = value;
    }
    const classes = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
    this.classList = {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    };
  }

  set innerHTML(value: string) {
    this._innerHTML = value;
    if (htmlRegistry) htmlRegistry(value);
  }
  get innerHTML(): string { return this._innerHTML; }

  addEventListener(type: string, fn: AnyFn): void {
    (this._listeners[type] ||= []).push(fn);
  }
  dispatch(type: string, event: any): void {
    for (const fn of this._listeners[type] || []) fn(event);
  }
  click(): void { this.dispatch('click', { target: this, preventDefault() {} }); }
  close(): void { this.closed = true; }
  showModal(): void { this.open = true; }
  appendChild(child: any): any { this.children.push(child); return child; }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  querySelector(selector: string): any {
    if (selector === '[data-action=logout]') return this.children.find((c: any) => c.dataset.action === 'logout') || null;
    return null;
  }
}

function makeResponse(spec: ResponseSpec): any {
  const status = spec.status ?? 200;
  const body = spec.body ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    headers: {
      get: (name: string) => String(name).toLowerCase() === 'content-type'
        ? (spec.contentType || (typeof body === 'object' ? 'application/json' : 'text/plain'))
        : '',
    },
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    blob: async () => spec.blob ?? new Blob(['preview']),
  };
}

function createHarness(responses: Responses = {}) {
  const elements = new Map<string, StubElement>();
  const listeners: Record<string, AnyFn[]> = {};
  const calls: Array<{ url: string; opts: any; body: any }> = [];
  const storage = new Map<string, string>();
  let reloads = 0;

  const ensure = (id: string, tag = 'DIV', attrs: Record<string, string> = {}): StubElement => {
    let el = elements.get(id);
    if (!el) { el = new StubElement(id, tag, attrs); elements.set(id, el); }
    return el;
  };

  htmlRegistry = (html: string) => {
    for (const match of html.matchAll(/<([a-zA-Z0-9-]+)([^>]*)>/g)) {
      const attrs = parseAttrs(match[2]);
      if (attrs.id) ensure(attrs.id, match[1], attrs);
    }
  };

  for (const id of ['page', 'auth-container', 'radar-count', 'profile-name', 'profile-detail', 'profile-avatar', 'control-link', 'live-badge', 'crumb', 'sidebar', 'toast', 'modal', 'modal-body', 'menu', 'help', 'close']) {
    ensure(id, id === 'toast' ? 'DIV' : 'DIV', id === 'radar-count' ? { hidden: '' } : {});
  }
  const navs = ['overview', 'radar', 'creators', 'campaigns', 'scripts', 'clipping', 'youtube', 'content', 'calendar', 'analytics', 'integrations', 'api-integrations', 'agent-browser'].map((view) => new StubElement('', 'BUTTON', { class: 'nav', 'data-view': view }));
  const profile = new StubElement('', 'DIV', { class: 'profile' });

  const documentStub: any = {
    body: {
      get innerHTML() { return ''; },
      set innerHTML(_value: string) { throw new Error('document.body.innerHTML must not be replaced'); },
    },
    querySelector(selector: string): any {
      if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
      if (selector === '.profile') return profile;
      if (selector === '.nav[data-view]') return navs[0] || null;
      return null;
    },
    querySelectorAll(selector: string): any[] {
      if (selector === '.nav[data-view]') return navs;
      return [];
    },
    addEventListener(type: string, fn: AnyFn): void { (listeners[type] ||= []).push(fn); },
    createElement(tag: string): StubElement { return new StubElement('', tag); },
  };

  const fetchMock = async (url: string, opts: any = {}) => {
    let body: any = opts.body;
    if (typeof body === 'string' && body.trim().startsWith('{')) {
      try { body = JSON.parse(body); } catch { body = opts.body; }
    }
    calls.push({ url, opts, body });
    const raw = responses[url];
    let spec: ResponseSpec;
    if (typeof raw === 'function') spec = await raw(opts);
    else if (raw && typeof raw === 'object' && ('status' in raw || 'body' in raw || 'contentType' in raw)) spec = raw as ResponseSpec;
    else spec = { body: raw === undefined ? {} : raw };
    return makeResponse(spec);
  };

  class FormDataStub {
    private _entries: Array<[string, string]>;
    constructor(form: any) { this._entries = Object.entries((form && form.fields) || {}); }
    entries(): Array<[string, string]> { return this._entries; }
    [Symbol.iterator](): IterableIterator<[string, string]> { return this._entries[Symbol.iterator](); }
  }

  class FileReaderStub {
    result: any = null;
    error: any = null;
    onload: AnyFn | null = null;
    onerror: AnyFn | null = null;
    readAsDataURL(file: any): void {
      this.result = 'data:' + (file.type || 'application/octet-stream') + ';base64,' + (file.content || '');
      if (this.onload) this.onload();
    }
  }

  const localStorage = {
    getItem: (key: string) => storage.has(key) ? storage.get(key)! : null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
  };

  const context = createContext({
    document: documentStub,
    window: { location: { reload: () => { reloads += 1; } } },
    localStorage,
    fetch: fetchMock,
    FormData: FormDataStub,
    FileReader: FileReaderStub,
    URL,
    Blob,
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  });

  const source = appSource.replace(/\nboot\(\);\s*$/, '\n');
  const hooksSource = `
globalThis.__hooks = {
  state, api, toast, renderAuth, renderPage, loadView, wireEvents, loadMe,
  parseCents, saveEntry, formatCents, updateRadarBadge, loadProductCount,
  updateControlLink, loadControlStatus, mediaState, uploadMedia, createMediaJob,
  processMediaJob, pollMediaJob, previewMediaFile, cancelMediaJob, retryMediaJob,
  exportSelectedClips, detectHighlights, writeSubtitles, loadDiscoveryData,
  loadAnalyticsData, apiIntegrationCenter, apiIntegrationDetailPanel
};`;
  runInContext(source + hooksSource, context);

  const fire = async (type: string, event: any) => {
    for (const fn of listeners[type] || []) await fn(event);
  };

  return {
    hooks: (context as any).__hooks,
    calls,
    elements,
    responses,
    storage,
    ensure,
    fire,
    reloads: () => reloads,
    FormDataStub,
  };
}

describe('frontend controls regression', () => {
  it('clears session and shows login on 401 instead of a stale-data banner', async () => {
    const h = createHarness({ '/api/products': { status: 401, body: { error: 'NOT_AUTHENTICATED' } } });
    h.hooks.state.user = { id: 'user-1', email: 'user@example.test' };
    h.hooks.state.workspaceId = 'ws-1';
    h.storage.set('ugc_workspaceId', 'ws-1');
    h.elements.get('page')!.innerHTML = '<p>private data</p>';
    h.elements.get('auth-container')!.hidden = true;
    h.elements.get('live-badge')!.textContent = '● WORKSPACE DATA';

    await expect(h.hooks.api('/api/products')).rejects.toMatchObject({ status: 401, code: 'NOT_AUTHENTICATED' });

    expect(h.hooks.state.user).toBeNull();
    expect(h.hooks.state.workspaceId).toBeNull();
    expect(h.storage.has('ugc_workspaceId')).toBe(false);
    expect(h.elements.get('auth-container')!.innerHTML).toContain('Sign in');
    expect(h.elements.get('page')!.hidden).toBe(true);
    expect(h.elements.get('live-badge')!.textContent).not.toContain('STALE DATA');

    h.elements.delete('toast');
    expect(() => h.hooks.toast('no shell')).not.toThrow();
  });

  it('binds the radar badge to the real /api/products count', async () => {
    const h = createHarness();
    const badge = h.elements.get('radar-count')!;

    h.responses['/api/products'] = { body: { products: [{ id: '1' }, { id: '2' }, { id: '3' }] } };
    await h.hooks.loadProductCount();
    expect(h.calls.some((call) => call.url === '/api/products')).toBe(true);
    expect(badge.textContent).toBe('3');
    expect(badge.hidden).toBe(false);

    h.responses['/api/products'] = { body: { products: [] } };
    await h.hooks.loadProductCount();
    expect(badge.textContent).toBe('0');
    expect(badge.hidden).toBe(true);

    expect(indexSource).not.toContain('<em>4</em>');
    expect(indexSource).toContain('id="radar-count"');
    expect(indexSource).toContain('id="auth-container"');
    expect(indexSource).not.toContain('Local workspace');
    expect(indexSource).toContain('id="control-link"');
  });

  it('has one analytics branch, one saveEntry and honest auth/profile markup', () => {
    expect(appSource.match(/case\s+"analytics":/g) || []).toHaveLength(1);
    expect(appSource.match(/async function saveEntry\(/g) || []).toHaveLength(1);
    expect(appSource).not.toContain('document.body.innerHTML');
    expect(appSource).toContain('/api/auth/me');
    expect(appSource).toContain('/api/control/status');
    expect(appSource).not.toContain('data-action="agent-task-run"');
    expect(appSource).toContain('liveAdapter:false');
    expect(indexSource).not.toContain('class="demo"');
    expect(indexSource).not.toContain('external integrations disconnected');
    expect(indexSource).not.toMatch(/DEMO DATA|Demo mode|offline/i);
    expect(appSource).toContain('phaseg:"Phase G Studio"');
    // A configured key/budget is not proof of a live provider connection.
    expect(appSource).not.toContain('OLLAMA CONNECTED');
    expect(appSource).toContain('OLLAMA KEY CONFIGURED');
    expect(appSource).toContain('no live provider call is implied');
  });

  it('does not imply live rights or a live data feed from UI badges/actions', () => {
    expect(indexSource).toContain('● WORKSPACE DATA');
    expect(appSource).toContain("'● WORKSPACE DATA'");
    expect(appSource).toContain('operator assertion, not as proof of verified rights');
    expect(appSource).toContain('Auto clip ranking sends no highlights and returns an empty ranking');
    expect(appSource).toContain('id="phaseg-srt"');
    expect(appSource).toContain('getElementById("phaseg-srt")');
    expect(appSource).not.toContain('srtName: (document.getElementById("phaseg-source")');
  });

  it('shows the Phase G breadcrumb instead of a stale Overview label', () => {
    const h = createHarness();
    h.hooks.state.user = { id: 'user-1' };
    h.hooks.state.view = 'phaseg';
    h.hooks.renderPage();
    expect(h.elements.get('crumb')!.textContent).toBe('Phase G Studio');
  });

  it('validates cents fields before posting and uses the same saveEntry path', async () => {
    const h = createHarness({
      '/api/products': { status: 201, body: { product: { id: 'p-1' } } },
    });
    h.hooks.state.view = 'radar';
    const form = h.ensure('entry-form', 'FORM', { 'data-kind': 'product' });
    form.fields = { name: 'Product', category: 'Test', source: 'manual', priceCents: 'abc' };

    expect(() => h.hooks.parseCents('abc', 'Price (cents)')).toThrow(/whole number/);
    expect(() => h.hooks.parseCents('12.5', 'Price (cents)')).toThrow(/whole number/);
    expect(h.hooks.parseCents('', 'Price (cents)')).toBeUndefined();
    expect(h.hooks.parseCents('1250', 'Price (cents)')).toBe(1250);

    await expect(h.hooks.saveEntry(form)).rejects.toThrow(/Price \(cents\)/);
    expect(h.calls.filter((call) => call.url === '/api/products' && call.opts.method === 'POST')).toHaveLength(0);

    form.fields.priceCents = '1250';
    await h.hooks.saveEntry(form);
    const post = h.calls.find((call) => call.url === '/api/products' && call.opts.method === 'POST');
    expect(post).toBeDefined();
    expect(post!.body.priceCents).toBe(1250);
    expect(JSON.stringify(post!.body)).not.toMatch(/NaN|null/);
    expect(hooksFormat(h.hooks)).toBe('€12.50');
  });

  it('calls the media job contract endpoints and exposes real controls', async () => {
    const h = createHarness({
      '/api/media/upload': { body: { asset: { name: 'clip.mp4' } } },
      '/api/media/jobs': { body: { job: { id: 'job-1', name: 'clip.mp4' } } },
      '/api/media/jobs/job-1/process': { body: { job: { id: 'job-1', stage: 'processing' } } },
      '/api/media/jobs/job-1': { body: { job: { id: 'job-1', stage: 'succeeded', progress: 1, result: {
        clips: [{ name: 'clip-1.mp4', startMs: 0, endMs: 5000 }],
        cues: [{ start: 0, end: 1, text: 'hello' }],
        subtitles: 'hello',
      } } } },
      '/api/media/files/clip.mp4': { body: 'preview', contentType: 'video/mp4' },
      '/api/jobs/job-1/cancel': { body: { ok: true } },
      '/api/jobs/job-1/retry': { body: { ok: true } },
      '/api/media/transcription/highlights': { body: { highlights: [{ text: 'hello', score: 2 }] } },
      '/api/media/subtitles': { body: { subtitles: { path: '/media/clip.srt', cues: 1 } } },
      '/api/media/export': { body: { export: { ok: true } } },
    });
    h.hooks.state.workspaceId = 'ws-1';

    await h.hooks.uploadMedia({ name: 'clip.mp4', content: 'QUJD' });
    const upload = h.calls.find((call) => call.url === '/api/media/upload')!;
    expect(upload.body).toEqual({ basename: 'clip.mp4', file: 'QUJD' });
    expect(upload.opts.headers['X-Workspace-Id']).toBe('ws-1');
    expect(upload.opts.credentials).toBe('include');

    await h.hooks.createMediaJob('clip.mp4', 'de');
    expect(h.calls.find((call) => call.url === '/api/media/jobs')!.body).toEqual({ name: 'clip.mp4', language: 'de' });

    await h.hooks.processMediaJob('job-1');
    await h.hooks.pollMediaJob('job-1');
    await h.hooks.previewMediaFile('clip.mp4');
    await h.hooks.cancelMediaJob('job-1');
    await h.hooks.retryMediaJob('job-1');
    await h.hooks.detectHighlights();
    await h.hooks.writeSubtitles();

    const media = h.hooks.mediaState();
    expect(media.clips).toHaveLength(1);
    media.selectedClips = [0];
    media.asset = { name: 'clip.mp4' };
    await h.hooks.exportSelectedClips();

    for (const url of [
      '/api/media/upload', '/api/media/jobs', '/api/media/jobs/job-1/process',
      '/api/media/jobs/job-1', '/api/media/files/clip.mp4', '/api/jobs/job-1/cancel',
      '/api/jobs/job-1/retry', '/api/media/transcription/highlights',
      '/api/media/subtitles', '/api/media/export',
    ]) {
      expect(h.calls.some((call) => call.url === url), url).toBe(true);
    }
    const exportBody = h.calls.find((call) => call.url === '/api/media/export')!.body;
    expect(exportBody).toMatchObject({ inputName: 'clip.mp4', outputName: 'clip-1.mp4', start: 0, duration: 5 });

    expect(appSource).toContain('id="media-language"');
    expect(appSource).toContain('const MEDIA_LANGUAGES = ["de", "en", "auto"]');
    expect(appSource).toContain('data-action="clip-toggle"');
    expect(appSource).toContain('media-subtitle-text');
    expect(appSource).toContain('NOT_CONFIGURED');
  });

  it('surfaces DISCOVERY_NOT_CONFIGURED after a failed search', async () => {
    const h = createHarness({
      '/api/discovery/searches': { status: 503, body: { error: 'DISCOVERY_NOT_CONFIGURED' } },
      '/api/discovery/candidates': { body: { candidates: [] } },
    });
    h.hooks.state.user = { id: 'user-1' };
    h.hooks.state.view = 'youtube';
    await h.hooks.wireEvents();
    const form = h.ensure('discovery-form', 'FORM');
    form.fields = { query: 'creator tools' };

    await h.fire('submit', { target: form, preventDefault() {} });

    expect(h.hooks.state.data.discoveryError).toContain('DISCOVERY_NOT_CONFIGURED');
    expect(h.elements.get('page')!.innerHTML).toContain('DISCOVERY_NOT_CONFIGURED');
  });

  it('wires the remaining real forms and browser controls', async () => {
    const h = createHarness();
    h.hooks.state.user = { id: 'user-1' };
    h.hooks.state.view = 'agents';
    await h.hooks.wireEvents();

    const agentForm = h.ensure('agent-form', 'FORM');
    agentForm.fields = { name: 'Scout', role: 'research' };
    await h.fire('submit', { target: agentForm, preventDefault() {} });
    expect(h.calls.find((call) => call.url === '/api/agents' && call.opts.method === 'POST')!.body).toMatchObject({ name: 'Scout', role: 'research' });

    const taskForm = h.ensure('agent-task-form', 'FORM');
    taskForm.fields = { name: 'Scan', agentId: '', input: '' };
    h.responses['/api/agent-tasks'] = { body: { tasks: [] } };
    await h.fire('submit', { target: taskForm, preventDefault() {} });
    expect(h.calls.find((call) => call.url === '/api/agent-tasks' && call.opts.method === 'POST')).toBeDefined();

    for (const fragment of [
      '/api/integrations/', '/api/discovery/searches', '/api/discovery/candidates',
      '/api/analytics/snapshots', '/api/analytics/clicks', '/snapshots',
      '/api/workflows/', '/api/browser/sessions/', '/api/browser/mcp',
      '/api/browser/sessions/',
    ]) {
      expect(appSource, fragment).toContain(fragment);
    }
    expect(appSource).toContain('data-action="browser-read"');
    expect(appSource).toContain('data-action="browser-click"');
    expect(appSource).toContain('data-action="browser-type"');
    expect(appSource).toContain('data-action="browser-wait"');
    expect(appSource).toContain('data-action="browser-download"');
    expect(appSource).toContain('data-action="browser-close-session"');
    expect(appSource).toContain('data-action="browser-control-request"');
    expect(appSource).toContain('data-action="browser-control-approve"');
    expect(appSource).toContain('data-action="browser-control-release"');
    expect(appSource).toContain('browser-home');
    expect(appSource).toContain('/screenshot');
  });

  it('renders the API Integration Center with real status, links and working controls', async () => {
    const provider = {
      key: 'ollama_cloud', name: 'Ollama Cloud', category: 'KI', description: 'Hosted models',
      portalUrl: 'https://ollama.com/settings/keys', docsUrl: 'https://docs.ollama.com/api',
      credentialFields: [{ key: 'apiKey', label: 'API key', type: 'password', required: true, help: 'Encrypted' }],
      manualSteps: ['Create a key'], requiredPermissions: ['Active account'], freeTier: 'Paid service',
      unavailableWithoutCredentials: ['Hosted chat'], liveAdapter: true, adapterNote: 'Read-only listing',
      oauth: { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', pkce: false, scopes: ['youtube.readonly'], defaultRedirectPath: '/api/api-integrations/oauth/youtube_google/callback' },
      connection: { status: 'CONFIGURED', enabled: true, credentialHint: 'sha256:abc123', lastSuccessAt: null, tokenExpiresAt: null, quota: { source: 'not_supplied_by_provider' } },
    };
    const h = createHarness({
      '/api/api-integrations': { body: { providers: [provider], credentialStoreAvailable: true } },
      '/api/api-integrations/health': { body: { credentialStoreAvailable: true, providersTotal: 1, byStatus: { CONFIGURED: 1 }, openCircuits: 0 } },
      '/api/api-integrations/ollama_cloud': { body: { ...provider, history: [{ id: 'e1', type: 'credentials_saved', outcome: 'ok', errorCode: null, createdAt: new Date().toISOString() }] } },
      '/api/api-integrations/ollama_cloud/test': { body: { status: 'CONNECTED' } },
      '/api/api-integrations/ollama_cloud/credentials': { body: { provider: 'ollama_cloud', connection: { status: 'CONFIGURED' } } },
    });
    h.hooks.state.user = { id: 'user-1' };
    await h.hooks.wireEvents();
    await h.hooks.loadView('api-integrations');
    const page = h.elements.get('page')!.innerHTML;
    expect(h.calls.some((call) => call.url === '/api/api-integrations')).toBe(true);
    expect(page).toContain('API Integration Center');
    expect(page).toContain('CONFIGURED');
    expect(page).toContain('data-action="api-integration-detail"');
    expect(page).toContain('data-action="api-integration-test"');
    expect(page).toContain('data-action="api-integration-oauth"');
    expect(page).not.toContain('undefined');
    expect(indexSource).toContain('data-view="api-integrations"');

    const detailButton = { dataset: { action: 'api-integration-detail', provider: 'ollama_cloud' } };
    await h.fire('click', { target: { closest: (selector: string) => selector.includes('data-view') ? null : detailButton }, preventDefault() {} });
    expect(h.hooks.state.data.apiIntegrationDetail.key).toBe('ollama_cloud');

    const form = h.ensure('api-integration-credential-form', 'FORM', { 'data-provider': 'ollama_cloud' });
    form.fields = { apiKey: 'frontend-secret-value' };
    await h.fire('submit', { target: form, preventDefault() {} });
    const save = h.calls.find((call) => call.url === '/api/api-integrations/ollama_cloud/credentials' && call.opts.method === 'POST');
    expect(save!.body.apiKey).toBe('frontend-secret-value');
  });
});

function hooksFormat(hooks: any): string {
  return hooks.formatCents(1250);
}

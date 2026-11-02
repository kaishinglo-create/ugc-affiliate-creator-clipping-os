import { writeAuditEvent } from '../lib/audit.js';
import { withWorkspaceTransaction } from '../lib/db.js';

export type BrowserControllerState =
  | 'HUMAN_CONTROL'
  | 'AGENT_REQUESTED'
  | 'AGENT_CONTROL'
  | 'HUMAN_TAKEOVER'
  | 'SESSION_LOCKED'
  | 'SESSION_DISCONNECTED';

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  createdAt: string;
}

export interface BrowserSession {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  activeTabId: string;
  tabs: BrowserTab[];
  url: string;
  controllerState: BrowserControllerState;
  controllerActorType: 'human' | 'agent' | 'none';
  controllerActorId: string | null;
  controllerExpiresAt: string | null;
  pendingControlRequestId: string | null;
  pendingControlAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  runtimeSessionId: string | null;
  disconnected: boolean;
}

export interface RuntimeStatus {
  available: boolean;
  mode: 'external' | 'unavailable';
  endpoint: string | null;
  message: string;
}

export interface RuntimeSessionResult {
  runtimeSessionId: string;
}

export interface BrowserRuntimeAdapter {
  readonly id: string;
  status(): Promise<RuntimeStatus>;
  createSession(input: { sessionId: string; workspaceId: string; url?: string }): Promise<RuntimeSessionResult>;
  navigate(input: { runtimeSessionId: string; tabId: string; url: string }): Promise<{ url: string; title: string }>;
  back(input: { runtimeSessionId: string; tabId: string }): Promise<{ url: string; title: string }>;
  forward(input: { runtimeSessionId: string; tabId: string }): Promise<{ url: string; title: string }>;
  reload(input: { runtimeSessionId: string; tabId: string }): Promise<{ url: string; title: string }>;
  tabs(input: { runtimeSessionId: string }): Promise<{ tabs: { id: string; url: string; title: string }[] }>;
  newTab(input: { runtimeSessionId: string; url?: string }): Promise<{ tab: { id: string; url: string; title: string } }>;
  closeTab(input: { runtimeSessionId: string; tabId: string }): Promise<{ ok: true }>;
  read(input: { runtimeSessionId: string; tabId: string }): Promise<{ title: string; url: string; text: string }>;
  click(input: { runtimeSessionId: string; tabId: string; selector: string }): Promise<{ ok: true }>;
  type(input: { runtimeSessionId: string; tabId: string; selector: string; text: string }): Promise<{ ok: true }>;
  screenshot(input: { runtimeSessionId: string; tabId: string }): Promise<{ mimeType: string; base64: string }>;
  wait(input: { runtimeSessionId: string; tabId: string; selector?: string; ms?: number }): Promise<{ ok: true }>;
  download(input: { runtimeSessionId: string; tabId: string; url: string }): Promise<{ fileName: string; size: number; approved: false }>;
  closeSession(input: { runtimeSessionId: string }): Promise<{ ok: true }>;
}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]$/i,
  /^fc/i,
  /^fd/i,
  /^fe80:/i,
];

const BROWSER_PERMISSIONS: Record<string, Set<string>> = {
  orchestrator: new Set(['session:create', 'session:close', 'session:list', 'session:status', 'tabs:list', 'screenshot', 'read', 'control:request', 'control:release', 'control:takeover']),
  'frontend-auditor': new Set(['navigate', 'back', 'forward', 'reload', 'tabs:list', 'tabs:new', 'tabs:close', 'read', 'click', 'type', 'screenshot', 'wait', 'session:status', 'control:request', 'control:release']),
  'api-auditor': new Set(['navigate', 'tabs:list', 'read', 'screenshot', 'session:status', 'control:request']),
  'security-auditor': new Set(['tabs:list', 'read', 'screenshot', 'session:status']),
  'repair-agent': new Set(['navigate', 'back', 'forward', 'reload', 'tabs:list', 'tabs:new', 'tabs:close', 'read', 'click', 'type', 'screenshot', 'wait', 'download', 'session:status', 'control:request', 'control:release']),
  'regression-agent': new Set(['navigate', 'back', 'forward', 'reload', 'tabs:list', 'tabs:new', 'tabs:close', 'read', 'click', 'type', 'screenshot', 'wait', 'download', 'session:status', 'control:request', 'control:release']),
  'synthesis-agent': new Set(['tabs:list', 'read', 'screenshot', 'session:status']),
};

function nowIso(): string { return new Date().toISOString(); }

export class UnavailableRuntimeAdapter implements BrowserRuntimeAdapter {
  readonly id = 'unavailable';

  async status(): Promise<RuntimeStatus> {
    return {
      available: false,
      mode: 'unavailable',
      endpoint: null,
      message: 'BROWSER_RUNTIME_URL is not configured. No real browser runtime is available.',
    };
  }

  private unavailable(): never {
    throw new Error('BROWSER_RUNTIME_UNAVAILABLE');
  }

  async createSession(): Promise<RuntimeSessionResult> { this.unavailable(); }
  async navigate(): Promise<{ url: string; title: string }> { this.unavailable(); }
  async back(): Promise<{ url: string; title: string }> { this.unavailable(); }
  async forward(): Promise<{ url: string; title: string }> { this.unavailable(); }
  async reload(): Promise<{ url: string; title: string }> { this.unavailable(); }
  async tabs(): Promise<{ tabs: { id: string; url: string; title: string }[] }> { this.unavailable(); }
  async newTab(): Promise<{ tab: { id: string; url: string; title: string } }> { this.unavailable(); }
  async closeTab(): Promise<{ ok: true }> { this.unavailable(); }
  async read(): Promise<{ title: string; url: string; text: string }> { this.unavailable(); }
  async click(): Promise<{ ok: true }> { this.unavailable(); }
  async type(): Promise<{ ok: true }> { this.unavailable(); }
  async screenshot(): Promise<{ mimeType: string; base64: string }> { this.unavailable(); }
  async wait(): Promise<{ ok: true }> { this.unavailable(); }
  async download(): Promise<{ fileName: string; size: number; approved: false }> { this.unavailable(); }
  async closeSession(): Promise<{ ok: true }> { this.unavailable(); }
}

export class HttpBrowserRuntimeAdapter implements BrowserRuntimeAdapter {
  readonly id = 'external-http';
  private readonly baseUrl: string;
  private readonly token: string | null;

  constructor(baseUrl: string, token: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`BROWSER_RUNTIME_HTTP_${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async status(): Promise<RuntimeStatus> {
    try {
      const result = await this.request<RuntimeStatus>('/status');
      return { ...result, mode: 'external', endpoint: this.baseUrl };
    } catch (err) {
      return {
        available: false,
        mode: 'external',
        endpoint: this.baseUrl,
        message: err instanceof Error ? err.message : 'BROWSER_RUNTIME_UNREACHABLE',
      };
    }
  }

  async createSession(input: { sessionId: string; workspaceId: string; url?: string }): Promise<RuntimeSessionResult> {
    return this.request<RuntimeSessionResult>('/sessions', input);
  }

  async navigate(input: { runtimeSessionId: string; tabId: string; url: string }): Promise<{ url: string; title: string }> {
    return this.request<{ url: string; title: string }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/navigate`, input);
  }

  async back(input: { runtimeSessionId: string; tabId: string }): Promise<{ url: string; title: string }> {
    return this.request<{ url: string; title: string }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/back`, input);
  }

  async forward(input: { runtimeSessionId: string; tabId: string }): Promise<{ url: string; title: string }> {
    return this.request<{ url: string; title: string }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/forward`, input);
  }

  async reload(input: { runtimeSessionId: string; tabId: string }): Promise<{ url: string; title: string }> {
    return this.request<{ url: string; title: string }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/reload`, input);
  }

  async tabs(input: { runtimeSessionId: string }): Promise<{ tabs: { id: string; url: string; title: string }[] }> {
    return this.request<{ tabs: { id: string; url: string; title: string }[] }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/tabs`, input);
  }

  async newTab(input: { runtimeSessionId: string; url?: string }): Promise<{ tab: { id: string; url: string; title: string } }> {
    return this.request<{ tab: { id: string; url: string; title: string } }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/tabs/new`, input);
  }

  async closeTab(input: { runtimeSessionId: string; tabId: string }): Promise<{ ok: true }> {
    return this.request<{ ok: true }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/tabs/close`, input);
  }

  async read(input: { runtimeSessionId: string; tabId: string }): Promise<{ title: string; url: string; text: string }> {
    return this.request<{ title: string; url: string; text: string }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/read`, input);
  }

  async click(input: { runtimeSessionId: string; tabId: string; selector: string }): Promise<{ ok: true }> {
    return this.request<{ ok: true }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/click`, input);
  }

  async type(input: { runtimeSessionId: string; tabId: string; selector: string; text: string }): Promise<{ ok: true }> {
    return this.request<{ ok: true }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/type`, input);
  }

  async screenshot(input: { runtimeSessionId: string; tabId: string }): Promise<{ mimeType: string; base64: string }> {
    return this.request<{ mimeType: string; base64: string }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/screenshot`, input);
  }

  async wait(input: { runtimeSessionId: string; tabId: string; selector?: string; ms?: number }): Promise<{ ok: true }> {
    return this.request<{ ok: true }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/wait`, input);
  }

  async download(input: { runtimeSessionId: string; tabId: string; url: string }): Promise<{ fileName: string; size: number; approved: false }> {
    return this.request<{ fileName: string; size: number; approved: false }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/download`, input);
  }

  async closeSession(input: { runtimeSessionId: string }): Promise<{ ok: true }> {
    return this.request<{ ok: true }>(`/sessions/${encodeURIComponent(input.runtimeSessionId)}/close`, input);
  }
}

export function createBrowserRuntimeFromEnv(): BrowserRuntimeAdapter {
  const configured = (process.env.BROWSER_RUNTIME_URL || '').trim();
  if (!configured) return new UnavailableRuntimeAdapter();
  try {
    const parsed = new URL(configured);
    if (!['http:', 'https:'].includes(parsed.protocol)) return new UnavailableRuntimeAdapter();
    return new HttpBrowserRuntimeAdapter(configured, (process.env.BROWSER_RUNTIME_TOKEN || '').trim() || null);
  } catch {
    return new UnavailableRuntimeAdapter();
  }
}

export function validateBrowserUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('INVALID_URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URL_PROTOCOL_NOT_ALLOWED');
  if (parsed.username || parsed.password) throw new Error('URL_CREDENTIALS_NOT_ALLOWED');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) throw new Error('URL_HOST_NOT_ALLOWED');
  return parsed.toString();
}

export function browserPermissionsForRole(role: string): Set<string> {
  return BROWSER_PERMISSIONS[role] ?? new Set(['session:status']);
}

export class BrowserGateway {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly runtime: BrowserRuntimeAdapter;

  constructor(runtime: BrowserRuntimeAdapter = createBrowserRuntimeFromEnv()) {
    this.runtime = runtime;
  }

  getRuntime(): BrowserRuntimeAdapter { return this.runtime; }

  async runtimeStatus(): Promise<RuntimeStatus> { return this.runtime.status(); }

  async createSession(workspaceId: string, ownerUserId: string, initialUrl?: string): Promise<BrowserSession> {
    const now = nowIso();
    const session: BrowserSession = {
      id: crypto.randomUUID(),
      workspaceId,
      ownerUserId,
      activeTabId: '',
      tabs: [],
      url: '',
      controllerState: 'HUMAN_CONTROL',
      controllerActorType: 'human',
      controllerActorId: ownerUserId,
      controllerExpiresAt: null,
      pendingControlRequestId: null,
      pendingControlAgentId: null,
      createdAt: now,
      updatedAt: now,
      runtimeSessionId: null,
      disconnected: false,
    };
    const status = await this.runtime.status();
    if (status.available) {
      const res = await this.runtime.createSession({ sessionId: session.id, workspaceId, url: initialUrl });
      session.runtimeSessionId = res.runtimeSessionId;
      if (initialUrl) {
        const url = validateBrowserUrl(initialUrl);
        const nav = await this.runtime.navigate({ runtimeSessionId: session.runtimeSessionId, tabId: session.activeTabId || 'tab-1', url });
        if (!session.activeTabId) session.activeTabId = 'tab-1';
        session.tabs = [{ id: session.activeTabId, url: nav.url, title: nav.title, createdAt: now }];
        session.url = nav.url;
      } else {
        const tabs = await this.runtime.tabs({ runtimeSessionId: session.runtimeSessionId });
        session.tabs = tabs.tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, createdAt: now }));
        session.activeTabId = session.tabs[0]?.id ?? '';
        session.url = session.tabs[0]?.url ?? '';
      }
    } else {
      session.disconnected = true;
      session.controllerState = 'SESSION_DISCONNECTED';
    }
    this.sessions.set(session.id, session);
    await writeAuditEvent({ workspaceId, userId: ownerUserId, runId: null, type: 'browser_session_created', actor: ownerUserId, data: { sessionId: session.id, runtimeAvailable: status.available } });
    return { ...session, tabs: session.tabs.map((tab) => ({ ...tab })) };
  }

  listSessions(workspaceId: string): BrowserSession[] {
    return Array.from(this.sessions.values())
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => this.refreshController(session));
  }

  getSession(workspaceId: string, sessionId: string): BrowserSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.workspaceId !== workspaceId) return null;
    return this.refreshController(session);
  }

  async closeSession(workspaceId: string, sessionId: string, actorId: string): Promise<boolean> {
    const session = this.getSession(workspaceId, sessionId);
    if (!session) return false;
    if (session.runtimeSessionId) {
      try { await this.runtime.closeSession({ runtimeSessionId: session.runtimeSessionId }); } catch { /* best effort */ }
    }
    this.sessions.delete(sessionId);
    await writeAuditEvent({ workspaceId, userId: session.ownerUserId, runId: null, type: 'browser_session_closed', actor: actorId, data: { sessionId } });
    return true;
  }

  private refreshController(session: BrowserSession): BrowserSession {
    if (session.controllerState === 'AGENT_CONTROL' && session.controllerExpiresAt && new Date(session.controllerExpiresAt).getTime() <= Date.now()) {
      session.controllerState = 'HUMAN_CONTROL';
      session.controllerActorType = 'human';
      session.controllerActorId = session.ownerUserId;
      session.controllerExpiresAt = null;
      session.updatedAt = nowIso();
    }
    return session;
  }

  private assertController(session: BrowserSession, actorType: 'human' | 'agent', actorId: string): void {
    const refreshed = this.refreshController(session);
    if (refreshed.controllerState === 'SESSION_LOCKED') throw new Error('SESSION_LOCKED');
    if (refreshed.controllerState === 'SESSION_DISCONNECTED') throw new Error('SESSION_DISCONNECTED');
    if (actorType === 'human') {
      if (refreshed.controllerActorType !== 'human' || refreshed.controllerActorId !== actorId) {
        // humans may always take over, but direct action requires control or takeover
        throw new Error('HUMAN_CONTROL_REQUIRED');
      }
      return;
    }
    if (refreshed.controllerState !== 'AGENT_CONTROL' || refreshed.controllerActorType !== 'agent' || refreshed.controllerActorId !== actorId) {
      throw new Error('AGENT_CONTROL_REQUIRED');
    }
  }

  private async withRuntime(session: BrowserSession): Promise<string> {
    if (!session.runtimeSessionId) throw new Error('BROWSER_RUNTIME_UNAVAILABLE');
    return session.runtimeSessionId;
  }

  async requestControl(workspaceId: string, sessionId: string, agentId: string): Promise<BrowserSession> {
    const session = this.getSession(workspaceId, sessionId);
    if (!session) throw new Error('SESSION_NOT_FOUND');
    const agent: any = await withWorkspaceTransaction(workspaceId, (tx: any) => tx.agentDefinition.findUnique({ where: { id: agentId } }));
    if (!agent || !agent.enabled || agent.workspaceId !== workspaceId) throw new Error('AGENT_NOT_ALLOWED');
    this.refreshController(session);
    session.controllerState = 'AGENT_REQUESTED';
    session.pendingControlRequestId = crypto.randomUUID();
    session.pendingControlAgentId = agentId;
    session.updatedAt = nowIso();
    await writeAuditEvent({ workspaceId, userId: session.ownerUserId, runId: null, type: 'browser_control_requested', actor: agentId, data: { sessionId, requestId: session.pendingControlRequestId } });
    return { ...session };
  }

  async approveControl(workspaceId: string, sessionId: string, humanUserId: string, agentId: string, durationMs = 30000): Promise<BrowserSession> {
    const session = this.getSession(workspaceId, sessionId);
    if (!session) throw new Error('SESSION_NOT_FOUND');
    if (session.pendingControlAgentId !== agentId || session.controllerState !== 'AGENT_REQUESTED') throw new Error('NO_PENDING_CONTROL_REQUEST');
    session.controllerState = 'AGENT_CONTROL';
    session.controllerActorType = 'agent';
    session.controllerActorId = agentId;
    session.controllerExpiresAt = new Date(Date.now() + Math.max(1000, Math.min(durationMs, 300000))).toISOString();
    session.pendingControlRequestId = null;
    session.pendingControlAgentId = null;
    session.updatedAt = nowIso();
    await writeAuditEvent({ workspaceId, userId: humanUserId, runId: null, type: 'browser_control_granted', actor: humanUserId, data: { sessionId, agentId, expiresAt: session.controllerExpiresAt } });
    return { ...session };
  }

  async releaseControl(workspaceId: string, sessionId: string, actorId: string): Promise<BrowserSession> {
    const session = this.getSession(workspaceId, sessionId);
    if (!session) throw new Error('SESSION_NOT_FOUND');
    session.controllerState = 'HUMAN_CONTROL';
    session.controllerActorType = 'human';
    session.controllerActorId = session.ownerUserId;
    session.controllerExpiresAt = null;
    session.pendingControlRequestId = null;
    session.pendingControlAgentId = null;
    session.updatedAt = nowIso();
    await writeAuditEvent({ workspaceId, userId: session.ownerUserId, runId: null, type: 'browser_control_released', actor: actorId, data: { sessionId } });
    return { ...session };
  }

  async takeover(workspaceId: string, sessionId: string, humanUserId: string): Promise<BrowserSession> {
    const session = this.getSession(workspaceId, sessionId);
    if (!session) throw new Error('SESSION_NOT_FOUND');
    const previousActor = session.controllerActorId;
    session.controllerState = 'HUMAN_TAKEOVER';
    session.controllerActorType = 'human';
    session.controllerActorId = humanUserId;
    session.controllerExpiresAt = null;
    session.pendingControlRequestId = null;
    session.pendingControlAgentId = null;
    session.updatedAt = nowIso();
    await writeAuditEvent({ workspaceId, userId: humanUserId, runId: null, type: 'browser_human_takeover', actor: humanUserId, data: { sessionId, previousActor } });
    session.controllerState = 'HUMAN_CONTROL';
    session.updatedAt = nowIso();
    return { ...session };
  }

  async navigate(workspaceId: string, sessionId: string, actorType: 'human' | 'agent', actorId: string, url: string): Promise<BrowserSession & { result: { url: string; title: string } }> {
    const session = this.getSession(workspaceId, sessionId);
    if (!session) throw new Error('SESSION_NOT_FOUND');
    const normalized = validateBrowserUrl(url);
    this.assertController(session, actorType, actorId);
    if (session.disconnected || !session.runtimeSessionId) throw new Error('SESSION_DISCONNECTED');
    const result = await this.runtime.navigate({ runtimeSessionId: session.runtimeSessionId, tabId: session.activeTabId, url: normalized });
    session.url = result.url;
    session.tabs = session.tabs.map((tab) => tab.id === session.activeTabId ? { ...tab, url: result.url, title: result.title } : tab);
    session.updatedAt = nowIso();
    await writeAuditEvent({ workspaceId, userId: session.ownerUserId, runId: null, type: 'browser_navigate', actor: actorId, data: { sessionId, url: normalized } });
    return { ...session, result };
  }

  async back(workspaceId: string, sessionId: string, actorType: 'human' | 'agent', actorId: string) {
    const session = this.getRequired(workspaceId, sessionId);
    this.assertController(session, actorType, actorId);
    const runtimeSessionId = await this.withRuntime(session);
    const result = await this.runtime.back({ runtimeSessionId, tabId: session.activeTabId });
    this.updateTab(session, result); await this.audit(workspaceId, session, actorId, 'browser_back', {});
    return { ...session, result };
  }

  async forward(workspaceId: string, sessionId: string, actorType: 'human' | 'agent', actorId: string) {
    const session = this.getRequired(workspaceId, sessionId);
    this.assertController(session, actorType, actorId);
    const runtimeSessionId = await this.withRuntime(session);
    const result = await this.runtime.forward({ runtimeSessionId, tabId: session.activeTabId });
    this.updateTab(session, result); await this.audit(workspaceId, session, actorId, 'browser_forward', {});
    return { ...session, result };
  }

  async reload(workspaceId: string, sessionId: string, actorType: 'human' | 'agent', actorId: string) {
    const session = this.getRequired(workspaceId, sessionId);
    this.assertController(session, actorType, actorId);
    const runtimeSessionId = await this.withRuntime(session);
    const result = await this.runtime.reload({ runtimeSessionId, tabId: session.activeTabId });
    this.updateTab(session, result); await this.audit(workspaceId, session, actorId, 'browser_reload', {});
    return { ...session, result };
  }

  async tabs(workspaceId: string, sessionId: string) {
    const session = this.getRequired(workspaceId, sessionId);
    const runtimeSessionId = session.runtimeSessionId;
    if (runtimeSessionId) {
      const result = await this.runtime.tabs({ runtimeSessionId });
      session.tabs = result.tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, createdAt: nowIso() }));
      if (!session.tabs.some((tab) => tab.id === session.activeTabId)) session.activeTabId = session.tabs[0]?.id ?? session.activeTabId;
      session.url = session.tabs.find((tab) => tab.id === session.activeTabId)?.url ?? session.url;
    }
    session.updatedAt = nowIso();
    return { ...session };
  }

  async activateTab(workspaceId: string, sessionId: string, tabId: string): Promise<BrowserSession> {
    const session = this.getRequired(workspaceId, sessionId);
    if (!session.tabs.some((tab) => tab.id === tabId)) throw new Error('TAB_NOT_FOUND');
    session.activeTabId = tabId;
    session.url = session.tabs.find((tab) => tab.id === tabId)?.url ?? session.url;
    session.updatedAt = nowIso();
    await this.audit(workspaceId, session, 'human', 'browser_activate_tab', { tabId });
    return { ...session };
  }

  async newTab(workspaceId: string, sessionId: string, actorType: 'human' | 'agent', actorId: string, url?: string) {
    const session = this.getRequired(workspaceId, sessionId);
    this.assertController(session, actorType, actorId);
    const runtimeSessionId = await this.withRuntime(session);
    const normalized = url ? validateBrowserUrl(url) : undefined;
    const result = await this.runtime.newTab({ runtimeSessionId, url: normalized });
    const tab = { id: result.tab.id, url: result.tab.url, title: result.tab.title, createdAt: nowIso() };
    session.tabs.push(tab);
    session.activeTabId = tab.id;
    session.url = tab.url;
    session.updatedAt = nowIso();
    await this.audit(workspaceId, session, actorId, 'browser_new_tab', { tabId: tab.id, url: tab.url });
    return { ...session, tab };
  }

  async closeTab(workspaceId: string, sessionId: string, actorType: 'human' | 'agent', actorId: string, tabId: string) {
    const session = this.getRequired(workspaceId, sessionId);
    this.assertController(session, actorType, actorId);
    const runtimeSessionId = await this.withRuntime(session);
    await this.runtime.closeTab({ runtimeSessionId, tabId });
    session.tabs = session.tabs.filter((tab) => tab.id !== tabId);
    if (session.activeTabId === tabId) session.activeTabId = session.tabs[0]?.id ?? '';
    session.url = session.tabs.find((tab) => tab.id === session.activeTabId)?.url ?? '';
    session.updatedAt = nowIso();
    await this.audit(workspaceId, session, actorId, 'browser_close_tab', { tabId });
    return { ...session };
  }

  async read(workspaceId: string, sessionId: string) {
    const session = this.getRequired(workspaceId, sessionId);
    const runtimeSessionId = await this.withRuntime(session);
    return this.runtime.read({ runtimeSessionId, tabId: session.activeTabId });
  }

  async click(workspaceId: string, sessionId: string, actorType: 'human' | 'agent', actorId: string, selector: string) {
    const session = this.getRequired(workspaceId, sessionId);
    this.assertController(session, actorType, actorId);
    const runtimeSessionId = await this.withRuntime(session);
    const result = await this.runtime.click({ runtimeSessionId, tabId: session.activeTabId, selector });
    await this.audit(workspaceId, session, actorId, 'browser_click', { selector });
    return result;
  }

  async type(workspaceId: string, sessionId: string, actorType: 'human' | 'agent', actorId: string, selector: string, text: string) {
    const session = this.getRequired(workspaceId, sessionId);
    this.assertController(session, actorType, actorId);
    const runtimeSessionId = await this.withRuntime(session);
    const result = await this.runtime.type({ runtimeSessionId, tabId: session.activeTabId, selector, text });
    await this.audit(workspaceId, session, actorId, 'browser_type', { selector, length: text.length });
    return result;
  }

  async screenshot(workspaceId: string, sessionId: string) {
    const session = this.getRequired(workspaceId, sessionId);
    const runtimeSessionId = await this.withRuntime(session);
    return this.runtime.screenshot({ runtimeSessionId, tabId: session.activeTabId });
  }

  async wait(workspaceId: string, sessionId: string, actorType: 'human' | 'agent', actorId: string, selector?: string, ms?: number) {
    const session = this.getRequired(workspaceId, sessionId);
    this.assertController(session, actorType, actorId);
    const runtimeSessionId = await this.withRuntime(session);
    return this.runtime.wait({ runtimeSessionId, tabId: session.activeTabId, selector, ms });
  }

  async download(workspaceId: string, sessionId: string, actorType: 'human' | 'agent', actorId: string, url: string) {
    const session = this.getRequired(workspaceId, sessionId);
    this.assertController(session, actorType, actorId);
    const runtimeSessionId = await this.withRuntime(session);
    const normalized = validateBrowserUrl(url);
    const result = await this.runtime.download({ runtimeSessionId, tabId: session.activeTabId, url: normalized });
    await this.audit(workspaceId, session, actorId, 'browser_download', { url: normalized });
    return result;
  }

  checkPermission(actorRole: string | null, action: string): boolean {
    if (!actorRole) return false;
    return browserPermissionsForRole(actorRole).has(action);
  }

  async validateAgent(workspaceId: string, agentId: string): Promise<{ role: string; name: string } | null> {
    try {
      return await withWorkspaceTransaction(workspaceId, async (tx: any) => {
        const row: any = await tx.agentDefinition.findUnique({ where: { id: agentId } });
        if (!row || row.workspaceId !== workspaceId || !row.enabled) return null;
        return { role: String(row.role), name: String(row.name) };
      });
    } catch {
      return null;
    }
  }

  private getRequired(workspaceId: string, sessionId: string): BrowserSession {
    const session = this.getSession(workspaceId, sessionId);
    if (!session) throw new Error('SESSION_NOT_FOUND');
    return session;
  }

  private updateTab(session: BrowserSession, result: { url: string; title: string }): void {
    session.tabs = session.tabs.map((tab) => tab.id === session.activeTabId ? { ...tab, url: result.url, title: result.title } : tab);
    session.url = result.url;
    session.updatedAt = nowIso();
  }

  private async audit(workspaceId: string, session: BrowserSession, actor: string, type: string, data: Record<string, unknown>): Promise<void> {
    try {
      await writeAuditEvent({ workspaceId, userId: session.ownerUserId, runId: null, type, actor, data: { sessionId: session.id, ...data } });
    } catch {
      // audit must not mask browser operation results
    }
  }
}

let defaultGateway: BrowserGateway | null = null;

export function getBrowserGateway(): BrowserGateway {
  if (!defaultGateway) defaultGateway = new BrowserGateway(createBrowserRuntimeFromEnv());
  return defaultGateway;
}

export function createBrowserGateway(runtime?: BrowserRuntimeAdapter): BrowserGateway {
  return new BrowserGateway(runtime);
}

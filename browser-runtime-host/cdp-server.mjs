import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const PORT = Number(process.env.BROWSER_RUNTIME_PORT || process.env.PORT || 3210);
const HOST = process.env.BROWSER_RUNTIME_HOST || "127.0.0.1";
const TOKEN = (process.env.BROWSER_RUNTIME_TOKEN || "").trim();
const CDP_URL = (process.env.CDP_URL || process.env.BROWSER_CDP_URL || "").trim();
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const CHROME_BIN = (process.env.CHROME_BIN || process.env.CHROMIUM_BIN || "").trim();

const PRIVATE_PATTERNS = [
  /^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[0-1])\./, /^169\.254\./, /^0\./, /^\[::1\]$/i,
];

const sessions = new Map();
let browserProcess = null;
let browserWsUrl = null;
let connectingPromise = null;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function tokenValid(req) {
  if (!TOKEN) return false;
  const auth = String(req.headers.authorization || "");
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  const supplied = auth.slice(7).trim();
  const left = Buffer.from(supplied);
  const right = Buffer.from(TOKEN);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function safeUrl(raw) {
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL_PROTOCOL_NOT_ALLOWED");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE_PATTERNS.some((p) => p.test(host))) throw new Error("URL_HOST_NOT_ALLOWED");
  return parsed.toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function candidateChromeBins() {
  const requested = CHROME_BIN ? CHROME_BIN.split(path.delimiter).filter(Boolean) : [];
  const found = [];
  const names = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "microsoft-edge"];
  const dirs = ["/usr/bin", "/usr/local/bin", "/opt/google/chrome", "/data/data/com.termux/files/usr/bin", os.homedir() + "/.local/bin"];
  for (const name of names) {
    found.push(name);
    for (const dir of dirs) found.push(path.join(dir, name));
  }
  const all = [...requested, ...found];
  const result = [];
  for (const item of all) {
    try {
      if (fs.existsSync(item) && (fs.statSync(item).mode & 0o111) !== 0) result.push(item);
      else if (!item.includes(path.sep)) result.push(item);
    } catch {}
  }
  return [...new Set(result.filter((x) => x.includes(path.sep) && fs.existsSync(x)))];
}

function findChromeBin() {
  for (const candidate of candidateChromeBins()) {
    try {
      if (!candidate.includes(path.sep)) {
        const proc = spawn("which", [candidate], { stdio: "ignore" });
        // synchronous availability is unknown; rely on PATH spawn later
      }
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  const existing = candidateChromeBins()[0] || null;
  return existing && (existing.includes(path.sep) ? existing : null);
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getBrowserWsUrl() {
  if (browserWsUrl) return browserWsUrl;
  if (connectingPromise) return connectingPromise;
  connectingPromise = (async () => {
    if (CDP_URL) {
      if (CDP_URL.startsWith("ws://") || CDP_URL.startsWith("wss://")) {
        browserWsUrl = CDP_URL;
        return browserWsUrl;
      }
      try {
        const info = await fetchJson(CDP_URL.replace(/\/$/, "") + "/json/version");
        browserWsUrl = info.webSocketDebuggerUrl;
        return browserWsUrl;
      } catch {
        connectingPromise = null;
        return null;
      }
    }

    const bin = findChromeBin();
    if (!bin) {
      connectingPromise = null;
      return null;
    }
    if (!browserProcess) {
      const profile = path.join(os.tmpdir(), "ugc-chrome-cdp-profile");
      fs.mkdirSync(profile, { recursive: true });
      const proc = spawn(bin, [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        `--remote-debugging-address=127.0.0.1`,
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`,
        "about:blank",
      ], { stdio: "ignore" });
      proc.on("error", () => { browserProcess = null; browserWsUrl = null; connectingPromise = null; });
      browserProcess = proc;
      browserProcess.on("exit", () => {
        browserProcess = null;
        browserWsUrl = null;
        connectingPromise = null;
      });
    }

    for (let i = 0; i < 50; i++) {
      try {
        const info = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
        browserWsUrl = info.webSocketDebuggerUrl;
        return browserWsUrl;
      } catch {
        await sleep(200);
      }
    }
    connectingPromise = null;
    return null;
  })();
  return connectingPromise;
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.socket = null;
    this.id = 0;
    this.pending = new Map();
    this.opened = false;
  }

  async open() {
    if (this.opened) return;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.socket = ws;
      ws.addEventListener("open", () => {
        this.opened = true;
        resolve();
      });
      ws.addEventListener("error", (event) => reject(event.error || new Error("CDP_WS_ERROR")));
      ws.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
          if (data.id && this.pending.has(data.id)) {
            const entry = this.pending.get(data.id);
            this.pending.delete(data.id);
            if (data.error) entry.reject(new Error(data.error.message || "CDP_ERROR"));
            else entry.resolve(data.result || {});
          }
        } catch {}
      });
      ws.addEventListener("close", () => {
        this.opened = false;
        for (const entry of this.pending.values()) entry.reject(new Error("CDP_CLOSED"));
        this.pending.clear();
      });
    });
  }

  async send(method, params = {}, sessionId = null, timeoutMs = 20000) {
    if (!this.opened) await this.open();
    const id = ++this.id;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP_TIMEOUT"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });
      this.socket.send(JSON.stringify(message));
    });
  }

  close() {
    try { this.socket?.close(); } catch {}
    this.opened = false;
  }
}

const clients = new Map();

async function getClient() {
  const url = await getBrowserWsUrl();
  if (!url) throw new Error("BROWSER_UNAVAILABLE");
  let client = clients.get(url);
  if (!client) {
    client = new CdpClient(url);
    await client.open();
    clients.set(url, client);
    await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => null);
  }
  return client;
}

async function evalInTarget(client, sessionId, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId, 20000);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "JS_EVALUATION_FAILED");
  return result.result?.value;
}

async function waitReady(client, sessionId, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const state = await evalInTarget(client, sessionId, "document.readyState");
      if (state === "complete" || state === "interactive") return;
    } catch {}
    await sleep(100);
  }
}

async function attach(client, record, targetId) {
  if (record.attached.has(targetId)) return record.attached.get(targetId);
  const result = await client.send("Target.attachToTarget", { targetId, flatten: true }, null, 20000);
  const sessionId = result.sessionId;
  await client.send("Page.enable", {}, sessionId, 20000);
  await client.send("Runtime.enable", {}, sessionId, 20000).catch(() => null);
  await client.send("DOM.enable", {}, sessionId, 20000).catch(() => null);
  record.attached.set(targetId, sessionId);
  return sessionId;
}

async function targetInfo(client, targetId) {
  try {
    const result = await client.send("Target.getTargetInfo", { targetId });
    return result.targetInfo || null;
  } catch {
    return null;
  }
}

async function createTarget(client, browserContextId, url) {
  const result = await client.send("Target.createTarget", { url, browserContextId }, null, 20000);
  return result.targetId;
}

async function closeTarget(client, targetId) {
  try { await client.send("Target.closeTarget", { targetId }, null, 10000); } catch {}
}

function tabIdForCount(record) {
  return `tab-${record.tabs.size + 1}`;
}

async function tab(record, requestedTabId) {
  const targetId = record.tabs.get(requestedTabId);
  if (!targetId) throw new Error("TAB_NOT_FOUND");
  const client = await getClient();
  const sessionId = await attach(client, record, targetId);
  return { client, targetId, sessionId };
}

async function newSession(workspaceId, url) {
  const client = await getClient();
  const contextResult = await client.send("Target.createBrowserContext", { disposeOnDetach: true }, null, 20000);
  const browserContextId = contextResult.browserContextId;
  const record = {
    id: crypto.randomUUID(),
    workspaceId,
    browserContextId,
    tabs: new Map(),
    activeTabId: null,
    attached: new Map(),
  };
  const targetId = await createTarget(client, browserContextId, url ? safeUrl(url) : "about:blank");
  record.tabs.set("tab-1", targetId);
  record.activeTabId = "tab-1";
  if (url) {
    const sid = await attach(client, record, targetId);
    await client.send("Page.navigate", { url: safeUrl(url) }, sid, 20000);
    await waitReady(client, sid, 20000);
  }
  sessions.set(record.id, record);
  return record;
}

async function closeSession(sid) {
  const record = sessions.get(sid);
  if (!record) return;
  try {
    const client = await getClient();
    for (const targetId of record.tabs.values()) await closeTarget(client, targetId);
    await client.send("Target.disposeBrowserContext", { browserContextId: record.browserContextId }, null, 10000).catch(() => null);
  } catch {}
  sessions.delete(sid);
}

async function waitingMs(value) {
  return Math.min(Math.max(Number(value || 500), 0), 30000);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/status" && req.method === "GET") {
      let available = false;
      let message = "No Chrome/CDP endpoint available.";
      let endpoint = null;
      try {
        const url = await getBrowserWsUrl();
        if (url) {
          const client = await getClient();
          await client.send("Browser.getVersion", {}, null, 10000);
          available = true;
          message = "Chrome DevTools Protocol host ready.";
          endpoint = `http://${HOST}:${PORT}`;
        }
      } catch (err) {
        available = false;
        message = err instanceof Error ? err.message : String(err);
      }
      return json(res, 200, { available, mode: "external", endpoint: available ? endpoint : null, message });
    }
    if (!tokenValid(req)) return json(res, 401, { error: "UNAUTHORIZED" });
    const body = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => resolve(data ? JSON.parse(data) : {}));
      req.on("error", reject);
    });
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)(.*)$/);
    if (req.url === "/sessions" && req.method === "POST") {
      const record = await newSession(body.workspaceId, body.url);
      return json(res, 200, { runtimeSessionId: record.id });
    }
    if (!sessionMatch) return json(res, 404, { error: "NOT_FOUND" });
    const sid = decodeURIComponent(sessionMatch[1]);
    const rest = sessionMatch[2] || "";
    const record = sessions.get(sid);
    if (!record) return json(res, 404, { error: "SESSION_NOT_FOUND" });

    if (rest === "" && req.method === "DELETE") {
      await closeSession(sid);
      return json(res, 200, { ok: true });
    }
    if (rest === "/navigate" && req.method === "POST") {
      const { client, sessionId } = await tab(record, body.tabId);
      const target = safeUrl(body.url);
      await client.send("Page.navigate", { url: target }, sessionId, 20000);
      await waitReady(client, sessionId, 20000);
      const state = await evalInTarget(client, sessionId, "({ url: location.href, title: document.title })");
      return json(res, 200, { url: state.url, title: state.title });
    }
    if (rest === "/back" && req.method === "POST") {
      const { client, sessionId } = await tab(record, body.tabId);
      const history = await client.send("Page.getNavigationHistory", {}, sessionId, 20000);
      const index = Number(history.currentIndex || 0);
      const entries = Array.isArray(history.entries) ? history.entries : [];
      if (index > 0) {
        await client.send("Page.navigateToHistoryEntry", { entryId: entries[index - 1].id }, sessionId, 20000);
        await waitReady(client, sessionId, 20000);
      }
      const state = await evalInTarget(client, sessionId, "({ url: location.href, title: document.title })");
      return json(res, 200, { url: state.url, title: state.title });
    }
    if (rest === "/forward" && req.method === "POST") {
      const { client, sessionId } = await tab(record, body.tabId);
      const history = await client.send("Page.getNavigationHistory", {}, sessionId, 20000);
      const index = Number(history.currentIndex || 0);
      const entries = Array.isArray(history.entries) ? history.entries : [];
      if (index < entries.length - 1) {
        await client.send("Page.navigateToHistoryEntry", { entryId: entries[index + 1].id }, sessionId, 20000);
        await waitReady(client, sessionId, 20000);
      }
      const state = await evalInTarget(client, sessionId, "({ url: location.href, title: document.title })");
      return json(res, 200, { url: state.url, title: state.title });
    }
    if (rest === "/reload" && req.method === "POST") {
      const { client, sessionId } = await tab(record, body.tabId);
      await client.send("Page.reload", {}, sessionId, 20000);
      await waitReady(client, sessionId, 20000);
      const state = await evalInTarget(client, sessionId, "({ url: location.href, title: document.title })");
      return json(res, 200, { url: state.url, title: state.title });
    }
    if (rest === "/tabs" && req.method === "POST") {
      const client = await getClient();
      const out = [];
      for (const [id, targetId] of record.tabs.entries()) {
        try {
          const sessionId = await attach(client, record, targetId);
          const state = await evalInTarget(client, sessionId, "({ url: location.href, title: document.title })");
          out.push({ id, url: state.url, title: state.title });
        } catch {
          const info = await targetInfo(client, targetId);
          out.push({ id, url: info?.url || "", title: info?.title || "" });
        }
      }
      return json(res, 200, { tabs: out });
    }
    if (rest === "/tabs/new" && req.method === "POST") {
      const client = await getClient();
      const targetId = await createTarget(client, record.browserContextId, body.url ? safeUrl(body.url) : "about:blank");
      const id = tabIdForCount(record);
      record.tabs.set(id, targetId);
      let state = { url: body.url || "about:blank", title: "" };
      if (body.url) {
        const sessionId = await attach(client, record, targetId);
        await client.send("Page.navigate", { url: safeUrl(body.url) }, sessionId, 20000);
        await waitReady(client, sessionId, 20000);
        state = await evalInTarget(client, sessionId, "({ url: location.href, title: document.title })");
      }
      try { await client.send("Page.bringToFront", {}, (await attach(client, record, targetId)), 5000); } catch {}
      return json(res, 200, { tab: { id, url: state.url, title: state.title } });
    }
    if (rest === "/tabs/close" && req.method === "POST") {
      const targetId = record.tabs.get(body.tabId);
      if (!targetId) throw new Error("TAB_NOT_FOUND");
      const client = await getClient();
      await closeTarget(client, targetId);
      record.tabs.delete(body.tabId);
      record.attached.delete(targetId);
      if (record.activeTabId === body.tabId) {
        record.activeTabId = record.tabs.keys().next().value || record.activeTabId;
      }
      return json(res, 200, { ok: true });
    }
    if (rest === "/read" && req.method === "POST") {
      const { client, sessionId } = await tab(record, body.tabId);
      const state = await evalInTarget(client, sessionId, "({ title: document.title, url: location.href, text: document.body ? document.body.innerText : '' })");
      return json(res, 200, { title: state.title, url: state.url, text: String(state.text || "").slice(0, 100000) });
    }
    if (rest === "/click" && req.method === "POST") {
      const { client, sessionId } = await tab(record, body.tabId);
      const selector = JSON.stringify(String(body.selector ?? ""));
      const result = await evalInTarget(client, sessionId, `(() => { const el = document.querySelector(${selector}); if (!el) return false; el.click(); return true; })()`);
      if (!result) throw new Error("ELEMENT_NOT_FOUND");
      return json(res, 200, { ok: true });
    }
    if (rest === "/type" && req.method === "POST") {
      const { client, sessionId } = await tab(record, body.tabId);
      const selector = JSON.stringify(String(body.selector ?? ""));
      const text = JSON.stringify(String(body.text ?? ""));
      const result = await evalInTarget(client, sessionId, `(() => { const el = document.querySelector(${selector}); if (!el) return false; el.focus(); if ('value' in el) el.value = ${text}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      if (!result) throw new Error("ELEMENT_NOT_FOUND");
      return json(res, 200, { ok: true });
    }
    if (rest === "/screenshot" && req.method === "POST") {
      const { client, sessionId } = await tab(record, body.tabId);
      const result = await client.send("Page.captureScreenshot", { format: "png" }, sessionId, 30000);
      return json(res, 200, { mimeType: "image/png", base64: result.data });
    }
    if (rest === "/wait" && req.method === "POST") {
      const { client, sessionId } = await tab(record, body.tabId);
      if (typeof body.selector === "string" && body.selector) {
        const selector = JSON.stringify(body.selector);
        const limit = Date.now() + Number(body.ms || 10000);
        while (Date.now() < limit) {
          const exists = await evalInTarget(client, sessionId, `Boolean(document.querySelector(${selector}))`);
          if (exists) return json(res, 200, { ok: true });
          await sleep(200);
        }
        throw new Error("WAIT_TIMEOUT");
      }
      await sleep(await waitingMs(body.ms));
      return json(res, 200, { ok: true });
    }
    if (rest === "/download" && req.method === "POST") {
      const target = safeUrl(body.url);
      return json(res, 200, { fileName: new URL(target).pathname.split("/").pop() || "download", size: 0, approved: false });
    }
    if (rest === "/close" && req.method === "POST") {
      await closeSession(sid);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "NOT_FOUND" });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

async function start() {
  const url = await getBrowserWsUrl();
  if (url) console.log(`CDP browser available: ${url}`);
  else console.log("CDP browser unavailable. Set CDP_URL or CHROME_BIN/CHROMIUM_BIN to enable browser automation.");
  server.listen(PORT, HOST, () => {
    console.log(`ugc cdp browser runtime host listening on http://${HOST}:${PORT}`);
  });
}

process.on("SIGINT", async () => {
  server.close();
  for (const client of clients.values()) client.close();
  if (browserProcess) browserProcess.kill("SIGTERM");
  process.exit(0);
});
process.on("SIGTERM", async () => {
  server.close();
  for (const client of clients.values()) client.close();
  if (browserProcess) browserProcess.kill("SIGTERM");
  process.exit(0);
});

start();

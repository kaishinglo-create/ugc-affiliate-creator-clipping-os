import http from "node:http";
import crypto from "node:crypto";
import { chromium } from "playwright";

const PORT = Number(process.env.BROWSER_RUNTIME_PORT || process.env.PORT || 3200);
const TOKEN = (process.env.BROWSER_RUNTIME_TOKEN || "").trim();
const HOST = process.env.BROWSER_RUNTIME_HOST || "127.0.0.1";
const PRIVATE_PATTERNS = [
  /^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[0-1])\./, /^169\.254\./, /^0\./, /^\[::1\]$/i,
];

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

let browser;
const sessions = new Map();

async function newSession(workspaceId, url) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const id = crypto.randomUUID();
  const tabs = new Map();
  const tabId = "tab-1";
  tabs.set(tabId, page);
  if (url) {
    const navUrl = safeUrl(url);
    await page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  }
  const record = { id, workspaceId, context, tabs, activeTabId: tabId, closed: false };
  sessions.set(id, record);
  return record;
}

async function tab(record, tabId) {
  const page = record.tabs.get(tabId);
  if (!page) throw new Error("TAB_NOT_FOUND");
  return page;
}

async function closeSession(id) {
  const record = sessions.get(id);
  if (!record) return;
  try { await record.context.close(); } catch {}
  sessions.delete(id);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/status" && req.method === "GET") {
      return json(res, 200, { available: true, mode: "external", endpoint: `http://${HOST}:${PORT}`, message: "Chromium Playwright host ready." });
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
      const page = await tab(record, body.tabId);
      const target = safeUrl(body.url);
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 20000 });
      return json(res, 200, { url: page.url(), title: await page.title() });
    }
    if (rest === "/back" && req.method === "POST") {
      const page = await tab(record, body.tabId);
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
      return json(res, 200, { url: page.url(), title: await page.title() });
    }
    if (rest === "/forward" && req.method === "POST") {
      const page = await tab(record, body.tabId);
      await page.goForward({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
      return json(res, 200, { url: page.url(), title: await page.title() });
    }
    if (rest === "/reload" && req.method === "POST") {
      const page = await tab(record, body.tabId);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      return json(res, 200, { url: page.url(), title: await page.title() });
    }
    if (rest === "/tabs" && req.method === "POST") {
      const out = await Promise.all(Array.from(record.tabs.entries()).map(async ([id, page]) => ({ id, url: page.url(), title: await page.title() })));
      return json(res, 200, { tabs: out });
    }
    if (rest === "/tabs/new" && req.method === "POST") {
      const page = await record.context.newPage();
      const tabId = `tab-${record.tabs.size + 1}`;
      record.tabs.set(tabId, page);
      if (body.url) {
        const target = safeUrl(body.url);
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 20000 });
      }
      await page.bringToFront().catch(() => null);
      return json(res, 200, { tab: { id: tabId, url: page.url(), title: await page.title() } });
    }
    if (rest === "/tabs/close" && req.method === "POST") {
      const page = await tab(record, body.tabId);
      await page.close().catch(() => null);
      record.tabs.delete(body.tabId);
      if (record.activeTabId === body.tabId) record.activeTabId = record.tabs.keys().next().value || record.activeTabId;
      return json(res, 200, { ok: true });
    }
    if (rest === "/read" && req.method === "POST") {
      const page = await tab(record, body.tabId);
      const text = await page.locator("body").innerText().catch(() => "");
      return json(res, 200, { title: await page.title(), url: page.url(), text: String(text).slice(0, 100000) });
    }
    if (rest === "/click" && req.method === "POST") {
      const page = await tab(record, body.tabId);
      await page.locator(body.selector).click({ timeout: 10000 });
      return json(res, 200, { ok: true });
    }
    if (rest === "/type" && req.method === "POST") {
      const page = await tab(record, body.tabId);
      await page.locator(body.selector).fill(String(body.text ?? ""), { timeout: 10000 });
      return json(res, 200, { ok: true });
    }
    if (rest === "/screenshot" && req.method === "POST") {
      const page = await tab(record, body.tabId);
      const buffer = await page.screenshot({ type: "png", fullPage: true });
      return json(res, 200, { mimeType: "image/png", base64: buffer.toString("base64") });
    }
    if (rest === "/wait" && req.method === "POST") {
      const page = await tab(record, body.tabId);
      if (typeof body.selector === "string" && body.selector) {
        await page.locator(body.selector).waitFor({ timeout: body.ms || 10000 });
      } else {
        await page.waitForTimeout(Math.min(Math.max(Number(body.ms || 500), 0), 30000));
      }
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

(async () => {
  browser = await chromium.launch({ headless: true });
  server.listen(PORT, HOST, () => {
    console.log(`ugc browser runtime host listening on http://${HOST}:${PORT}`);
  });
})();

process.on("SIGINT", async () => { server.close(); if (browser) await browser.close(); process.exit(0); });

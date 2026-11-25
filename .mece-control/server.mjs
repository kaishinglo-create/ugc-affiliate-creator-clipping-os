import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { replayQueue } from "../scripts/controller-core.mjs";

const ROOT = process.cwd();
const BASE = path.join(ROOT, ".mece-control");
const RUNS = path.join(BASE, "runs");
const AGENTS_DIR = path.join(ROOT, ".opencode", "agents");
const COMMANDS_DIR = path.join(ROOT, ".opencode", "commands");
const PROJECT_CONFIG = path.join(ROOT, ".opencode", "opencode.json");
const GLOBAL_CONFIG = path.join(process.env.HOME || "/data/data/com.termux/files/home", ".config", "opencode", "opencode.jsonc");
const CONFIG_FILE = path.join(BASE, "config.json");
const STATUS_FILE = path.join(BASE, "runs.json");
const PORT = 3031;
const OC_PORT = 4096;
const ALLOWED_AUTOMATIONS = ["mece-audit", "mece-repair", "mece-regression", "mece-wave"];
const DEFAULT_MODEL = "opencode/big-pickle";
const DEFAULT_MAX_REPAIR_ROUNDS = 2;
const DEFAULT_RUN_TIMEOUT_MS = 300000;
const MCP_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DASHBOARD_TOKEN = String(process.env.MECE_DASHBOARD_TOKEN || "").trim();
const FREE_MODELS_FILE = path.join(ROOT, "scripts", "free-models.json");
const CONTROLLER_RUNTIME_DIR = path.join(ROOT, "docs", "completion", "controller");
const CONTROLLER_STATE_FILE = path.join(CONTROLLER_RUNTIME_DIR, "state.json");
const CONTROLLER_JOURNAL_FILE = path.join(CONTROLLER_RUNTIME_DIR, "journal.jsonl");
const LEGACY_CONTROLLER_STATE_FILE = path.join(ROOT, "docs", "completion", "AUTONOMOUS_STATE.json");
const TASK_QUEUE_FILE = path.join(ROOT, "docs", "completion", "TASK_QUEUE.txt");
const COMPLETED_TASKS_FILE = path.join(ROOT, "docs", "completion", "COMPLETED_TASKS.txt");
const FAILED_TASKS_FILE = path.join(ROOT, "docs", "completion", "FAILED_TASKS.txt");

function freeModels() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FREE_MODELS_FILE, "utf8"));
    const models = Array.isArray(parsed.models) ? parsed.models.filter((m) => typeof m === "string" && m.startsWith("opencode/")) : [];
    return models.length ? models : ["opencode/big-pickle"];
  } catch {
    return ["opencode/big-pickle"];
  }
}

function isFreeModel(value) {
  return freeModels().includes(String(value || "").trim());
}

function isAllowedAgent(value) {
  const name = String(value || "").trim();
  return name === "orchestrator" || CHAT_AGENTS.includes(name);
}

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function readTaskLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 100);
  } catch { return []; }
}

function controllerState() {
  const runtime = readJsonFile(CONTROLLER_STATE_FILE, null);
  if (runtime) {
    return {
      status: runtime.status || "unknown",
      pauseReason: runtime.pauseReason || null,
      resumeAt: runtime.resumeAt || null,
      currentTask: runtime.currentTask || null,
      queueDepth: runtime.queueDepth ?? null,
      updatedAt: runtime.updatedAt || null,
      uptimeSeconds: runtime.uptimeSeconds ?? null,
      heartbeatAgeSeconds: runtime.heartbeatAgeSeconds ?? null,
      model: runtime.model || null,
      resources: runtime.resources || null,
      verification: runtime.verification || null,
      lastCheckpoint: runtime.lastCheckpoint ?? null,
      source: "runtime"
    };
  }
  const legacy = readJsonFile(LEGACY_CONTROLLER_STATE_FILE, {});
  return {
    status: legacy.status || "unknown",
    currentTask: legacy.currentTask || null,
    queueDepth: null,
    updatedAt: legacy.stoppedAt || legacy.startedAt || null,
    uptimeSeconds: null,
    heartbeatAgeSeconds: null,
    model: null,
    resources: null,
    verification: null,
    lastCheckpoint: legacy.lastCheckpoint ?? null,
    source: "legacy"
  };
}

function controllerTasks() {
  if (fs.existsSync(CONTROLLER_JOURNAL_FILE)) {
    const events = readTaskLines(CONTROLLER_JOURNAL_FILE).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const replay = replayQueue(events);
    return {
      queued: replay.pending.map((task) => task.text).slice(0, 100),
      completed: replay.completed.map((task) => task.text).slice(0, 100),
      failed: [
        ...replay.failed.map((task) => task.text),
        ...replay.quarantined.map((task) => `${task.text} [quarantined: ${task.reason || "unknown"}]`)
      ].slice(0, 100),
      source: "journal"
    };
  }
  return {
    queued: readTaskLines(TASK_QUEUE_FILE),
    completed: readTaskLines(COMPLETED_TASKS_FILE),
    failed: readTaskLines(FAILED_TASKS_FILE),
    source: "legacy"
  };
}

function safeUrlDisplay(value) {
  try {
    const url = new URL(String(value || ""));
    url.username = "";
    url.password = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (/token|key|secret|password|auth/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch { return ""; }
}

const AGENT_TASKS = {
  "frontend-auditor": "Frontend-Komponenten, Formulare, Accessibility, Responsive-Verhalten, Fehlerzustande und Smoke-Tests pruefen.",
  "api-auditor": "API-Routen, Ollama-Anbindung, Provider-Registrierung, Fehlerbehandlung, Timeouts und Secrets-Handling pruefen.",
  "security-auditor": "Routing, SPA-Fallback, Authentifizierung, Workspace-Isolation, Path Traversal und Zugriffskontrollen pruefen.",
  "repair-agent": "Bestaetigte Findings innerhalb zugewiesener Dateigrenzen beheben und Tests ausfuehren.",
  "regression-agent": "Unabhaengige Lint-, Typecheck-, Unit-, Integrations- und Browser-Smoke-Regression durchfuehren.",
  "synthesis-agent": "Alle CELL-Reports lesen und .mece/SYNTHESIS.md erstellen.",
  "orchestrator": "MECE-Wellen planen, Audit/Repair/Regression/Synthesis koordinieren und Ergebnisse pruefen."
};

const CHAT_AGENTS = ["orchestrator", "frontend-auditor", "api-auditor", "security-auditor", "repair-agent", "regression-agent"];

fs.mkdirSync(RUNS, { recursive: true });

let runHistory = [];
try {
  const loaded = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
  if (Array.isArray(loaded)) runHistory = loaded;
} catch {}

let job = { state: "idle", name: null, pid: null, log: null, started: null, exitCode: null, timeoutHandle: null };
let oc = { process: null, url: null, startupError: null, starting: false };

function defaultConfig() {
  return {
    projectPath: ROOT,
    appServerUrl: "http://127.0.0.1:3000",
    logPath: path.join(ROOT, ".run", "dev.log"),
    agent: "orchestrator",
    model: DEFAULT_MODEL,
    maxRepairRounds: DEFAULT_MAX_REPAIR_ROUNDS,
    workflow: "Audit → Repair → Regression → Synthesis",
    automation: "mece-wave",
    prompt: commandPrompt("mece-wave")
  };
}

function loadConfig() {
  try {
    const stored = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const loaded = { ...defaultConfig(), ...stored };
    // Never keep a non-free model in active configuration.
    if (!isFreeModel(loaded.model)) loaded.model = DEFAULT_MODEL;
    if (!isAllowedAgent(loaded.agent)) loaded.agent = "orchestrator";
    if (!isAllowedLogPath(loaded.logPath)) loaded.logPath = defaultConfig().logPath;
    return loaded;
  } catch {
    return defaultConfig();
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isAllowedOrigin(origin) {
  return !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
}

function dashboardTokenValid() {
  return DASHBOARD_TOKEN.length >= 32;
}

function readDashboardToken(req) {
  const authorization = String(req.headers.authorization || "").trim();
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return String(req.headers["x-control-token"] || "").trim();
}

function constantEqualText(a, b) {
  const left = crypto.createHash("sha256").update(String(a), "utf8").digest();
  const right = crypto.createHash("sha256").update(String(b), "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

function dashboardAuthorized(req) {
  return dashboardTokenValid() && constantEqualText(readDashboardToken(req), DASHBOARD_TOKEN);
}

function readFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const source = match ? match[1] : "";
  const result = {};
  for (const line of source.split("\n")) {
    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (entry) result[entry[1]] = entry[2].trim();
  }
  return result;
}

function commandPrompt(name) {
  try {
    const raw = fs.readFileSync(path.join(COMMANDS_DIR, name + ".md"), "utf8");
    return raw.replace(/^---\n[\s\S]*?\n---\s*/, "").trim();
  } catch {
    return "";
  }
}

function listAgents() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const name = file.replace(/\.md$/, "");
      const raw = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
      const frontmatter = readFrontmatter(raw);
      return {
        name,
        description: frontmatter.description || "OpenCode-Subagent",
        mode: frontmatter.mode || "all",
        permissions: frontmatter.permission ? frontmatter.permission : "siehe Datei",
        task: AGENT_TASKS[name] || "Gepruefter Subagent aus .opencode/agents/",
        model: DEFAULT_MODEL,
        prompt: raw.replace(/^---\n[\s\S]*?\n---\s*/, "").trim()
      };
    });
}

function listAutomations() {
  if (!fs.existsSync(COMMANDS_DIR)) return [];
  return ALLOWED_AUTOMATIONS
    .filter((name) => fs.existsSync(path.join(COMMANDS_DIR, name + ".md")))
    .map((name) => {
      const raw = fs.readFileSync(path.join(COMMANDS_DIR, name + ".md"), "utf8");
      const frontmatter = readFrontmatter(raw);
      return {
        name,
        description: frontmatter.description || "MECE-Workflow",
        agent: frontmatter.agent || "orchestrator",
        enabled: true,
        prompt: commandPrompt(name)
      };
    });
}

function stripJsonComments(value) {
  return value.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,\s*([}\]])/g, "$1");
}

function readConfigFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    try {
      return JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8")));
    } catch {
      return {};
    }
  }
}

function readMcpConfig() {
  const output = [];
  const sources = [
    { source: "project", file: PROJECT_CONFIG },
    { source: "global", file: GLOBAL_CONFIG }
  ];
  for (const item of sources) {
    const config = readConfigFile(item.file);
    const mcp = (config && typeof config.mcp === "object" && config.mcp) || {};
    for (const [name, value] of Object.entries(mcp)) {
      const entry = value && typeof value === "object" ? value : {};
      const command = Array.isArray(entry.command) ? entry.command : [];
      const env = entry.environment || entry.env || {};
      const headers = entry.headers || {};
      // Values are never returned to the browser: only keys/counts are useful
      // for editing, and raw secrets must not be readable via the API.
      output.push({
        name,
        source: item.source,
        configPath: item.file,
        transport: entry.type === "remote" ? "remote" : "local",
        type: entry.type || "local",
        enabled: entry.enabled !== false,
        url: safeUrlDisplay(entry.url || ""),
        command: command.length ? command[0] : "",
        args: command.slice(1),
        cwd: entry.cwd || "",
        envKeys: Object.keys(env),
        headerKeys: Object.keys(headers),
        hasSecrets: Boolean(Object.keys(env).length || Object.keys(headers).length)
      });
    }
  }
  return output;
}

function describeMcpStatus() {
  const result = spawnSync("opencode", ["mcp", "list"], { encoding: "utf8", timeout: 10000, cwd: ROOT });
  const text = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return {
    code: result.status,
    output: text.replace(/OPENCODE_SERVER_PASSWORD[^\s]*/g, "OPENCODE_SERVER_PASSWORD=[redacted]").slice(0, 12000)
  };
}

function backupFileIfNeeded(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = file + `.bak-${stamp}`;
  fs.copyFileSync(file, backup);
  return backup;
}

function validateMcpInput(input) {
  const name = String(input.name || "").trim();
  if (!MCP_NAME_RE.test(name)) return { ok: false, error: "Ungueltiger MCP-Servername" };
  const transport = String(input.transport || "local").trim();
  if (!["local", "remote"].includes(transport)) return { ok: false, error: "Ungueltiger Transport" };
  if (transport === "remote") {
    try {
      const url = new URL(String(input.url || "").trim());
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("bad protocol");
    } catch {
      return { ok: false, error: "Ungueltige MCP-URL" };
    }
  } else {
    if (!String(input.command || "").trim()) return { ok: false, error: "Kommando ist erforderlich" };
  }
  if (input.env && typeof input.env !== "object") return { ok: false, error: "Umgebungsvariablen muessen ein Objekt sein" };
  if (input.headers && typeof input.headers !== "object") return { ok: false, error: "Header muessen ein Objekt sein" };
  const enabled = Boolean(input.enabled);
  if (enabled && !input.confirmEnable) return { ok: false, error: "Aktivierung muss bestaetigt werden" };
  const maxEntries = 40;
  if ((input.args || []).length > maxEntries || Object.keys(input.env || {}).length > maxEntries || Object.keys(input.headers || {}).length > maxEntries) {
    return { ok: false, error: "Eingabe zu gross" };
  }
  return { ok: true };
}

function mergeMcpProject(input, deleting = false) {
  const backup = backupFileIfNeeded(PROJECT_CONFIG);
  let config = {};
  try {
    config = readConfigFile(PROJECT_CONFIG);
  } catch {
    config = {};
  }
  if (!config || typeof config !== "object") config = {};
  if (!config.mcp || typeof config.mcp !== "object") config.mcp = {};
  if (deleting) {
    delete config.mcp[input.name];
  } else {
    const transport = String(input.transport || "local");
    const commandText = String(input.command || "").trim();
    const args = Array.isArray(input.args) ? input.args.map((v) => String(v)) : [];
    const env = input.env && typeof input.env === "object" ? input.env : {};
    const headers = input.headers && typeof input.headers === "object" ? input.headers : {};
    if (transport === "local") {
      config.mcp[input.name] = {
        type: "local",
        command: [commandText, ...args].filter(Boolean),
        enabled: Boolean(input.enabled),
        environment: env,
        ...(String(input.cwd || "").trim() ? { cwd: String(input.cwd).trim() } : {})
      };
    } else {
      config.mcp[input.name] = {
        type: "remote",
        url: String(input.url || "").trim(),
        enabled: Boolean(input.enabled),
        headers
      };
    }
  }
  if (Object.keys(config.mcp).length === 0) delete config.mcp;
  fs.mkdirSync(path.dirname(PROJECT_CONFIG), { recursive: true });
  fs.writeFileSync(PROJECT_CONFIG, JSON.stringify(config, null, 2), "utf8");
  if (backup) {
    const note = path.join(RUNS, "mcp-config-backup-" + Date.now() + ".txt");
    fs.writeFileSync(note, `Backup erstellt: ${backup}\n`, "utf8");
  }
}

function isAllowedLogPath(pathName) {
  const target = String(pathName || "").trim();
  if (!target) return false;
  const resolved = path.resolve(target);
  const allowedRoots = [RUNS, path.join(ROOT, ".run")].map((p) => path.resolve(p) + path.sep);
  return allowedRoots.some((root) => resolved.startsWith(root));
}

function currentLog() {
  const pathName = loadConfig().logPath;
  if (!isAllowedLogPath(pathName) || !fs.existsSync(pathName)) return "";
  const buffer = fs.readFileSync(pathName);
  return buffer.subarray(Math.max(0, buffer.length - 24000)).toString("utf8");
}

let ugcHealthCache = { at: 0, data: { reachable: false, status: "unknown" } };
async function ugcHealth() {
  if (Date.now() - ugcHealthCache.at < 10000) return ugcHealthCache.data;
  const url = String(loadConfig().appServerUrl || "http://127.0.0.1:3000").trim();
  let data = { reachable: false, status: "unknown", url };
  try {
    const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(1500) });
    if (response.ok) {
      const body = await response.json().catch(() => ({}));
      data = { reachable: true, status: String(body.status || "ok"), url };
    }
  } catch {}
  ugcHealthCache = { at: Date.now(), data };
  return data;
}

function appendRun(record) {
  runHistory.unshift(record);
  runHistory = runHistory.slice(0, 20);
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(runHistory, null, 2), "utf8"); } catch {}
}

function readRuns() {
  return runHistory;
}

function finishJob(exitCode) {
  const ended = { ...job, exitCode, finishedAt: new Date().toISOString() };
  job = { state: exitCode === 0 ? "completed" : "failed", name: job.name, pid: job.pid || null, log: job.log, started: job.started, exitCode, timeoutHandle: null, pid: null };
  appendRun(ended);
}

function json(res, code, data) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 50000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function redact(value) {
  return String(value || "").replace(/(OPENCODE_SERVER_PASSWORD|api[_-]?key|secret|token|password)\s*[:=]\s*[^\s,}]+/gi, "$1=[redacted]");
}

async function startOpenCodeServer() {
  if (oc.url) return oc.url;
  if (oc.starting) {
    for (let i = 0; i < 50 && !oc.url; i++) await new Promise((r) => setTimeout(r, 100));
    return oc.url;
  }
  oc.starting = true;
  oc.startupError = null;
  try {
    const proc = spawn("opencode", ["serve", "--hostname=127.0.0.1", `--port=${OC_PORT}`], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"]
    });
    oc.process = proc;
    let output = "";
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for OpenCode server")), 8000);
      proc.stdout.on("data", (chunk) => {
        output += chunk.toString();
        const lines = output.split("\n");
        for (const line of lines) {
          if (line.startsWith("opencode server listening")) {
            const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
            if (match) {
              clearTimeout(timer);
              resolve(match[1]);
              return;
            }
          }
        }
      });
      proc.stderr.on("data", (chunk) => { output += chunk.toString(); });
      proc.on("error", (error) => { clearTimeout(timer); reject(error); });
      proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`OpenCode server exited with ${code}: ${output}`)); });
    });
    oc.url = url || `http://127.0.0.1:${OC_PORT}`;
  } catch (error) {
    oc.startupError = String(error.message || error);
    oc.url = null;
  } finally {
    oc.starting = false;
  }
  return oc.url;
}

function parseModelId(value) {
  const text = String(value || "").trim();
  const index = text.indexOf("/");
  return index < 0 ? { providerID: "opencode", modelID: text } : { providerID: text.slice(0, index), modelID: text.slice(index + 1) };
}

// Direct HTTP calls to the local `opencode serve` REST API. This avoids a
// hard-coded SDK path and makes model selection per chat request possible.
async function ocFetch(route, { method = "GET", body, timeout = 20000 } = {}) {
  await startOpenCodeServer();
  if (!oc.url) throw new Error(oc.startupError || "OpenCode server nicht verfügbar");
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const password = process.env.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_PASSWORD;
  if (password) headers.authorization = "Basic " + Buffer.from("opencode:" + password).toString("base64");
  const response = await fetch(new URL(route, oc.url), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 1000) }; }
  if (!response.ok) throw new Error(redact(String(data?.error?.message || data?.message || `HTTP ${response.status}`)));
  return data;
}

const HTML = `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MECE Control Center</title>
<style>
:root{color-scheme:dark;font:15px system-ui;background:#10131a;color:#edf1f7}
*{box-sizing:border-box}body{margin:0}header{padding:20px;background:#191f2b;border-bottom:1px solid #30394a}
h1{font-size:22px;margin:0}small,.muted{color:#9ca9bb}
nav{display:flex;gap:8px;padding:12px;overflow:auto;background:#151a24;position:sticky;top:0;z-index:2}
button,.tab{border:1px solid #3b4659;background:#222b3a;color:#f4f6fa;border-radius:10px;padding:10px 14px;font:inherit;cursor:pointer}
.tab.active{background:#365b91;border-color:#638cc8}
button.run{background:#245b49;border-color:#39866b}
button.warn{background:#612a2a;border-color:#9c4d4d}
button:disabled{opacity:.45;cursor:wait}
main{padding:14px;max-width:1080px;margin:auto}
.panel{display:none}.panel.active{display:block}
body:not(.authenticated) nav,body:not(.authenticated) main{display:none}
.card{background:#191f2b;border:1px solid #30394a;border-radius:14px;padding:15px;margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
label{display:block;margin:10px 0 4px;color:#c8d2e3}
input,textarea,select{width:100%;border:1px solid #3b4659;background:#0b0e14;color:#edf1f7;border-radius:10px;padding:9px;font:inherit}
textarea{min-height:120px}
.row{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}
.pill{font-size:12px;border-radius:20px;padding:4px 9px;background:#29384a}
.green{color:#75d7a5}.red{color:#ff9292}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0b0e14;padding:12px;border-radius:10px;max-height:42vh;overflow:auto}
.msg{padding:9px;border-radius:10px;margin:6px 0;background:#151a24}
.msg.user{background:#24344f}.msg.assistant{background:#1f3127}
button:focus-visible{outline:2px solid #8bb9ff}
</style></head><body>
<header><div class="row"><div><h1>MECE Control Center</h1>
<small id="projectHead">ugc · OpenCode · Termux</small></div><span id="state" class="pill">Verbinde…</span></div></header>
<nav>
<button class="tab active" data-tab="agents">Agenten</button>
<button class="tab" data-tab="automations">Automations</button>
<button class="tab" data-tab="mcp">MCP</button>
<button class="tab" data-tab="chat">Chat</button>
<button class="tab" data-tab="tasks">Tasks</button>
<button class="tab" data-tab="runs">Runs</button>
<button class="tab" data-tab="settings">Settings</button>
</nav>
<div id="login" class="card" style="max-width:560px;margin:24px auto">
<h2>Control Center freischalten</h2>
<p class="muted">Bitte den lokal gesetzten <code>MECE_DASHBOARD_TOKEN</code> eingeben. Er wird nur in dieser Browser-Session (<code>sessionStorage</code>) gehalten, nie an die Seite ausgeliefert und nicht protokolliert.</p>
<input id="tokenInput" type="password" autocomplete="off" spellcheck="false" placeholder="MECE_DASHBOARD_TOKEN">
<p class="row"><button id="tokenSave" class="run">Freischalten</button><span id="tokenStatus" class="muted"></span></p>
</div>
<main>
<section id="agents" class="panel active">
<h2>Agenten</h2><p class="muted">Vorkonfigurierte OpenCode-Subagenten aus .opencode/agents/.</p>
<div id="agentList">Lade Agenten…</div></section>

<section id="automations" class="panel">
<h2>Automations</h2><p class="muted">Vorkonfigurierte MECE-Workflows und Prompts.</p>
<div id="automationList"></div></section>

<section id="mcp" class="panel">
<h2>MCP Connector</h2><p class="muted">Bestehende MCP-Server aus der OpenCode-Konfiguration. Secrets werden nicht angezeigt.</p>
<div id="mcpList">Lade MCP-Server…</div>
<div class="card"><h3>MCP-Server bearbeiten</h3>
<form id="mcpForm">
<label>Name</label><input name="name">
<label>Transport</label><select name="transport"><option value="local">local</option><option value="remote">remote</option></select>
<label>URL (remote)</label><input name="url">
<label>Kommando (local)</label><input name="command">
<label>Argumente (eine pro Zeile, local)</label><textarea name="args"></textarea>
<label>Arbeitsverzeichnis (local, optional)</label><input name="cwd">
<label>Umgebungsvariablen (JSON, optional)</label><textarea name="env"></textarea>
<label>Header (JSON, optional, remote)</label><textarea name="headers"></textarea>
<label><input type="checkbox" name="enabled"> Aktiviert</label>
<label><input type="checkbox" name="confirmEnable"> Aktivierung bestaetigen</label>
<div class="row"><button type="button" id="mcpSave" class="run">Konfiguration speichern</button><button type="button" id="mcpDisable" class="warn">Deaktivieren</button><button type="button" id="mcpTest">Verbindung pruefen</button></div>
<p id="mcpStatus" class="muted"></p>
</form>
<pre id="mcpCommandOutput">Noch keine MCP-Pruefung.</pre></div></section>

<section id="chat" class="panel">
<h2>KI Chat</h2><p class="muted">Chat mit dem lokalen OpenCode-Server (Port 4096). Modell wird automatisch erkannt; Startfehler werden sichtbar angezeigt, keine stillen kostenpflichtigen Wechsel.</p>
<div class="card row">
<label style="flex:1">Agent</label><select id="chatAgent"></select>
<label style="flex:1">Modell (kostenlos)</label><select id="chatModel"></select>
<label style="flex:1">Session</label><select id="chatSession"></select>
<button id="chatNewSession">Neue Session</button>
<button id="chatAbort" class="warn">Abbrechen</button>
</div>
<div class="card">
<div id="chatMessages" style="min-height:120px">Noch keine Nachrichten.</div>
<label>Nachricht</label><textarea id="chatInput"></textarea>
<div class="row"><button id="chatSend" class="run">Senden</button><span id="chatStatus" class="muted"></span></div>
<p id="chatModelError" class="muted"></p>
</div></section>

<section id="tasks" class="panel">
<h2>Aufgabenwarteschlange</h2><p class="muted">Echte Daten aus dem Controller-Status und den Queuedateien. Der Controller steuert Ausführung, Cooldowns und Wiederaufnahme.</p>
<div id="controllerState" class="card">Lade Controller-Status…</div>
<h3>Warteschlange</h3><div id="taskQueue"></div>
<h3>Abgeschlossen</h3><div id="taskCompleted"></div>
<h3>Fehlgeschlagen / blockiert</h3><div id="taskFailed"></div></section>

<section id="runs" class="panel">
<h2>Runs</h2><div class="card"><div class="row">
<strong id="runName">Kein Lauf gestartet</strong><span id="runState" class="pill">Idle</span>
</div><p id="runMeta" class="muted"></p><pre id="log">Noch keine Ausgabe.</pre>
<button id="refreshLog">Aktualisieren</button></div>
<h3>Run-Historie</h3><div id="runHistory">Noch keine Historie.</div></section>

<section id="settings" class="panel">
<h2>Einstellungen</h2><form id="settingsForm">
<label>Projektverzeichnis</label><input name="projectPath">
<label>App-Server</label><input name="appServerUrl">
<label>Logpfad</label><input name="logPath">
<label>Agent</label><select name="agent"></select>
<label>Modell</label><input name="model">
<label>Max. Reparaturrunden</label><input name="maxRepairRounds" type="number" min="0" max="10">
<label>Workflow-Sequenz</label><input name="workflow">
<label>Gewaehlte Automation</label><select name="automation"></select>
<label>Prompt / Automation-Form</label><textarea name="prompt"></textarea>
<div class="row"><button type="submit">Speichern</button><button type="button" id="startBtn" class="run">Automation starten</button></div>
<p id="settingsStatus" class="muted"></p>
</form></section>
</main>
<script>
const $=id=>document.getElementById(id);
const tabs=document.querySelectorAll(".tab");
tabs.forEach(t=>t.onclick=()=>{tabs.forEach(x=>x.classList.remove("active"));document.querySelectorAll(".panel").forEach(x=>x.classList.remove("active"));t.classList.add("active");$(t.dataset.tab).classList.add("active");});
let APP={};
let agents=[];
let automations=[];
let mcpServers=[];
let CONTROL_TOKEN=sessionStorage.getItem("mece_control_token")||"";
async function api(url,opts={}){
  const headers=new Headers(opts.headers||{});
  if(CONTROL_TOKEN)headers.set("X-Control-Token",CONTROL_TOKEN);
  const r=await fetch(url,{...opts,headers});
  const d=await r.json().catch(()=> ({}));
  if(r.status===401){CONTROL_TOKEN="";sessionStorage.removeItem("mece_control_token");showLogin("Token ungueltig oder abgelaufen.");}
  if(!r.ok)throw new Error(d.error||("HTTP "+r.status));
  return d;
}
function showLogin(message){
  document.body.classList.remove("authenticated");
  $("login").style.display="block";
  $("tokenStatus").textContent=message||"";
  $("tokenInput").focus();
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function jsonText(value){if(typeof value==="string")return value;try{return JSON.stringify(value||{},null,2);}catch{return "{}";}}
function relativeAge(value){
  if(!value||value==="-")return "-";
  const ms=Date.parse(String(value));
  if(!Number.isFinite(ms))return String(value);
  const age=Math.max(0,Date.now()-ms);
  const minutes=Math.floor(age/60000);
  if(minutes<1)return "gerade eben";
  const hours=Math.floor(minutes/60);
  if(hours<24)return "vor "+minutes+" Min";
  return "vor "+Math.floor(hours/24)+" Tag(en) ("+String(value)+")";
}
async function init(){
  if(!CONTROL_TOKEN){showLogin("Token erforderlich (fail-closed).");return;}
  const d=await api("/api/bootstrap");
  APP=d.config; agents=d.agents; automations=d.automations; mcpServers=d.mcp||[];
  renderAgents(); renderAutomations(); renderMcp(); fillSettings(); fillChatAgents();
  await refreshRuns().catch(()=>{});
  await refreshTasks().catch(()=>{});
  await refreshChatModel();
  await loadChatSessions();
  $("projectHead").textContent=APP.projectPath+" · OpenCode "+d.version+(d.ugc&&d.ugc.reachable?" · UGC online":" · UGC offline");
  $("state").textContent=d.controller&&d.controller.status?("Controller: "+d.controller.status):"Bereit";
  document.body.classList.add("authenticated");
  $("login").style.display="none";
}
function renderAgents(){
  $("agentList").innerHTML=agents.map(a=>'<div class="card"><div class="row"><strong>'+esc(a.name)+'</strong><span class="pill">'+esc(a.mode)+'</span></div>'+
  '<p class="muted">'+esc(a.description)+'</p>'+
  '<div class="grid"><div><label>Modell</label><input value="'+esc(a.model)+'" readonly></div>'+
  '<div><label>Berechtigungen</label><input value="'+esc(typeof a.permissions==="string"?a.permissions:JSON.stringify(a.permissions))+'" readonly></div></div>'+
  '<label>Aufgabe</label><textarea readonly>'+esc(a.task)+'</textarea></div>').join("")||'<div class="card">Keine Agenten.</div>';
}
function renderAutomations(){
  $("automationList").innerHTML=automations.map(a=>'<div class="card"><div class="row"><div><h3>'+esc(a.name)+'</h3><small>'+esc(a.description)+'</small></div><span class="pill">'+esc(a.agent)+'</span></div>'+
  '<label>Prompt</label><textarea readonly>'+esc(a.prompt)+'</textarea></div>').join("")||'<div class="card">Keine Automations.</div>';
}
function renderMcp(){
  const list=mcpServers.length?mcpServers.map(s=>'<div class="card"><div class="row"><strong>'+esc(s.name)+'</strong><span class="pill">'+(s.enabled?"aktiv":"inaktiv")+' · '+esc(s.transport)+'</span></div>'+
    '<p class="muted">'+esc(s.source||"config")+': '+(s.transport==="remote"?esc(s.url):esc(s.command)+" "+esc((s.args||[]).join(" ")))+'</p>'+
    '<p class="muted">Secrets: '+(s.hasSecrets?"vorhanden aber nicht angezeigt":"keine")+'</p>'+
    '<button data-mcp="'+esc(s.name)+'" class="run">In Formular laden</button></div>').join(""):'<div class="card">Keine MCP-Server konfiguriert.</div>';
  $("mcpList").innerHTML=list;
  document.querySelectorAll("[data-mcp]").forEach(b=>b.onclick=()=>fillMcpForm(b.dataset.mcp));
}
function fillMcpForm(name){
  const s=mcpServers.find(x=>x.name===name);
  if(!s) return;
  const f=$("mcpForm").elements;
  f.name.value=s.name;
  f.transport.value=s.transport;
  f.url.value=s.url||"";
  f.command.value=s.command||"";
  f.args.value=(s.args||[]).join("\\n");
  f.cwd.value=s.cwd||"";
  f.env.value=jsonText(Object.fromEntries((s.envKeys||[]).map(k=>[k,""])));
  f.headers.value=jsonText(Object.fromEntries((s.headerKeys||[]).map(k=>[k,""])));
  f.enabled.checked=Boolean(s.enabled);
  f.confirmEnable.checked=false;
  $("mcpStatus").textContent="Geladen: "+s.name+" ("+s.source+"). Secret-Felder bleiben leer und werden bei Eingabe ersetzt.";
}
function currentMcpFormData(){
  const f=$("mcpForm").elements;
  let env={}; let headers={};
  const envText=f.env.value.trim(); const headerText=f.headers.value.trim();
  if(envText){try{env=JSON.parse(envText);}catch{throw new Error("Umgebungsvariablen: ungueltiges JSON");}}
  if(headerText){try{headers=JSON.parse(headerText);}catch{throw new Error("Header: ungueltiges JSON");}}
  return {
    name:f.name.value.trim(),
    transport:f.transport.value,
    url:f.url.value.trim(),
    command:f.command.value.trim(),
    args:f.args.value.split(/\\n+/).map(x=>x.trim()).filter(Boolean),
    cwd:f.cwd.value.trim(),
    env, headers,
    enabled:f.enabled.checked,
    confirmEnable:f.confirmEnable.checked
  };
}
async function saveMcp(){
  const data=currentMcpFormData();
  const res=await api("/api/mcp/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
  $("mcpStatus").textContent="Gespeichert: "+data.name;
  await refreshMcp();
}
async function disableMcp(){
  const f=$("mcpForm").elements;
  const data=currentMcpFormData();
  data.enabled=false; data.confirmEnable=false;
  await api("/api/mcp/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
  $("mcpStatus").textContent="Deaktiviert: "+data.name;
  await refreshMcp();
}
async function testMcp(){
  const data=currentMcpFormData();
  try{
    if(data.name) await saveMcp();
  }catch(err){
    $("mcpStatus").textContent="Speichern fehlgeschlagen: "+err.message;
    $("mcpCommandOutput").textContent="Keine Pruefung, weil das Speichern fehlgeschlagen ist.";
    return;
  }
  const res=await api("/api/mcp/test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:data.name})});
  const output=String(res.output||"");
  $("mcpCommandOutput").textContent=output||"Keine Ausgabe.";
  const noServers=/no mcp servers configured|keine mcp-server/i.test(output);
  $("mcpStatus").textContent=noServers
    ? "Keine MCP-Server konfiguriert – nichts geprueft."
    : res.ok
      ? "MCP-Serverliste geprueft (Exit "+esc(res.code)+")."
      : "Pruefung fehlgeschlagen (Exit "+esc(res.code)+").";
}
async function refreshMcp(){
  const d=await api("/api/mcp");
  mcpServers=d.servers||[];
  renderMcp();
}
function fillSelects(){
  const agentSelect=$("settingsForm").elements.agent;
  const automationSelect=$("settingsForm").elements.automation;
  agentSelect.innerHTML=agents.map(a=>'<option value="'+esc(a.name)+'">'+esc(a.name)+'</option>').join("");
  automationSelect.innerHTML=automations.map(a=>'<option value="'+esc(a.name)+'">'+esc(a.name)+'</option>').join("");
}
function fillSettings(){
  fillSelects();
  const f=$("settingsForm").elements;
  f.projectPath.value=APP.projectPath;
  f.appServerUrl.value=APP.appServerUrl;
  f.logPath.value=APP.logPath;
  f.agent.value=APP.agent;
  f.model.value=APP.model;
  f.maxRepairRounds.value=APP.maxRepairRounds;
  f.workflow.value=APP.workflow;
  f.automation.value=APP.automation;
  f.prompt.value=APP.prompt;
}
async function saveSettings(){
  const f=$("settingsForm").elements;
  APP={
    projectPath:f.projectPath.value,
    appServerUrl:f.appServerUrl.value,
    logPath:f.logPath.value,
    agent:f.agent.value,
    model:f.model.value,
    maxRepairRounds:Number(f.maxRepairRounds.value||0),
    workflow:f.workflow.value,
    automation:f.automation.value,
    prompt:f.prompt.value
  };
  const d=await api("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(APP)});
  APP=d.config;
  $("settingsStatus").textContent="Gespeichert: "+new Date().toLocaleTimeString();
}
async function startAutomation(){
  await saveSettings();
  const res=await api("/api/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(APP)});
  tabs.forEach(x=>x.classList.remove("active"));document.querySelectorAll(".panel").forEach(x=>x.classList.remove("active"));
  document.querySelector('[data-tab="runs"]').classList.add("active");$("runs").classList.add("active");
  await refreshRuns();
  $("runState").textContent=res.job.state;
}
async function refreshRuns(){
  const d=await api("/api/status");
  $("runName").textContent=d.job.name||"Kein Lauf gestartet";
  $("runState").textContent=d.job.state||"Idle";
  $("runMeta").textContent=d.job.started?("Start: "+d.job.started+" · PID: "+(d.job.pid||"-")+" · Exit: "+(d.job.exitCode??"-")):"";
  const logData=await api("/api/log").catch(()=>({log:""}));
  $("log").textContent=logData.log||"Noch keine Ausgabe.";
  $("runHistory").innerHTML=(d.runs||[]).map(r=>'<div class="card"><strong>'+esc(r.name)+'</strong><br><small>'+esc(r.started||"")+' · Exit '+esc(r.exitCode??"-")+'</small></div>').join("")||'Noch keine Historie.';
}
async function refreshTasks(){
  try{
    const d=await api("/api/tasks");
    const c=d.controller||{};
    $("controllerState").innerHTML='<div class="row"><strong>Status: '+esc(c.status||"unknown")+'</strong><span class="muted">Queue: '+(c.queueDepth??"-")+' · Stand: '+esc(relativeAge(c.updatedAt))+'</span></div>'+
      '<p class="muted">Aktuelle Aufgabe: '+esc(c.currentTask?(c.currentTask.text||c.currentTask.taskId||c.currentTask.id):"keine")+
      (c.model&&c.model.activeModel?" · Modell: "+esc(c.model.activeModel):"")+
      (c.heartbeatAgeSeconds!==null&&c.heartbeatAgeSeconds!==undefined?" · Heartbeat: "+esc(c.heartbeatAgeSeconds)+"s":"")+'</p>';
    const list=items=>items.map(t=>'<div class="msg">'+esc(String(t).split("|").pop())+'</div>').join("")||'<p class="muted">Keine Eintraege.</p>';
    $("taskQueue").innerHTML=list(d.queued||[]);
    $("taskCompleted").innerHTML=list(d.completed||[]);
    $("taskFailed").innerHTML=list(d.failed||[]);
  }catch(e){$("controllerState").textContent="Controller-Status nicht verfuegbar: "+e.message;}
}
function fillChatAgents(){
  const select=$("chatAgent");
  select.innerHTML=((APP.chatAgents)||${JSON.stringify(CHAT_AGENTS)}).map(a=>'<option value="'+esc(a)+'">'+esc(a)+'</option>').join("");
  select.value=APP.agent||"orchestrator";
}
async function loadChatSessions(){
  try{
    const d=await api("/api/chat/sessions");
    const sessions=d.sessions||d.data||[];
    $("chatSession").innerHTML=sessions.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.title||s.id)+'</option>').join("")||'<option value="">Keine Sessions</option>';
  }catch(e){
    $("chatStatus").textContent="Session-Liste fehlgeschlagen: "+e.message;
  }
}
async function newChatSession(){
  const title="MECE Chat "+new Date().toLocaleTimeString();
  const d=await api("/api/chat/session/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title})});
  await loadChatSessions();
  $("chatSession").value=(d.session&&d.session.id)||"";
  await refreshChatMessages();
}
async function refreshChatMessages(){
  const sid=$("chatSession").value;
  if(!sid) return;
  try{
    const d=await api("/api/chat/messages?session="+encodeURIComponent(sid));
    const messages=d.messages||d.data||[];
    $("chatMessages").innerHTML=messages.map(m=>{
      const text=(m.parts||[]).filter(p=>p.type==="text").map(p=>p.text).join("\\n")||m.content||"";
      const role=m.role||m.info?.role||"unknown";
      return '<div class="msg '+esc(role)+'"><strong>'+esc(role)+'</strong><br>'+esc(text)+'</div>';
    }).join("")||"Keine Nachrichten.";
  }catch(e){
    $("chatStatus").textContent="Nachrichten laden fehlgeschlagen: "+e.message;
  }
}
async function sendChat(){
  const sid=$("chatSession").value;
  const text=$("chatInput").value.trim();
  if(!sid||!text) return;
  $("chatStatus").textContent="Sende…";
  try{
    await api("/api/chat/message",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionID:sid,text,agent:$("chatAgent").value,model:$("chatModel").value})});
    $("chatInput").value="";
    await refreshChatMessages();
    $("chatStatus").textContent="Antwort empfangen.";
  }catch(e){
    $("chatStatus").textContent="Fehler: "+e.message;
  }
}
async function abortChat(){
  const sid=$("chatSession").value;
  if(!sid) return;
  await api("/api/chat/abort",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionID:sid})});
  $("chatStatus").textContent="Session abgebrochen.";
  await refreshChatMessages();
}
async function refreshChatModel(){
  let selectedModel="-";
  try{
    const d=await api("/api/chat/model");
    const options=d.available||[];
    $("chatModel").innerHTML=options.map(m=>'<option value="'+esc(m)+'">'+esc(m)+'</option>').join("");
    selectedModel=d.model||options[0]||"-";
    $("chatModel").value=selectedModel;
  }catch(e){
    $("chatModelError").textContent="Modelle nicht geladen: "+e.message;
    return;
  }
  try{
    const state=await api("/api/chat/state");
    const runtime=state.startupError
      ? "Startfehler: "+state.startupError
      : state.starting
        ? "Server startet"
        : state.url
          ? "Server aktiv"
          : "Server nicht gestartet";
    $("chatModelError").textContent="OpenCode "+(state.version||"?")+" · "+runtime+" · Modell "+esc(selectedModel);
    if(state.startupError||state.starting||!state.url){
      $("chatStatus").textContent="Chat-Runtime nicht verfuegbar: "+(state.startupError||"OpenCode-Server nicht gestartet");
    }
  }catch(e){
    $("chatModelError").textContent="OpenCode · Runtime nicht erkannt: "+e.message+" · Modell "+esc(selectedModel);
  }
}
$("tokenSave").onclick=()=>{
  const value=$("tokenInput").value.trim();
  if(!value){$("tokenStatus").textContent="Token darf nicht leer sein.";return;}
  CONTROL_TOKEN=value;
  sessionStorage.setItem("mece_control_token",value);
  $("tokenInput").value="";
  $("tokenStatus").textContent="";
  init().catch(err=>{$("tokenStatus").textContent="Freischaltung fehlgeschlagen: "+err.message;});
};
$("chatModel").onchange=()=>{
  api("/api/chat/model",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:$("chatModel").value})})
    .then(()=>{$("chatModelError").textContent="Modell gespeichert: "+$("chatModel").value;})
    .catch(err=>{$("chatModelError").textContent="Modell nicht gespeichert: "+err.message;});
};
$("settingsForm").onsubmit=e=>{e.preventDefault();saveSettings().catch(err=>alert("Speichern fehlgeschlagen: "+err));};
$("startBtn").onclick=()=>startAutomation().catch(err=>alert("Start fehlgeschlagen: "+err));
$("refreshLog").onclick=()=>refreshRuns().catch(err=>alert(err));
$("mcpSave").onclick=()=>saveMcp().catch(err=>alert(err));
$("mcpDisable").onclick=()=>disableMcp().catch(err=>alert(err));
$("mcpTest").onclick=()=>testMcp().catch(err=>alert(err));
$("chatSend").onclick=sendChat;
$("chatNewSession").onclick=()=>newChatSession().catch(err=>alert(err));
$("chatAbort").onclick=()=>abortChat().catch(err=>alert(err));
$("chatSession").onchange=refreshChatMessages;
init().catch(err=>{if(err.message&&/HTTP 401|Zugriff|Token/.test(err.message))showLogin(err.message);else $("log").textContent=String(err);});
setInterval(()=>{
  if(!CONTROL_TOKEN)return;
  if($("runs").classList.contains("active"))refreshRuns().catch(()=>{});
  if($("tasks").classList.contains("active"))refreshTasks().catch(()=>{});
  if($("chat").classList.contains("active"))refreshChatMessages().catch(()=>{});
},5000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    if (!isAllowedOrigin(req.headers.origin)) return json(res, 403, { error: "Origin nicht erlaubt" });
    if (!dashboardAuthorized(req)) {
      return json(res, 401, {
        error: dashboardTokenValid() ? "Zugriff verweigert" : "MECE_DASHBOARD_TOKEN ist nicht gesetzt"
      });
    }
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(HTML);
  }
  if (req.method === "GET" && (url.pathname === "/api/bootstrap" || url.pathname === "/api/status")) {
    const versionResult = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 5000 });
    const data = {
      project: ROOT,
      version: (versionResult.stdout || versionResult.stderr || "nicht erkannt").trim(),
      config: loadConfig(),
      agents: listAgents(),
      automations: listAutomations(),
      mcp: readMcpConfig(),
      chatAgents: CHAT_AGENTS,
      freeModels: freeModels(),
      dashboardAuthEnabled: dashboardTokenValid(),
      job,
      runs: readRuns(),
      ugc: await ugcHealth(),
      controller: controllerState(),
      oc: { url: oc.url, startupError: oc.startupError, starting: oc.starting }
    };
    return json(res, 200, data);
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, { config: loadConfig() });
  }
  if (req.method === "POST" && url.pathname === "/api/config") {
    if (!isAllowedOrigin(req.headers.origin)) return json(res, 403, { error: "Origin nicht erlaubt" });
    let body = "";
    try { body = await readBody(req); } catch { return json(res, 413, { error: "Request zu gross" }); }
    let input = {};
    try { input = JSON.parse(body); } catch { return json(res, 400, { error: "Ungueltiges JSON" }); }
    const current = loadConfig();
    const next = {
      ...current,
      ...input,
      projectPath: ROOT,
      appServerUrl: String(input.appServerUrl || current.appServerUrl || "http://127.0.0.1:3000"),
      logPath: String(input.logPath || current.logPath),
      agent: String(input.agent || current.agent),
      model: String(input.model || current.model),
      maxRepairRounds: Math.max(0, Math.min(10, Number(input.maxRepairRounds ?? current.maxRepairRounds))),
      workflow: String(input.workflow || current.workflow),
      automation: String(input.automation || current.automation),
      prompt: String(input.prompt || current.prompt).slice(0, 20000)
    };
    if (!ALLOWED_AUTOMATIONS.includes(next.automation)) return json(res, 400, { error: "Automation nicht freigegeben" });
    if (!isAllowedAgent(next.agent)) return json(res, 400, { error: "Agent nicht erlaubt" });
    if (!isFreeModel(next.model)) return json(res, 400, { error: "Nur verifiziert kostenlose OpenCode-Modelle sind erlaubt" });
    if (!isAllowedLogPath(next.logPath)) return json(res, 400, { error: "Logpfad nicht erlaubt" });
    if (!Number.isFinite(next.maxRepairRounds)) return json(res, 400, { error: "Ungueltige Reparaturrunden" });
    saveConfig(next);
    return json(res, 200, { config: next });
  }
  if (req.method === "POST" && url.pathname === "/api/run") {
    if (!isAllowedOrigin(req.headers.origin)) return json(res, 403, { error: "Origin nicht erlaubt" });
    if (job.state === "running") return json(res, 409, { error: "Es laeuft bereits ein Auftrag" });
    let body = "";
    try { body = await readBody(req); } catch { return json(res, 413, { error: "Request zu gross" }); }
    let input = {};
    try { input = JSON.parse(body); } catch { return json(res, 400, { error: "Ungueltiges JSON" }); }
    const config = loadConfig();
    const requestConfig = { ...config, ...input };
    const automationName = String(requestConfig.automation || "").trim();
    if (!ALLOWED_AUTOMATIONS.includes(automationName)) return json(res, 400, { error: "Automation nicht freigegeben" });
    const projectPath = String(requestConfig.projectPath || "").trim();
    if (!projectPath || !fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) return json(res, 400, { error: "Projektverzeichnis nicht gefunden" });
    const prompt = String(requestConfig.prompt || commandPrompt(automationName)).trim();
    if (!prompt || prompt.length > 20000) return json(res, 400, { error: "Prompt ungueltig" });
    const agent = String(requestConfig.agent || "orchestrator").trim();
    const model = String(requestConfig.model || DEFAULT_MODEL).trim();
    if (!isAllowedAgent(agent)) return json(res, 400, { error: "Agent nicht erlaubt" });
    if (!isFreeModel(model)) return json(res, 400, { error: "Nur verifiziert kostenlose OpenCode-Modelle sind erlaubt" });
    if (!isAllowedLogPath(requestConfig.logPath || "")) return json(res, 400, { error: "Logpfad nicht erlaubt" });
    const log = path.join(RUNS, automationName + "-" + Date.now() + ".log");
    const out = fs.createWriteStream(log, { flags: "wx" });
    out.write(`MECE Control Center · ${automationName}\nProject: ${projectPath}\nAgent: ${agent}\nModel: ${model}\nMax repair rounds: ${requestConfig.maxRepairRounds}\nLog source: ${requestConfig.logPath || ""}\n\n`);
    const args = ["run", "--dir", projectPath, "--agent", agent, "--model", model, "--title", `MECE ${automationName}`, prompt];
    const child = spawn("opencode", args, { cwd: projectPath, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const handle = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      try { out.write("\nTIMEOUT: Lauf nach Zeitlimit beendet.\n"); } catch {}
    }, DEFAULT_RUN_TIMEOUT_MS);
    job = { state: "running", name: automationName, pid: child.pid, log, started: new Date().toISOString(), exitCode: null, timeoutHandle: handle };
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("error", (error) => {
      try { out.write("\nSPAWN ERROR: " + error.message); } catch {}
      out.end();
      clearTimeout(handle);
      finishJob(-1);
    });
    child.on("close", (code) => {
      try { out.end(`\n\nProcess beendet. Exit-Code: ${code}\n`); } catch {}
      clearTimeout(handle);
      finishJob(code);
    });
    saveConfig(requestConfig);
    return json(res, 202, { ok: true, name: automationName, job });
  }
  if (req.method === "GET" && url.pathname === "/api/log") {
    if (!job.log || !fs.existsSync(job.log)) return json(res, 200, { log: "" });
    const buffer = fs.readFileSync(job.log);
    return json(res, 200, { log: buffer.subarray(Math.max(0, buffer.length - 24000)).toString("utf8") });
  }
  if (req.method === "GET" && url.pathname === "/api/agents") {
    return json(res, 200, { agents: listAgents() });
  }
  if (req.method === "GET" && url.pathname === "/api/automations") {
    return json(res, 200, { automations: listAutomations() });
  }
  if (req.method === "GET" && url.pathname === "/api/mcp") {
    return json(res, 200, { servers: readMcpConfig() });
  }
  if (req.method === "POST" && url.pathname === "/api/mcp/save") {
    if (!isAllowedOrigin(req.headers.origin)) return json(res, 403, { error: "Origin nicht erlaubt" });
    let body = "";
    try { body = await readBody(req); } catch { return json(res, 413, { error: "Request zu gross" }); }
    let input = {};
    try { input = JSON.parse(body); } catch { return json(res, 400, { error: "Ungueltiges JSON" }); }
    const validation = validateMcpInput(input);
    if (!validation.ok) return json(res, 400, { error: validation.error });
    try {
      mergeMcpProject(input);
    } catch (error) {
      return json(res, 500, { error: "MCP-Konfiguration konnte nicht gespeichert werden: " + redact(error.message) });
    }
    return json(res, 200, { ok: true, servers: readMcpConfig() });
  }
  if (req.method === "POST" && url.pathname === "/api/mcp/delete") {
    if (!isAllowedOrigin(req.headers.origin)) return json(res, 403, { error: "Origin nicht erlaubt" });
    let body = "";
    try { body = await readBody(req); } catch { return json(res, 413, { error: "Request zu gross" }); }
    let input = {};
    try { input = JSON.parse(body); } catch { return json(res, 400, { error: "Ungueltiges JSON" }); }
    const name = String(input.name || "").trim();
    if (!MCP_NAME_RE.test(name)) return json(res, 400, { error: "Ungueltiger MCP-Servername" });
    try {
      mergeMcpProject({ name }, true);
    } catch (error) {
      return json(res, 500, { error: redact(error.message) });
    }
    return json(res, 200, { ok: true, servers: readMcpConfig() });
  }
  if (req.method === "POST" && url.pathname === "/api/mcp/test") {
    if (!isAllowedOrigin(req.headers.origin)) return json(res, 403, { error: "Origin nicht erlaubt" });
    const result = describeMcpStatus();
    return json(res, 200, { ok: result.code === 0, code: result.code, output: result.output });
  }
  if (req.method === "GET" && url.pathname === "/api/tasks") {
    const tasks = controllerTasks();
    return json(res, 200, {
      controller: controllerState(),
      queued: tasks.queued,
      completed: tasks.completed,
      failed: tasks.failed,
      source: tasks.source
    });
  }
  if (req.method === "GET" && url.pathname === "/api/chat/model") {
    return json(res, 200, { model: loadConfig().model, available: freeModels() });
  }
  if (req.method === "POST" && url.pathname === "/api/chat/model") {
    if (!isAllowedOrigin(req.headers.origin)) return json(res, 403, { error: "Origin nicht erlaubt" });
    let body = "";
    try { body = await readBody(req); } catch { return json(res, 413, { error: "Request zu gross" }); }
    let input = {};
    try { input = JSON.parse(body); } catch { return json(res, 400, { error: "Ungueltiges JSON" }); }
    const model = String(input.model || "").trim();
    if (!isFreeModel(model)) return json(res, 400, { error: "Nur verifiziert kostenlose OpenCode-Modelle sind erlaubt" });
    const config = loadConfig();
    config.model = model;
    saveConfig(config);
    return json(res, 200, { model, available: freeModels() });
  }
  if (req.method === "GET" && url.pathname === "/api/chat/state") {
    const versionResult = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 5000 });
    return json(res, 200, {
      url: oc.url,
      startupError: oc.startupError || null,
      starting: oc.starting,
      model: loadConfig().model,
      agents: CHAT_AGENTS,
      version: (versionResult.stdout || versionResult.stderr || "nicht erkannt").trim(),
      sdkMode: "http-api"
    });
  }
  if (req.method === "GET" && url.pathname === "/api/chat/sessions") {
    try {
      const sessions = await ocFetch("/session");
      return json(res, 200, { sessions: Array.isArray(sessions) ? sessions : [] });
    } catch (error) {
      return json(res, 500, { error: redact(error.message) });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/chat/session/create") {
    if (!isAllowedOrigin(req.headers.origin)) return json(res, 403, { error: "Origin nicht erlaubt" });
    let body = "";
    try { body = await readBody(req); } catch { return json(res, 413, { error: "Request zu gross" }); }
    let input = {};
    try { input = JSON.parse(body); } catch { return json(res, 400, { error: "Ungueltiges JSON" }); }
    const title = String(input.title || "MECE Chat").trim().slice(0, 120);
    try {
      return json(res, 200, { session: await ocFetch("/session", { method: "POST", body: { title } }) });
    } catch (error) {
      return json(res, 500, { error: redact(error.message) });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/chat/messages") {
    const sessionID = String(url.searchParams.get("session") || "").trim();
    if (!sessionID || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionID)) return json(res, 400, { error: "session erforderlich" });
    try {
      const messages = await ocFetch(`/session/${encodeURIComponent(sessionID)}/message`);
      return json(res, 200, { messages: Array.isArray(messages) ? messages : [] });
    } catch (error) {
      return json(res, 500, { error: redact(error.message) });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/chat/message") {
    if (!isAllowedOrigin(req.headers.origin)) return json(res, 403, { error: "Origin nicht erlaubt" });
    let body = "";
    try { body = await readBody(req); } catch { return json(res, 413, { error: "Request zu gross" }); }
    let input = {};
    try { input = JSON.parse(body); } catch { return json(res, 400, { error: "Ungueltiges JSON" }); }
    const sessionID = String(input.sessionID || "").trim();
    const text = String(input.text || "").trim();
    const agent = String(input.agent || loadConfig().agent || "orchestrator").trim();
    const model = String(input.model || loadConfig().model).trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionID)) return json(res, 400, { error: "sessionID erforderlich" });
    if (!text || text.length > 10000) return json(res, 400, { error: "Nachricht ungueltig" });
    if (!isAllowedAgent(agent)) return json(res, 400, { error: "Agent nicht erlaubt" });
    if (!isFreeModel(model)) return json(res, 400, { error: "Nur verifiziert kostenlose OpenCode-Modelle sind erlaubt" });
    try {
      const response = await ocFetch(`/session/${encodeURIComponent(sessionID)}/message`, {
        method: "POST",
        body: { model: parseModelId(model), agent, parts: [{ type: "text", text }] },
        timeout: 120000
      });
      return json(res, 200, { response });
    } catch (error) {
      return json(res, 500, { error: redact(error.message) });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/chat/abort") {
    if (!isAllowedOrigin(req.headers.origin)) return json(res, 403, { error: "Origin nicht erlaubt" });
    let body = "";
    try { body = await readBody(req); } catch { return json(res, 413, { error: "Request zu gross" }); }
    let input = {};
    try { input = JSON.parse(body); } catch { return json(res, 400, { error: "Ungueltiges JSON" }); }
    const sessionID = String(input.sessionID || "").trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionID)) return json(res, 400, { error: "sessionID erforderlich" });
    try {
      return json(res, 200, { result: await ocFetch(`/session/${encodeURIComponent(sessionID)}/abort`, { method: "POST" }) });
    } catch (error) {
      return json(res, 500, { error: redact(error.message) });
    }
  }
  json(res, 404, { error: "Nicht gefunden" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`MECE Control Center: http://127.0.0.1:${PORT}`);
  // The OpenCode server is started lazily by chat endpoints to keep the
  // Chromebook-sized host lightweight. Status reports it as not started.
});

function shutdown() {
  try { server.close(); } catch {}
  if (oc.process && !oc.process.killed) {
    try { process.kill(-oc.process.pid, "SIGTERM"); } catch { try { oc.process.kill("SIGTERM"); } catch {} }
  }
  if (job.state === "running" && job.pid) {
    try { process.kill(-job.pid, "SIGTERM"); } catch { try { process.kill(job.pid, "SIGTERM"); } catch {} }
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

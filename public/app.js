const state = {
  view: "overview",
  user: null,
  workspaces: [],
  workspaceId: localStorage.getItem("ugc_workspaceId"),
  data: {
    products: [], creators: [], campaigns: [], tasks: [], assets: [],
    workflows: [], ideas: [], insights: [], experiments: [], agents: [],
    agentTasks: [], contentPosts: [], incidents: [], approvals: [],
    analytics: null, integrations: [], systemStatus: null, summary: null,
    browser: null, niches: [], items: [], candidates: [], discoveryError: null,
    controlStatus: null, media: null,
    apiIntegrations: [], apiIntegrationHealth: null, apiIntegrationDetail: null,
    publishingOverview: null, affiliateRevenue: null, affiliateLinks: [], analyticsSources: null
  },
  loading: false,
  error: null,
  browserSessionId: "",
  authMessage: ""
};

const titles = {overview:"Overview",radar:"Product Radar",creators:"Creators",campaigns:"Campaigns",scripts:"Script Studio",clipping:"Clipping Studio",youtube:"YouTube Intelligence",phaseg:"Phase G Studio",content:"Content Factory",calendar:"Publishing Calendar",analytics:"Analytics & Revenue",agents:"Agent Control",integrations:"Integrations","api-integrations":"API Integration Center","agent-browser":"Agent Browser"};
const CONTROL_FALLBACK_URL = "http://127.0.0.1:3031/";
const WORKFLOW_ACTIONS = ["echo", "delay"];
const MEDIA_LANGUAGES = ["de", "en", "auto"];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function toast(message) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2300);
}

function errorText(err) {
  const code = err && (err.code || (err.details && err.details.code));
  return code ? code + ": " + (err && err.message ? err.message : code) : String(err && err.message || err || "Unknown error");
}

function tag(text, color) { return '<span class="tag '+(color||"")+'">'+esc(text)+"</span>"; }
function heading(title, desc, action) { return '<div class="heading"><div><div class="eyebrow">CREATOR OPERATIONS</div><h1>'+title+'</h1><p>'+desc+'</p></div>'+(action||"")+'</div>'; }
function button(text, action, primary) { return '<button class="btn '+(primary?"primary":"")+'" data-action="'+action+'">'+text+'</button>'; }
function stat(label, value, note, symbol) { return '<article class="stat"><div class="stat-label">'+label+'<span class="symbol">'+symbol+'</span></div><div class="value">'+value+'</div><div class="sub">'+note+'</div></article>'; }

function clearSession() {
  state.user = null;
  state.workspaces = [];
  state.workspaceId = null;
  state.authMessage = "Session expired. Sign in again.";
  try { localStorage.removeItem("ugc_workspaceId"); } catch {}
}

function apiError(res, payload, status) {
  const code = payload && payload.error ? String(payload.error) : null;
  const err = new Error(code || (res && res.statusText) || "HTTP " + status);
  err.status = status;
  err.code = code;
  err.payload = payload;
  return err;
}

async function api(path, opts) {
  opts = opts || {};
  const asBlob = opts.asBlob === true;
  // Only declare JSON when a body exists; Fastify rejects a bare JSON header
  // without a body (this broke /api/auth/logout).
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (state.workspaceId && !path.startsWith("/api/auth")) headers["X-Workspace-Id"] = state.workspaceId;
  const fetchOpts = Object.assign({}, opts, { credentials:"include", headers });
  delete fetchOpts.asBlob;
  const res = await fetch(path, fetchOpts);
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch {}
    // An expired session is an auth transition, not stale data. Do not let the
    // caller paint an error banner over data that no longer belongs to a user.
    const loginRequest = path === "/api/auth/login" || path === "/api/auth/signup";
    if (res.status === 401 && !loginRequest) {
      clearSession();
      renderAuth();
    }
    throw apiError(res, payload, res.status);
  }
  if (asBlob) return res.blob();
  if (res.status === 204) return null;
  const ct = (res.headers && res.headers.get ? res.headers.get("content-type") : "") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

function formatCents(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return "€" + (n / 100).toFixed(2);
}

function parseCents(raw, label) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error((label || "Amount") + " must be a non-negative whole number of cents");
  return value;
}

function centsField(data, key, label) {
  const value = parseCents(data[key], label);
  return value === undefined ? {} : { [key]: value };
}

function parseNumberField(raw, label, opts) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(label + " must be a number");
  if (opts && opts.integer && !Number.isInteger(n)) throw new Error(label + " must be a whole number");
  if (opts && opts.min !== undefined && n < opts.min) throw new Error(label + " must be at least " + opts.min);
  return n;
}

function initials(text) {
  const parts = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function updateProfile() {
  const user = state.user;
  const workspace = state.workspaces[0];
  const name = user ? (user.name || user.email || "Workspace user") : "Not signed in";
  const detail = user
    ? (workspace ? workspace.name + (workspace.role ? " · " + workspace.role : "") : (state.workspaceId ? "Workspace " + state.workspaceId : "No workspace selected"))
    : "Sign in to load workspace data";
  const nameEl = $("#profile-name"); if (nameEl) nameEl.textContent = name;
  const detailEl = $("#profile-detail"); if (detailEl) detailEl.textContent = detail;
  const avatar = $("#profile-avatar"); if (avatar) avatar.textContent = initials(name);
}

function updateRadarBadge() {
  const badge = $("#radar-count");
  if (!badge) return;
  const products = state.data.products;
  if (!Array.isArray(products)) { badge.textContent = ""; badge.hidden = true; return; }
  badge.textContent = String(products.length);
  badge.hidden = products.length === 0;
}

function updateControlLink() {
  const link = $("#control-link");
  if (!link) return;
  const status = state.data.controlStatus;
  const url = status && typeof status.url === "string" && /^https?:\/\//.test(status.url) ? status.url : CONTROL_FALLBACK_URL;
  link.href = url;
  link.title = status && status.reachable
    ? "MECE Control Center (reachable; URL from /api/control/status)"
    : "MECE Control Center (separate loopback service; default URL, status not confirmed)";
}

async function loadMe() {
  try {
    const r = await api("/api/auth/me");
    state.user = r.user;
    state.workspaces = r.workspaces || [];
    if (!state.workspaces.some((w)=>w.id===state.workspaceId)) state.workspaceId = state.workspaces.length ? state.workspaces[0].id : null;
    if (state.workspaceId) localStorage.setItem("ugc_workspaceId", state.workspaceId);
    else localStorage.removeItem("ugc_workspaceId");
    state.authMessage = "";
    updateProfile();
    return true;
  } catch (e) {
    if (e && e.status !== 401) { state.user = null; state.workspaces = []; }
    updateProfile();
    return false;
  }
}

async function loadProductCount() {
  try {
    state.data.products = (await api("/api/products")).products || [];
  } catch (e) {
    if (e && e.status === 401) return;
    state.data.products = null;
  }
  updateRadarBadge();
}

async function loadControlStatus() {
  try { state.data.controlStatus = await api("/api/control/status"); }
  catch (e) { if (e && e.status === 401) return; state.data.controlStatus = null; }
  updateControlLink();
}

function authScreen() {
  return '<div class="page auth-wrap"><section class="panel"><h2>Sign in</h2><form id="login-form" class="field-grid"><div class="field full"><label>Email</label><input name="email" type="email" required></div><div class="field full"><label>Password</label><input name="password" type="password" required></div><div class="field full"><button class="btn primary" type="submit">Login</button></div></form><p class="sub">No account? <a href="#" id="show-signup">Sign up</a></p><div id="auth-msg" class="sub" role="status">'+esc(state.authMessage)+'</div></section></div>';
}

function signupScreen() {
  return '<div class="page auth-wrap"><section class="panel"><h2>Sign up</h2><form id="signup-form" class="field-grid"><div class="field full"><label>Email</label><input name="email" type="email" required></div><div class="field full"><label>Password (min 10)</label><input name="password" type="password" required minlength="10"></div><div class="field full"><label>Name</label><input name="name"></div><div class="field full"><label>Workspace name</label><input name="workspaceName" required></div><div class="field full"><label>Workspace slug</label><input name="workspaceSlug" required></div><div class="field full"><button class="btn primary" type="submit">Create account</button></div></form><p class="sub">Already have an account? <a href="#" id="show-login">Login</a></p><div id="auth-msg" class="sub" role="status">'+esc(state.authMessage)+'</div></section></div>';
}

let authMode = "login";

async function afterAuth() {
  const ok = await loadMe();
  if (!ok) { renderAuth(); return; }
  state.error = null;
  await loadProductCount();
  await loadControlStatus();
  await loadView(state.view);
}

async function handleLogin(e) {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  state.authMessage = "";
  try {
    await api("/api/auth/login", { method:"POST", body: JSON.stringify(d) });
    await afterAuth();
  } catch (err) { const m=$("#auth-msg"); if (m) m.textContent = errorText(err); }
}

async function handleSignup(e) {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  if (!d.name) delete d.name;
  state.authMessage = "";
  try {
    await api("/api/auth/signup", { method:"POST", body: JSON.stringify(d) });
    await afterAuth();
  } catch (err) { const m=$("#auth-msg"); if (m) m.textContent = errorText(err); }
}

async function doLogout() {
  // The server revokes the session on POST; an empty JSON object keeps the
  // request valid for Fastify's JSON body parser.
  try {
    await api("/api/auth/logout", { method:"POST", body: JSON.stringify({}) });
  } catch (err) {
    toast("Logout failed: " + errorText(err));
    return;
  }
  clearSession();
  state.authMessage = "Signed out.";
  renderAuth();
}

async function loadView(view) {
  state.view = view;
  state.loading = true;
  state.error = null;
  render();
  try {
    switch (view) {
      case "overview": {
        const [status, summary, ops] = await Promise.all([
          api("/api/system/status").catch(()=>null),
          api("/api/orchestrator/summary").catch(()=>null),
          api("/api/operations/summary").catch(()=>null)
        ]);
        state.data.systemStatus = status;
        state.data.summary = summary;
        state.data.ops = ops;
        await loadControlStatus();
        break;
      }
      case "radar": state.data.products = (await api("/api/products")).products || []; updateRadarBadge(); break;
      case "creators": state.data.creators = (await api("/api/creators")).creators || []; break;
      case "campaigns": {
        const [campaigns, links] = await Promise.all([
          api("/api/campaigns").then((r)=>r.campaigns||[]),
          api("/api/affiliate/links").then((r)=>r.links||[]).catch(()=>[])
        ]);
        state.data.campaigns = campaigns;
        state.data.affiliateLinks = links;
        break;
      }
      case "analytics": await loadAnalyticsData(); break;
      case "integrations": state.data.integrations = (await api("/api/integrations")).integrations || []; break;
      case "api-integrations": {
        const [center, health] = await Promise.all([
          api("/api/api-integrations"),
          api("/api/api-integrations/health").catch(()=>null)
        ]);
        state.data.apiIntegrations = center.providers || [];
        state.data.apiIntegrationHealth = health;
        state.data.apiIntegrationDetail = null;
        break;
      }
      case "agents": await loadAgentsData(); break;
      case "content": state.data.contentPosts = (await api("/api/content-posts")).posts || []; break;
      case "scripts": state.data.ideas = (await api("/api/ideas")).ideas || []; break;
      case "clipping": await loadClippingData(); break;
      case "youtube": await loadDiscoveryData(); break;
      case "calendar": {
        const [tasks, publishing] = await Promise.all([
          api("/api/tasks").then((r)=>r.tasks||[]),
          api("/api/publishing/overview").catch(()=>null)
        ]);
        state.data.tasks = tasks;
        state.data.publishingOverview = publishing;
        break;
      }
      case "agent-browser": state.data.browser = await loadBrowserData(); break;
    }
  } catch (e) {
    // 401 already switched to the login screen inside api(). Never call it
    // "STALE DATA" — that would invite the user to trust another workspace.
    if (e && e.status === 401) return;
    state.error = errorText(e);
    toast("Error: " + errorText(e));
  } finally {
    state.loading = false;
    render();
  }
}

async function loadAgentsData() {
  const [agents, tasks, engine, ai, publishing] = await Promise.all([
    api("/api/agents").then((r)=>r.agents || []),
    api("/api/agent-tasks").then((r)=>r.tasks || []),
    api("/api/engine/status").catch(()=>null),
    api("/api/ai/status").catch(()=>null),
    api("/api/publishing/overview").catch(()=>null)
  ]);
  state.data.agents = agents;
  state.data.agentTasks = tasks;
  state.data.engine = engine;
  state.data.ai = ai;
  state.data.publishingOverview = publishing;
}

async function loadClippingData() {
  state.data.workflows = (await api("/api/workflows")).workflows || [];
  const media = mediaState();
  if (media.job && media.job.id) {
    try { await pollMediaJob(media.job.id); }
    catch (e) { media.error = mediaErrorText(e); }
  }
}

async function loadDiscoveryData() {
  try {
    state.data.candidates = (await api("/api/discovery/candidates")).candidates || [];
    state.data.discoveryError = null;
  } catch (e) {
    if (e && e.status === 401) throw e;
    state.data.candidates = [];
    state.data.discoveryError = errorText(e);
  }
}

async function loadAnalyticsData() {
  const [summary, posts, sources, revenue, links] = await Promise.all([
    api("/api/analytics/summary").catch(()=>null),
    api("/api/content-posts").catch(()=>({posts:[]})),
    api("/api/analytics/sources").catch(()=>null),
    api("/api/affiliate/revenue").catch(()=>null),
    api("/api/affiliate/links").then((r)=>r.links||[]).catch(()=>[])
  ]);
  state.data.analytics = summary;
  state.data.contentPosts = (posts && posts.posts) || [];
  state.data.analyticsSources = sources;
  state.data.affiliateRevenue = revenue;
  state.data.affiliateLinks = links;
}

function loadingBlock() { return state.loading ? '<p class="sub">Loading…</p>' : ''; }

function overview() {
  const s = state.data.systemStatus;
  const o = state.data.ops || state.data.summary;
  return heading("Your creator engine, at a glance","Live data from backend. Products, creators, campaigns and tasks are persisted in PostgreSQL.", button("Refresh","refresh",true)) +
  '<div class="stats">' +
    stat("DB status", s ? s.status : "—", s ? "version "+s.version : "checking", " ") +
    stat("Workflows", o && o.summary ? o.summary.workflows : "0", "Persisted", "◈") +
    stat("Open incidents", o && o.summary ? o.summary.incidents : "0", "Reliability", "⚠") +
    stat("Content ideas", o && o.summary ? o.summary.ideas : "0", "Persisted", "✳") +
  '</div>' +
  '<div class="notice">Frontend connected to backend API. Data is persisted in PostgreSQL. Integrations show honest status from /api/integrations.</div>' +
  loadingBlock();
}

function radar() {
  const items = state.data.products || [];
  const cards = items.length ? items.map(p=>'<article class="card"><div class="card-top">'+tag(p.category||"product","purple")+'<span class="score">'+formatCents(p.priceCents)+'</span></div><h3>'+esc(p.name)+'</h3><p>Persisted product opportunity.</p><div class="metrics"><div><small>Source</small><b>'+esc(p.source||"—")+'</b></div><div><small>Status</small><b>'+esc(p.status||"new")+'</b></div></div></article>').join("") : '<div class="panel">No products yet. Add one.</div>';
  return heading("Product Radar","Persisted products from /api/products.", button("＋ Add product","add-product",true)) + '<div class="cards">'+cards+'</div>' + loadingBlock();
}

function creators() {
  const rows = state.data.creators || [];
  const body = rows.length ? '<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Creator</th><th>Email</th><th>Niches</th><th>Platforms</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.name)+'</td><td>'+esc(r.email||"—")+'</td><td>'+esc(r.niches||"—")+'</td><td>'+esc(r.platforms||"—")+'</td></tr>').join("")+'</tbody></table></div></section>' : '<div class="panel">No creators yet.</div>';
  return heading("Creators","Persisted creators from /api/creators.", button("＋ Add creator","add-creator",true)) + body + loadingBlock();
}

function campaigns() {
  const rows = state.data.campaigns || [];
  const body = rows.length ? '<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Campaign</th><th>Goal</th><th>Status</th><th>Budget</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.name)+'</td><td>'+esc(r.goal||"—")+'</td><td>'+tag(r.status||"draft")+'</td><td>'+formatCents(r.budgetCents)+'</td></tr>').join("")+'</tbody></table></div></section>' : '<div class="panel">No campaigns yet.</div>';
  const campaignLinks = h5Table("Affiliate links for campaigns", "h5-campaign-affiliate-links", ["Token","Offer","Campaign","Disclosure"],
    (state.data.affiliateLinks||[]).map((l)=>'<tr><td><code>'+esc(l.token)+'</code></td><td>'+esc(l.offerId)+'</td><td>'+esc(l.campaignId||"—")+'</td><td>'+esc(l.disclosureText||"—")+'</td></tr>'));
  return heading("Campaigns","Persisted campaigns from /api/campaigns plus affiliate links.", button("＋ Add campaign","add-campaign",true)) + body + campaignLinks + '<p class="sub"><button class="btn" data-view="analytics" data-testid="h5-campaign-revenue-link">Open Analytics &amp; Revenue</button></p>' + loadingBlock();
}

function scripts() {
  const rows = state.data.ideas || [];
  const body = rows.length ? '<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Idea</th><th>Format</th><th>Score</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.title)+'</td><td>'+esc(r.format||"—")+'</td><td>'+esc(r.score)+'</td></tr>').join("")+'</tbody></table></div></section>' : '<div class="panel">No ideas yet.</div>';
  return heading("Script Studio / Ideas","Persisted content ideas from /api/ideas.", button("＋ Add idea","add-idea",true)) + body + loadingBlock();
}

function workflowStepsHtml(steps) {
  if (!Array.isArray(steps) || !steps.length) return "keine";
  return esc(steps.map((s) => (s && s.name ? s.name : "—") + ":" + (s && s.action ? s.action : "—")).join(", "));
}

function clipping() {
  const rows = state.data.workflows || [];
  const body = rows.length ? '<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Workflow</th><th>Steps</th><th>Run</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.name)+'</td><td>'+workflowStepsHtml(r.steps)+'</td><td><button class="btn" data-action="workflow-run" data-workflow-id="'+esc(r.id)+'">Run</button></td></tr>').join("")+'</tbody></table></div></section>' : '<div class="panel">No workflows yet.</div>';
  const workflowForm = '<section class="panel"><h2>Workflow step editor</h2><form id="workflow-form" class="field-grid"><div class="field full"><label>Name</label><input name="name" required></div><div class="field"><label>Step name</label><input name="stepName"></div><div class="field"><label>Action</label><select name="action">'+WORKFLOW_ACTIONS.map(a=>'<option value="'+a+'">'+a+'</option>').join("")+'</select></div><div class="field"><button class="btn primary" type="submit">Create workflow</button></div></form><p class="sub">Steps use only registered backend actions ('+esc(WORKFLOW_ACTIONS.join(", "))+'). This build has no update route: create a new definition to change steps.</p></section>';
  return heading("Clipping Studio","Persisted workflows via /api/workflows. Media jobs are shown only when the backend returns them.", button("Refresh","refresh",true)) + workflowForm + body + mediaPanel() + loadingBlock();
}

function content() {
  const rows = state.data.contentPosts || [];
  const body = rows.length ? '<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Platform</th><th>External ID</th><th>Title</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.platform)+'</td><td>'+esc(r.externalId)+'</td><td>'+esc(r.title||"—")+'</td></tr>').join("")+'</tbody></table></div></section>' : '<div class="panel">No content posts yet.</div>';
  return heading("Content Factory","Persisted content posts from /api/content-posts.", button("＋ Add post","add-post",true)) + body + loadingBlock();
}

function youtube() {
  const rows = state.data.candidates || [];
  const notice = state.data.discoveryError
    ? '<div class="notice" role="alert">'+esc(state.data.discoveryError)+'. Stored candidates below are the only discovery data shown.</div>'
    : '<div class="notice">Candidates are stored rows from /api/discovery/candidates. A search needs the server-side discovery MCP client/server.</div>';
  const form = '<section class="panel"><h2>Run discovery search</h2><form id="discovery-form" class="field-grid"><div class="field full"><label>Query</label><input name="query" required></div><div class="field"><button class="btn primary" type="submit">Queue search</button></div></form><p class="sub">POST /api/discovery/searches returns 503 DISCOVERY_NOT_CONFIGURED when no provider is configured.</p></section>';
  const body = rows.length ? '<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Title</th><th>Channel</th><th>Link</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.title)+'</td><td>'+esc(r.channel||"—")+'</td><td><a href="'+esc(r.url||"#")+'" target="_blank" rel="noopener noreferrer">Open</a></td></tr>').join("")+'</tbody></table></div></section>' : '<div class="panel">No discovery candidates stored yet.</div>';
  return heading("YouTube Intelligence","Real discovery candidates and searches; no fabricated research.") + notice + form + body + loadingBlock();
}

function phaseg() {
  const out = state.data.phasegOutput ? '<pre class="panel" id="phaseg-output">'+esc(JSON.stringify(state.data.phasegOutput,null,2))+'</pre>' : '<div class="panel" id="phaseg-output">No Phase G request run yet.</div>';
  const form = '<section class="panel"><h2>Phase G Studio</h2><p class="sub">Live YouTube routes fail closed with YOUTUBE_NOT_CONFIGURED until a server-side API key is configured. All other actions use real backend endpoints.</p>'+
  '<p class="sub">Rights: release/pipeline actions send AUTHORIZED as an operator assertion, not as proof of verified rights. Auto clip ranking sends no highlights and returns an empty ranking; use Clipping Studio highlights for real ranking.</p>'+
  '<div class="field-grid"><div class="field full"><label>Discovery query</label><input id="phaseg-query" value="creator workflow"></div>'+
  '<div class="field"><button class="btn primary" data-action="phaseg-youtube">YouTube search</button></div>'+
  '<div class="field"><button class="btn" data-action="phaseg-trending">Trending (DE)</button></div>'+
  '<div class="field"><button class="btn" data-action="phaseg-creators">Creator discovery</button></div>'+
  '<div class="field"><button class="btn" data-action="phaseg-score">Score candidate</button></div>'+
  '<div class="field"><button class="btn" data-action="phaseg-sources">Media sources</button></div>'+
  '<div class="field"><button class="btn" data-action="phaseg-profiles">Production profiles</button></div>'+
  '<div class="field"><button class="btn" data-action="phaseg-quality">Quality reports</button></div>'+
  '<div class="field"><button class="btn" data-action="phaseg-score-save">Persist score</button></div>'+
  '<div class="field"><button class="btn" data-action="phaseg-scores">Stored scores</button></div>'+
  '<div class="field"><button class="btn" data-action="phaseg-auto-clips">Auto clip ranking</button></div>'+
  '<div class="field"><button class="btn" data-action="phaseg-thumbnail">Thumbnail (9:16)</button></div>'+
  '<div class="field"><button class="btn" data-action="phaseg-vtt">SRT → VTT</button></div>'+
  '<div class="field"><button class="btn" data-action="phaseg-release">Request release</button></div>'+
  '<div class="field"><button class="btn" data-action="phaseg-releases">Releases</button></div>'+
  '<div class="field"><button class="btn primary" data-action="phaseg-pipeline">Run full pipeline job</button></div>'+
  '<div class="field full"><label>Source / output name</label><input id="phaseg-source" value="source.mp4"><input id="phaseg-output" value="clip-9x16.mp4"></div>'+
  '<div class="field full"><label>SRT name for SRT → VTT</label><input id="phaseg-srt" value="captions.srt"></div>'+
  '</div></section>';
  return heading("Phase G Studio","Discovery, research, media and quality controls backed by real APIs.") + form + out + loadingBlock();
}

/* Phase H.5 read models. All values come from the API; null stays visible. */
function h5Value(value, suffix) {
  return value === null || value === undefined ? "—" : esc(String(value) + (suffix || ""));
}

function h5Verification(v) {
  if (!v) return '<span data-testid="h5-verification">'+tag("VERIFICATION_UNAVAILABLE","orange")+'</span>';
  const local = v.localVerified ? tag("LOCAL_VERIFIED","green") : tag("LOCAL_VERIFICATION_PENDING","orange");
  const external = v.externalLiveVerified ? tag("EXTERNAL_LIVE_VERIFIED","green") : tag("EXTERNAL_LIVE_VERIFIED: NONE","");
  return '<span data-testid="h5-verification">'+tag("LOCAL_IMPLEMENTED")+" "+local+" "+external+'</span>';
}

function h5Table(title, testId, headers, rows) {
  if (!rows || !rows.length) return '<section class="panel" data-testid="'+testId+'"><h2>'+esc(title)+'</h2><p class="sub">No rows.</p></section>';
  return '<section class="panel" data-testid="'+testId+'"><h2>'+esc(title)+'</h2><div class="table-wrap"><table class="table"><thead><tr>'+
    headers.map((h)=>'<th>'+esc(h)+'</th>').join("")+'</tr></thead><tbody>'+rows.join("")+'</tbody></table></div></section>';
}

function publishingOverviewPanel() {
  // Read models must stay visible in a fresh or failing workspace: an absent
  // overview is reported as zero rows / pending verification, not as a hidden
  // panel. No value is invented — h5Value renders null/undefined as "—".
  const p = state.data.publishingOverview || {};
  const q = p.queue || {};
  const counts = q.counts || {};
  const blockers = q.blockers || [];
  const summary = '<section class="panel" data-testid="h5-publishing-queue"><h2>Publishing queue & blockers</h2>'+
    '<div class="stats">'+
      stat("QUEUED", h5Value(counts.QUEUED), "Durable jobs", "◷")+
      stat("RUNNING", h5Value(counts.RUNNING), "Leased", "▶")+
      stat("DEAD LETTER", h5Value(counts.DEAD_LETTER), "Needs retry", "⚠")+
    '</div>'+
    '<p class="sub">Blockers: '+(blockers.length ? esc(blockers.join(", ")) : "none")+'</p>'+
    h5Verification(p.verification || { localVerified:false, externalLiveVerified:false })+
    '<div class="field-grid"><div class="field"><button class="btn" data-action="h5-account-form">＋ Account</button></div>'+
    '<div class="field"><button class="btn" data-action="h5-approval-form">＋ Approval</button></div>'+
    '<div class="field"><button class="btn" data-action="h5-schedule-form">＋ Schedule</button></div></div></section>';
  const schedules = h5Table("Planned publishing (timezone aware)", "h5-publishing-schedules",
    ["Platform","Account","Local time","Timezone","Run at (UTC)","Status","Last error"],
    (p.schedules||[]).map((s)=>'<tr><td>'+esc(s.platform)+'</td><td>'+esc(s.accountKey||"—")+'</td><td>'+esc(s.localTime)+'</td><td>'+esc(s.timezone)+'</td><td>'+esc(s.runAt)+'</td><td>'+tag(s.status)+'</td><td>'+esc(s.lastError||"—")+'</td></tr>'));
  const jobs = h5Table("Publishing jobs", "h5-publishing-jobs",
    ["Job","Platform","Status","Attempts","Progress","Action"],
    (p.jobs||[]).map((j)=>'<tr><td>'+esc(j.id)+'</td><td>'+esc(j.payload?.platform||"—")+'</td><td>'+tag(j.status)+'</td><td>'+esc(j.attempts)+'/'+esc(j.maxAttempts)+'</td><td>'+esc(j.progress?.stage||"—")+'</td><td>'+(j.status==="DEAD_LETTER"?'<button class="btn primary" data-action="h5-job-retry" data-job-id="'+esc(j.id)+'">Retry</button>':"—")+'</td></tr>'));
  const approvals = h5Table("Human approvals", "h5-publishing-approvals",
    ["Approval","Status","Binding","Decided at","Action"],
    (p.approvals||[]).map((a)=>'<tr><td>'+esc(a.id)+'</td><td>'+tag(a.status)+'</td><td><code>'+esc(String(a.entityId||"").slice(0,80))+'</code></td><td>'+esc(a.decidedAt||"—")+'</td><td>'+(a.status==="approved"?'<button class="btn primary" data-action="h5-approval-revoke" data-id="'+esc(a.id)+'">Revoke</button>':"—")+'</td></tr>'));
  const accounts = h5Table("Target accounts", "h5-publishing-accounts",
    ["Platform","Account","Display name","Status","Action"],
    (p.accounts||[]).map((a)=>'<tr><td>'+esc(a.platform)+'</td><td>'+esc(a.accountKey)+'</td><td>'+esc(a.displayName||"—")+'</td><td>'+tag(a.status)+'</td><td>'+(a.status==="ACTIVE"?'<button class="btn primary" data-action="h5-account-disable" data-id="'+esc(a.id)+'">Disable</button>':"—")+'</td></tr>'));
  const adapters = h5Table("Official adapters", "h5-publishing-adapters",
    ["Platform","Status","Credential source","Missing variables"],
    (p.adapters||[]).map((a)=>'<tr><td>'+esc(a.platform)+'</td><td>'+tag(a.status)+'</td><td>'+esc(a.credentials?.source||"—")+'</td><td>'+esc((a.credentials?.missingEnv||[]).join(", ")||"—")+'</td></tr>'));
  return summary + schedules + jobs + approvals + accounts + adapters;
}

function affiliateRevenuePanel() {
  // The revenue panel is a fixed part of the analytics view. With no rows it
  // shows explicit missing markers ("—") instead of disappearing; this is an
  // empty state, not an invented zero or a fabricated earning.
  const r = state.data.affiliateRevenue || {};
  const links = state.data.affiliateLinks || [];
  const dimensions = (title, testId, rows) => h5Table(title, testId, ["Key","Clicks","Conversions","Revenue (cents)","Commission (cents)"],
    (rows||[]).map((d)=>'<tr><td>'+esc(d.key)+'</td><td>'+esc(d.clicks)+'</td><td>'+esc(d.conversions)+'</td><td>'+esc(d.revenueCents)+'</td><td>'+h5Value(d.commissionCents)+'</td></tr>'));
  const stats = '<section class="panel" data-testid="h5-affiliate-revenue">'+
    '<div data-testid="h5-affiliate-summary"><h2>Truth-first affiliate revenue</h2>'+
    '<div class="stats">'+
      stat("Total commission", h5Value(r.totalCommissionCents), "Only real supplied commissions", "€")+
      stat("Disclosed clicks", h5Value(r.disclosedClicks), "Links with disclosure text", "✓")+
      stat("Undisclosed clicks", h5Value(r.undisclosedClicks), "No disclosure on link", "⚠")+
      stat("Duplicate events", h5Value(r.duplicateExternalEvents), "Deduplicated", "◇")+
    '</div>'+
    '<p class="sub">Revenue is approved + paid conversions only. Missing values stay "—" instead of becoming zero.</p>'+
    '<button class="btn" data-action="h5-link-form">＋ Affiliate link</button></div></section>';
  const linkRows = h5Table("Affiliate links & disclosure", "h5-affiliate-links", ["Token","Offer","Campaign","Creator","Commission bps","Disclosure"],
    links.map((l)=>'<tr><td><code>'+esc(l.token)+'</code></td><td>'+esc(l.offerId)+'</td><td>'+esc(l.campaignId||"—")+'</td><td>'+esc(l.creatorId||"—")+'</td><td>'+h5Value(l.commissionBps)+'</td><td>'+esc(l.disclosureText||"—")+'</td></tr>'));
  return stats +
    dimensions("Revenue per clip", "h5-revenue-by-clip", r.byClip||[]) +
    dimensions("Revenue per creator", "h5-revenue-by-creator", r.byCreator||[]) +
    dimensions("Revenue per platform", "h5-revenue-by-platform", r.byPlatform||[]) +
    dimensions("Revenue per campaign", "h5-revenue-by-campaign", r.byCampaign||[]) +
    dimensions("Revenue per UTM source", "h5-revenue-by-utm", r.byUtmSource||[]) + linkRows;
}

function analyticsSourcesPanel() {
  const s = state.data.analyticsSources || {};
  const sources = Array.isArray(s.sources) ? s.sources : [];
  const missing = Array.isArray(s.missing) ? s.missing : ["sources:UNAVAILABLE"];
  const cards = sources.length
    ? sources.map((x)=>'<article class="card">'+tag(x.available?"OK":x.reason, x.available?"green":"orange")+'<h3>'+esc(x.source)+'</h3><p class="sub">'+esc(x.rowCount)+' rows</p></article>').join("")
    : '<article class="card">'+tag("NOT_CONFIGURED","orange")+'<h3>analytics sources</h3><p class="sub">0 rows</p></article>';
  return '<section class="panel" data-testid="h5-analytics-sources"><h2>Data sources & missing markers</h2><div class="cards">'+
    cards+'</div><p class="sub">Missing: '+esc(missing.join(", ")||"none")+'</p></section>';
}

function calendar() {
  const rows = state.data.tasks || [];
  const body = rows.length ? '<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Due</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.title)+'</td><td>'+esc(r.status)+'</td><td>'+esc(r.priority)+'</td><td>'+esc(r.dueDate?new Date(r.dueDate).toLocaleDateString():"—")+'</td></tr>').join("")+'</tbody></table></div></section>' : '<div class="panel">No tasks yet.</div>';
  return heading("Publishing Calendar / Tasks","Persisted tasks and Phase H publishing plans, approvals, queue and blockers.", button("＋ Add task","add-task",true)) + body + publishingOverviewPanel() + loadingBlock();
}

function analytics() {
  const a = state.data.analytics;
  const m = a && a.summary ? a.summary.metrics : {};
  const clicks = a && a.summary ? a.summary.clicks : 0;
  const convs = a && a.summary ? a.summary.conversions : 0;
  const posts = state.data.contentPosts || [];
  const postOptions = posts.length ? posts.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.platform+": "+(p.title||p.externalId))+'</option>').join("") : '';
  return heading("Analytics & Revenue","Aggregated from persisted snapshots/clicks. No external analytics connected.") +
  '<div class="notice">Values reflect manually recorded snapshots and clicks only. No affiliate network or analytics provider is connected.</div>' +
  '<div class="stats">'+stat("Clicks", clicks, "Recorded", "↗")+stat("Conversions", convs, "Recorded", "✓")+stat("Metrics", Object.keys(m).length, "Distinct", "⌁")+'</div>' +
  '<section class="panel"><h2>Record a metric snapshot</h2><form id="analytics-snapshot-form" class="field-grid"><div class="field"><label>Metric</label><input name="metric" required></div><div class="field"><label>Value</label><input name="value" type="number" step="any" required></div><div class="field full"><label>Source</label><input name="source" value="manual"></div><div class="field"><button class="btn primary" type="submit">Save snapshot</button></div></form></section>' +
  '<section class="panel"><h2>Record an affiliate click</h2><form id="analytics-click-form" class="field-grid"><div class="field"><label>Content post ID</label><input name="contentId"></div><div class="field"><label>Offer ID</label><input name="offerId"></div><div class="field full"><label>Idempotency key (optional)</label><input name="idempotencyKey"></div><div class="field"><button class="btn" type="submit">Save click</button></div></form></section>' +
  '<section class="panel"><h2>Content post snapshot</h2>' + (postOptions ? '<form id="content-snapshot-form" class="field-grid"><div class="field full"><label>Post</label><select name="postId" required>'+postOptions+'</select></div><div class="field"><label>Views</label><input name="views" type="number" min="0" step="1" value="0"></div><div class="field"><label>Likes</label><input name="likes" type="number" min="0" step="1" value="0"></div><div class="field"><label>Comments</label><input name="comments" type="number" min="0" step="1" value="0"></div><div class="field"><label>Shares</label><input name="shares" type="number" min="0" step="1" value="0"></div><div class="field"><label>Watch time (sec)</label><input name="watchTimeSec" type="number" min="0" step="any"></div><div class="field"><button class="btn" type="submit">Save post snapshot</button></div></form>' : '<p class="sub">Add a content post in Content Factory first; snapshots need a real post ID.</p>') + '</section>' +
  (Object.keys(m).length ? '<section class="panel"><h2>Metrics</h2><pre>'+esc(JSON.stringify(m,null,2))+'</pre></section>' : '') +
  analyticsSourcesPanel() + affiliateRevenuePanel() + loadingBlock();
}

function enginePanel() {
  const payload = state.data.engine;
  if (!payload || !payload.engine) {
    return '<section class="panel"><h2>Automation engine</h2><p class="sub">'+(state.loading ? 'Runtime status loading…' : 'Runtime status unavailable.')+'</p></section>';
  }
  const engine = payload.engine;
  const counts = (payload.queue && payload.queue.counts) || {};
  const lastTick = engine.lastTickAt ? new Date(engine.lastTickAt).toLocaleTimeString() : "not yet";
  return '<section class="panel"><h2>Automation engine</h2>' +
    '<p>' + tag(engine.running ? "RUNNING" : "IDLE", engine.running ? "green" : "orange") +
    ' <span class="sub">worker ' + esc(engine.workerId) + ' · polls every ' + Math.round((engine.intervalMs||0)/1000) + 's · last tick ' + esc(lastTick) + '</span></p>' +
    (engine.lastError ? '<p class="sub">Last error: ' + esc(engine.lastError) + '</p>' : '') +
    '<p>Queued ' + (counts.queued||0) + ' · running ' + (counts.running||0) + ' · retry ' + (counts.retryWait||0) +
    ' · waiting approval ' + (counts.waitingForApproval||0) + ' · dead letter ' + (counts.deadLetter||0) +
    ' · succeeded ' + (counts.succeeded||0) + '</p>' +
    '<button class="btn primary" data-action="engine-tick">Run engine now</button>' +
    '</section>';
}

function aiPanel() {
  const ai = state.data.ai;
  if (!ai) {
    return '<section class="panel"><h2>AI gateway</h2><p class="sub">'+(state.loading ? 'Gateway status loading…' : 'Gateway status unavailable.')+'</p></section>';
  }
  const agents = ai.agents || [];
  const budget = ai.budget || {};
  return '<section class="panel"><h2>AI gateway</h2>' +
    '<p>' + tag(ai.configured ? "OLLAMA KEY CONFIGURED" : "NOT CONFIGURED", ai.configured ? "green" : "orange") +
    ' <span class="sub">provider ' + esc(ai.provider) + ' · mode ' + esc(ai.mode) + '</span></p>' +
    '<p class="sub">Configuration/budget only — no live provider call is implied by this badge.</p>' +
    '<p>Requests today: ' + (budget.used || 0) + ' / ' + (budget.limit || 0) + ' <span class="sub">UTC day</span></p>' +
    (agents.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Agent</th><th>Model</th></tr></thead><tbody>' +
      agents.map(a => '<tr><td>' + esc(a.agentKey) + '</td><td>' + esc(a.model) + '</td></tr>').join("") + '</tbody></table></div>' : '') +
    (ai.configured ? '' : '<p class="sub">Set OLLAMA_API_KEY server-side to run agents on Ollama. Until then agent tasks use the deterministic planner, and each task output is labelled with its source.</p>') +
    '</section>';
}

function agents() {
  const agents = state.data.agents || [];
  const tasks = state.data.agentTasks || [];
  const agentOptions = agents.map(a=>'<option value="'+esc(a.id)+'">'+esc(a.name)+'</option>').join("");
  return heading("Agent Control","Persisted agents/tasks from /api/agents and /api/agent-tasks plus publishing agent status.") +
  enginePanel() +
  publishingOverviewPanel() +
  aiPanel() +
  '<section class="panel"><h2>Add agent</h2><form id="agent-form" class="field-grid"><div class="field"><label>Name</label><input name="name" required></div><div class="field"><label>Role</label><input name="role" required></div><div class="field"><button class="btn primary" type="submit">Create agent</button></div></form>' + (agents.length ? agents.map(a=>'<p>'+esc(a.name)+' — '+esc(a.role)+'</p>').join("") : '<p class="sub">No agents yet.</p>') + '</section>' +
  '<section class="panel"><h2>Add agent task</h2><form id="agent-task-form" class="field-grid"><div class="field"><label>Name</label><input name="name" required></div><div class="field"><label>Agent</label><select name="agentId"><option value="">(none)</option>'+agentOptions+'</select></div><div class="field full"><label>Input (optional)</label><input name="input"></div><div class="field"><button class="btn" type="submit">Create task</button></div></form>' + (tasks.length ? tasks.map(t=>'<p>'+esc(t.name)+' — '+esc(t.status)+'</p>').join("") : '<p class="sub">No tasks yet.</p>') + '<p class="sub">No run button is offered: POST /api/agent-tasks/:id/run currently returns 501 AGENT_RUNTIME_NOT_CONNECTED.</p>' + '</section>' + loadingBlock();
}

function integrations() {
  const rows = state.data.integrations || [];
  const cards = rows.length ? rows.map(i=>{
    const status = String(i.status || "NOT_CONFIGURED");
    const liveAdapter = i.liveAdapter === true ? "liveAdapter: true" : "liveAdapter: false";
    return '<article class="card">'+tag(status, status==="CREDENTIALS_ONLY"||status==="CONFIGURED"?"orange":"")+'<h3>'+esc(i.name||i.provider)+'</h3><p>'+esc(i.description||"")+'</p><p class="sub">provider: '+esc(i.provider||"")+' · '+esc(liveAdapter)+'</p><p class="sub">No live adapter connected; status reflects stored credentials only.</p></article>';
  }).join("") : '<div class="panel">No integrations.</div>';
  const options = rows.map(i=>'<option value="'+esc(i.provider)+'">'+esc(i.name||i.provider)+'</option>').join("");
  const form = rows.length ? '<section class="panel"><h2>Save a credential</h2><form id="integration-form" class="field-grid"><div class="field"><label>Provider</label><select name="provider" required>'+options+'</select></div><div class="field"><label>API key</label><input name="apiKey" type="password" autocomplete="off" required></div><div class="field"><button class="btn primary" type="submit">Save credential</button></div></form><p class="sub">POST /api/integrations/:provider stores only a masked hint server-side. liveAdapter:false — this does not establish a live connection.</p></section>' : '<section class="panel"><p class="sub">No providers available for credential entry.</p></section>';
  return heading("Integrations","Honest status from /api/integrations. No secrets stored in browser.") + '<div class="notice">Credentials are never stored in browser code. Set API keys server-side via env or POST /api/integrations/:provider.</div>' + form + '<div class="cards">'+cards+'</div>' + loadingBlock();
}

function mediaState() {
  if (!state.data.media) state.data.media = { asset:null, job:null, clips:[], highlights:[], subtitles:"", subtitlesCues:[], subtitlesName:"", previewUrl:null, selectedClips:[], selectedHighlights:[], exports:[], error:null };
  return state.data.media;
}

function mediaErrorText(err) {
  const code = err && (err.code || (err.details && err.details.code));
  if (code === "NOT_CONFIGURED") return "NOT_CONFIGURED: media runtime is not configured on the server.";
  return errorText(err);
}

function fileNameFrom(file) {
  const raw = typeof file === "string" ? file : (file && file.name || "");
  return String(raw).split(/[\\/]/).pop() || "";
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    if (typeof file.content === "string") { resolve(file.content); return; }
    if (typeof FileReader === "undefined") { reject(new Error("FILE_READER_UNAVAILABLE")); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",").pop() || "");
    reader.onerror = () => reject(reader.error || new Error("FILE_READ_FAILED"));
    reader.readAsDataURL(file);
  });
}

function extractMediaResult(result) {
  const media = mediaState();
  media.clips = result && Array.isArray(result.clips) ? result.clips : [];
  media.highlights = result && Array.isArray(result.highlights) ? result.highlights : [];
  media.subtitles = result && typeof result.subtitles === "string" ? result.subtitles : (result && result.transcript && typeof result.transcript.text === "string" ? result.transcript.text : "");
  media.subtitlesCues = result && Array.isArray(result.cues) ? result.cues : [];
  media.selectedClips = media.selectedClips.filter((i) => i < media.clips.length);
}

async function uploadMedia(file) {
  const basename = fileNameFrom(file);
  if (!basename) throw new Error("INVALID_FILE_NAME");
  const content = await readFileAsBase64(file);
  const res = await api("/api/media/upload", { method:"POST", body: JSON.stringify({ basename, file: content }) });
  const media = mediaState();
  media.asset = res && (res.asset || res.file) || null;
  media.error = null;
  return media.asset;
}

async function createMediaJob(name, language) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("FILE_NAME_REQUIRED");
  const lang = MEDIA_LANGUAGES.indexOf(language) >= 0 ? language : "auto";
  const res = await api("/api/media/jobs", { method:"POST", body: JSON.stringify({ name: clean, language: lang }) });
  const media = mediaState();
  media.job = res && (res.job || res) || null;
  media.error = null;
  return media.job;
}

async function processMediaJob(id) {
  const jobId = String(id || "").trim();
  if (!jobId) throw new Error("JOB_ID_REQUIRED");
  const res = await api("/api/media/jobs/" + encodeURIComponent(jobId) + "/process", { method:"POST", body: JSON.stringify({}) });
  const media = mediaState();
  media.job = res && (res.job || res) || media.job;
  if (media.job && media.job.result) extractMediaResult(media.job.result);
  return media.job;
}

async function pollMediaJob(id) {
  const jobId = String(id || "").trim();
  if (!jobId) throw new Error("JOB_ID_REQUIRED");
  const res = await api("/api/media/jobs/" + encodeURIComponent(jobId));
  const media = mediaState();
  media.job = res && (res.job || res) || null;
  if (media.job && media.job.result) extractMediaResult(media.job.result);
  return media.job;
}

async function previewMediaFile(name) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("FILE_NAME_REQUIRED");
  const blob = await api("/api/media/files/" + encodeURIComponent(clean), { asBlob:true });
  const media = mediaState();
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    if (media.previewUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(media.previewUrl);
    media.previewUrl = URL.createObjectURL(blob);
  }
  return media.previewUrl;
}

async function cancelMediaJob(id) {
  const jobId = String(id || "").trim();
  if (!jobId) throw new Error("JOB_ID_REQUIRED");
  return api("/api/jobs/" + encodeURIComponent(jobId) + "/cancel", { method:"POST", body: JSON.stringify({}) });
}

async function retryMediaJob(id) {
  const jobId = String(id || "").trim();
  if (!jobId) throw new Error("JOB_ID_REQUIRED");
  return api("/api/jobs/" + encodeURIComponent(jobId) + "/retry", { method:"POST", body: JSON.stringify({}) });
}

async function detectHighlights() {
  const media = mediaState();
  const text = media.subtitles || (media.job && media.job.result && media.job.result.text) || "";
  if (!String(text).trim()) throw new Error("NO_TRANSCRIPT_TO_ANALYZE");
  const keywords = $("#media-keywords") ? String($("#media-keywords").value || "").split(",").map((k) => k.trim()).filter(Boolean) : [];
  const res = await api("/api/media/transcription/highlights", { method:"POST", body: JSON.stringify({ text:String(text), keywords:keywords, limit:5 }) });
  media.highlights = res && Array.isArray(res.highlights) ? res.highlights : [];
  return media.highlights;
}

async function writeSubtitles() {
  const media = mediaState();
  if (!media.subtitlesCues.length) throw new Error("NO_CUES_IN_JOB_RESULT");
  const base = fileNameFrom(media.asset && (media.asset.name || media.asset.basename) || (media.job && media.job.name) || "captions");
  const name = String(base || "captions").replace(/\.[^.]+$/, "") + ".srt";
  const res = await api("/api/media/subtitles", { method:"POST", body: JSON.stringify({ name, cues: media.subtitlesCues }) });
  media.subtitlesName = res && res.subtitles && res.subtitles.path ? name : media.subtitlesName;
  return res;
}

function clipTime(clip, key) {
  const ms = Number(clip && clip[key + "Ms"]);
  if (Number.isFinite(ms)) return ms / 1000;
  const sec = Number(clip && clip[key + "Sec"]);
  if (Number.isFinite(sec)) return sec;
  return 0;
}

async function exportSelectedClips() {
  const media = mediaState();
  const indices = media.selectedClips.filter((i) => media.clips[i]);
  if (!indices.length) throw new Error("SELECT_AT_LEAST_ONE_CLIP");
  const inputName = fileNameFrom(media.asset && (media.asset.name || media.asset.basename) || (media.job && media.job.inputName) || "");
  if (!inputName) throw new Error("UPLOAD_A_FILE_FIRST");
  const exports = [];
  for (const i of indices) {
    const clip = media.clips[i];
    const start = clipTime(clip, "start");
    const end = clipTime(clip, "end");
    const duration = end > start ? end - start : Number(clip && clip.durationSec || clip && clip.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("CLIP_" + i + "_HAS_NO_DURATION");
    const outputName = fileNameFrom(clip.name || clip.fileName || "clip-" + (i + 1) + ".mp4") || "clip-" + (i + 1) + ".mp4";
    const body = { inputName, outputName, start, duration, vertical:true };
    if (media.subtitlesName) body.subtitlesName = media.subtitlesName;
    exports.push(await api("/api/media/export", { method:"POST", body: JSON.stringify(body) }));
  }
  media.exports = exports;
  return exports;
}

function mediaPanel() {
  const media = mediaState();
  const job = media.job;
  const assetName = fileNameFrom(media.asset && (media.asset.name || media.asset.basename) || (job && job.name) || "");
  const stage = job && job.stage !== undefined && job.stage !== null ? esc(job.stage) : "—";
  const progress = job && typeof job.progress === "number" && Number.isFinite(job.progress) ? esc(Math.round(job.progress * 100) + "%") : "—";
  const clips = Array.isArray(media.clips) && media.clips.length ? media.clips.map((c, i) => {
    const range = c && c.startMs !== undefined && c.startMs !== null && c.endMs !== undefined && c.endMs !== null
      ? c.startMs + "–" + c.endMs + " ms" : "times unavailable";
    return '<label class="task"><input type="checkbox" data-action="clip-toggle" data-clip-index="'+i+'"'+(media.selectedClips.indexOf(i) >= 0 ? ' checked' : '')+'><span class="task-text"><b>'+esc(c.name || c.fileName || "clip-" + (i + 1))+'</b><small>'+esc(range)+'</small></span></label>';
  }).join("") : '<p class="sub">No clips returned by the job result yet.</p>';
  const highlights = Array.isArray(media.highlights) && media.highlights.length ? media.highlights.map((h, i) => '<label class="task"><input type="checkbox" data-action="highlight-toggle" data-highlight-index="'+i+'"'+(media.selectedHighlights.indexOf(i) >= 0 ? ' checked' : '')+'><span class="task-text"><b>'+esc(String(h.text || "").slice(0, 120))+'</b><small>score '+esc(h.score)+' · '+esc((h.reasons || []).join(", "))+'</small></span></label>').join("") : '<p class="sub">No highlights returned yet.</p>';
  const controls = job && job.id ? '<p><button class="btn" data-action="media-process">Process</button> <button class="btn" data-action="media-poll">Poll status</button> <button class="btn" data-action="media-cancel">Cancel</button> <button class="btn" data-action="media-retry">Retry</button></p>' : '<p class="sub">Start a job to enable process/poll/cancel/retry.</p>';
  return '<section class="panel"><h2>Media jobs</h2>' +
    (media.error ? '<div class="notice" role="alert">'+esc(media.error)+'</div>' : '') +
    '<form id="media-upload-form" class="field-grid"><div class="field full"><label>Video/audio file</label><input id="media-file" name="file" type="file" accept="video/*,audio/*" required></div><div class="field"><button class="btn primary" type="submit">Upload</button></div></form>' +
    '<form id="media-job-form" class="field-grid"><div class="field full"><label>Uploaded file name</label><input id="media-name" name="name" value="'+esc(assetName)+'" required></div><div class="field"><label>Language</label><select id="media-language" name="language">'+MEDIA_LANGUAGES.map((l) => '<option value="'+l+'"'+(l === "auto" ? ' selected' : '')+'>'+l+'</option>').join("")+'</select></div><div class="field"><button class="btn" type="submit">Start transcription job</button></div><div class="field"><button class="btn" type="button" data-action="media-preview">Preview file</button></div></form>' +
    '<div class="metrics"><div><small>Job</small><b>'+esc(job && job.id || "—")+'</b></div><div><small>Stage</small><b>'+stage+'</b></div><div><small>Progress</small><b>'+progress+'</b></div></div>' + controls +
    (media.previewUrl ? '<video controls style="max-width:100%" src="'+esc(media.previewUrl)+'"></video>' : '<p class="sub">No preview loaded. Preview uses GET /api/media/files/:name.</p>') +
    '<h3>Subtitle preview</h3><textarea id="media-subtitle-text" rows="5" readonly>'+esc(media.subtitles || "")+'</textarea>' +
    '<form id="media-highlights-form" class="field-grid"><div class="field full"><label>Keywords (comma separated)</label><input id="media-keywords" name="keywords"></div><div class="field"><button class="btn" type="submit">Detect highlights</button></div><div class="field"><button class="btn" type="button" data-action="media-subtitles">Write SRT</button></div></form>' +
    '<h3>Highlight selection</h3>'+highlights+
    '<h3>Clip selection (multiple)</h3>'+clips+
    '<p><button class="btn primary" data-action="media-export">Export selected clips</button></p>' +
    '<p class="sub">All stages, clips and subtitles come from the media job result. NOT_CONFIGURED and missing credentials are shown as returned by the backend.</p></section>';
}

async function runMediaAction(action, message) {
  const media = mediaState();
  try {
    const result = await action();
    media.error = null;
    if (message) toast(message);
    render();
    return result;
  } catch (e) {
    media.error = mediaErrorText(e);
    toast(media.error);
    render();
    return null;
  }
}

async function loadBrowserData() {
  const status = await api('/api/browser/status').catch(()=>({runtime:{available:false,message:'status unavailable'}, tools:[]}));
  const sessions = await api('/api/browser/sessions').catch(()=>({sessions:[]}));
  const toolList = await api('/api/browser/mcp/tools').catch(()=>({tools:[]}));
  const list = sessions.sessions || [];
  const sid = state.browserSessionId || (list[0] && list[0].id) || '';
  state.browserSessionId = sid;
  const session = sid ? await api('/api/browser/sessions/'+sid).then(r=>r.session).catch(()=>null) : null;
  const screen = session && session.runtimeSessionId ? await api('/api/browser/sessions/'+sid+'/screenshot').catch(()=>null) : null;
  const tools = Array.isArray(toolList.tools) ? toolList.tools.map((t) => t.name || t).filter(Boolean) : (Array.isArray(status.tools) ? status.tools : []);
  return { status, list, sid, session, screen, tools, read:null, result:null };
}

function browserActor() { return { actorType:"human", actorId:(state.user && state.user.id) || "human" }; }

function agentBrowser() {
  const b = state.data.browser || { status:{runtime:{available:false,message:'not loaded'}}, list:[], sid:'', session:null, screen:null, tools:[], read:null, result:null };
  const status = b.status;
  const sid = b.sid;
  const session = b.session;
  const screen = b.screen;
  const tabs = (session && Array.isArray(session.tabs)) ? session.tabs : [];
  const statusText = status.runtime && status.runtime.available ? 'Runtime connected' : 'Runtime blocked/unavailable';
  const workspaceText = state.workspaceId ? state.workspaceId : 'none';
  const controlText = session ? session.controllerState : 'none';
  const controllerText = session ? (session.controllerActorId || 'none') : 'none';
  const tabsHtml = tabs.length ? tabs.map(function(t) {
    return '<span class="tag '+(t.id===session.activeTabId?'blue':'')+'">'+esc(t.title||t.url||t.id)+'</span> ' +
      '<button class="btn '+(t.id===session.activeTabId?'primary':'')+'" data-action="browser-switch-tab" data-tab-id="'+esc(t.id)+'">Switch</button> ' +
      '<button class="btn" data-action="browser-close-tab" data-tab-id="'+esc(t.id)+'">Close</button> ';
  }).join('<br>') : '<div class="panel">No tabs yet.</div>';
  const tools = Array.isArray(b.tools) ? b.tools : [];
  const toolOptions = tools.length ? tools.map((t) => '<option value="'+esc(t)+'">'+esc(t)+'</option>').join("") : '';
  return heading("Agent Browser","Shared human/agent browser workspace. Runtime: "+statusText) +
    '<section class="panel"><div class="field-grid">' +
      '<div class="field full"><label>Workspace</label><input value="'+esc(workspaceText)+'" readonly></div>' +
      '<div class="field full"><label>Session</label><input value="'+esc(sid||'none')+'" readonly></div>' +
      '<div class="field full"><label>Control</label><input value="'+esc(controlText)+'" readonly></div>' +
      '<div class="field full"><label>Controller</label><input value="'+esc(controllerText)+'" readonly></div>' +
      '<div class="field full"><label>Address</label><input id="browser-url" value="'+esc(session ? session.url : 'https://example.com')+'"></div>' +
      '<div class="field"><button class="btn primary" data-action="browser-create">New session</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-home" title="Fills the address field with the session URL or an allowed example URL; press Navigate to request navigation.">Home shortcut</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-navigate">Navigate</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-back">Back</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-forward">Forward</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-reload">Reload</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-new-tab">New tab</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-screenshot">Screenshot</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-takeover">Take over</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-close-session">Close session</button></div>' +
    '</div>' +
    '<div class="panel"><h3>Tabs</h3>'+tabsHtml+'</div>' +
    (screen && screen.base64 ? '<img alt="browser screenshot" style="max-width:100%;border:1px solid #333" src="data:'+esc(screen.mimeType||'image/png')+';base64,'+screen.base64+'">' : '<div class="panel">No screenshot (runtime may be blocked).</div>') +
    '</section>' +
    '<section class="panel"><h2>Page actions</h2><div class="field-grid">' +
      '<div class="field full"><label>Selector</label><input id="browser-selector" placeholder="css selector"></div>' +
      '<div class="field full"><label>Text to type</label><input id="browser-text"></div>' +
      '<div class="field"><label>Wait ms</label><input id="browser-ms" type="number" min="0" step="100" value="500"></div>' +
      '<div class="field"><label>Download URL</label><input id="browser-download-url"></div>' +
      '<div class="field"><button class="btn" data-action="browser-read">Read</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-click">Click</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-type">Type</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-wait">Wait</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-download">Download</button></div>' +
    '</div>' + (b.read ? '<h3>Read result (untrusted page content)</h3><pre>'+esc(JSON.stringify(b.read,null,2))+'</pre>' : '<p class="sub">No read result yet. Page content is untrusted data.</p>') + '</section>' +
    '<section class="panel"><h2>Control handoff</h2><div class="field-grid"><div class="field full"><label>Agent ID</label><input id="browser-agent-id"></div>' +
      '<div class="field"><button class="btn" data-action="browser-control-request">Request control</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-control-approve">Approve control</button></div>' +
      '<div class="field"><button class="btn" data-action="browser-control-release">Release control</button></div></div></section>' +
    '<section class="panel"><h2>MCP tool call</h2>' + (toolOptions ? '<form id="browser-mcp-form" class="field-grid"><div class="field full"><label>Tool</label><select name="tool" required>'+toolOptions+'</select></div><div class="field full"><label>Arguments (JSON object; sessionId added automatically)</label><textarea name="arguments" rows="4">{}</textarea></div><div class="field"><button class="btn primary" type="submit">Call tool</button></div></form>' : '<p class="sub">No MCP tools reported by /api/browser/mcp/tools.</p>') +
      (b.result ? '<h3>Last tool result</h3><pre>'+esc(JSON.stringify(b.result,null,2))+'</pre>' : '') + '</section>' + loadingBlock();
}

function apiIntegrationStatusTag(status) {
  const color = status === "CONNECTED" ? "green"
    : ["RATE_LIMITED", "QUOTA_EXHAUSTED", "TOKEN_EXPIRED", "PROVIDER_UNAVAILABLE"].includes(status) ? "orange"
    : status === "ADAPTER_NOT_IMPLEMENTED" ? "purple" : "";
  return tag(status || "NOT_CONFIGURED", color);
}

function apiIntegrationButton(label, action, provider, primary) {
  return '<button class="btn '+(primary?"primary":"")+'" data-action="'+action+'" data-provider="'+esc(provider)+'">'+esc(label)+'</button>';
}

function apiIntegrationRedirectUri(provider) {
  if (!provider || !provider.oauth || !provider.oauth.defaultRedirectPath) return '';
  try { return new URL(provider.oauth.defaultRedirectPath, window.location.href).toString(); }
  catch { return String(provider.oauth.defaultRedirectPath); }
}

function apiIntegrationDetailPanel() {
  const d = state.data.apiIntegrationDetail;
  if (!d) return '<section class="panel"><h2>Setup assistant</h2><p class="sub">Select a provider card and choose <b>Details</b> to see official portal links, required permissions, real free-tier facts and the setup steps.</p></section>';
  const c = d.connection || {};
  const steps = (d.manualSteps||[]).map((s)=>'<li>'+esc(s)+'</li>').join('');
  const permissions = (d.requiredPermissions||[]).map((s)=>'<li>'+esc(s)+'</li>').join('');
  const unavailable = (d.unavailableWithoutCredentials||[]).map((s)=>'<li>'+esc(s)+'</li>').join('');
  const links = [d.portalUrl ? '<a href="'+esc(d.portalUrl)+'" target="_blank" rel="noopener noreferrer">Developer portal</a>' : '', d.docsUrl ? '<a href="'+esc(d.docsUrl)+'" target="_blank" rel="noopener noreferrer">Official docs</a>' : ''].filter(Boolean).join(' · ');
  const redirectHint = apiIntegrationRedirectUri(d) ? '<p class="sub">OAuth redirect URI to register: <code>'+esc(apiIntegrationRedirectUri(d))+'</code></p>' : '';
  const fields = (d.credentialFields||[]).map((f)=>'<div class="field full"><label>'+esc(f.label)+'</label><input name="'+esc(f.key)+'" type="'+esc(f.type)+'" autocomplete="off"'+(f.required?' required':'')+'><div class="sub">'+esc(f.help)+'</div></div>').join('');
  const form = fields ? '<form id="api-integration-credential-form" data-provider="'+esc(d.key)+'" class="field-grid">'+fields+'<div class="field full"><button class="btn primary" type="submit">Save encrypted credential</button></div></form>' : '<p class="sub">This provider needs no stored credential.</p>';
  const history = (d.history||[]).map((h)=>'<tr><td>'+esc(new Date(h.createdAt).toLocaleString())+'</td><td>'+esc(h.type)+'</td><td>'+esc(h.outcome)+'</td><td>'+esc(h.errorCode||"—")+'</td></tr>').join('');
  return '<section class="panel"><h2>'+esc(d.name)+' — setup</h2><p>'+esc(d.description)+'</p><p class="sub">Status: '+esc(c.status||'NOT_CONFIGURED')+' · credential: '+esc(c.credentialHint||'none')+' · token expires: '+esc(c.tokenExpiresAt||'not reported')+'</p><p>'+(links||'<span class="sub">No official portal link for an unimplemented adapter.</span>')+'</p>'+redirectHint+
    '<h3>Manual steps</h3><ol>'+(steps||'<li>No manual steps documented.</li>')+'</ol>'+
    '<h3>Required permissions</h3><ul>'+(permissions||'<li>None</li>')+'</ul>'+
    '<h3>Credentials</h3>'+form+
    '<h3>Free tier (as documented)</h3><p>'+esc(d.freeTier||'')+'</p>'+
    '<h3>Without credentials</h3><ul>'+(unavailable||'<li>None</li>')+'</ul>'+
    '<h3>Adapter note</h3><p>'+esc(d.adapterNote||'')+'</p>'+
    '<h3>Last successful call</h3><p>'+esc(c.lastSuccessAt||'never')+'</p>'+
    '<h3>Quota</h3><pre>'+esc(JSON.stringify(c.quota||{source:'not_supplied_by_provider'},null,2))+'</pre>'+
    '<h3>History</h3><div class="table-wrap"><table class="table"><thead><tr><th>Time</th><th>Event</th><th>Outcome</th><th>Error</th></tr></thead><tbody>'+(history||'<tr><td colspan="4">No events yet.</td></tr>')+'</tbody></table></div></section>';
}

function apiIntegrationCenter() {
  const providers = state.data.apiIntegrations || [];
  const health = state.data.apiIntegrationHealth || {};
  const cards = providers.length ? providers.map((p)=>{
    const c = p.connection || {};
    return '<article class="card" data-provider="'+esc(p.key)+'">'+
      apiIntegrationStatusTag(c.status)+
      '<h3>'+esc(p.name)+'</h3><p>'+esc(p.description)+'</p>'+
      '<p class="sub">'+esc(p.category)+' · adapter: '+(p.liveAdapter?'live':'not implemented')+'</p>'+
      '<p class="sub">Credential: '+esc(c.credentialHint||'none')+' · source: '+esc(c.credentialSource||'none')+' · last success: '+esc(c.lastSuccessAt||'never')+'</p>'+
      '<div class="field-grid">'+
        apiIntegrationButton('Details','api-integration-detail',p.key,true)+
        apiIntegrationButton('Test connection','api-integration-test',p.key)+
        apiIntegrationButton('Refresh token','api-integration-refresh',p.key)+
        apiIntegrationButton(c.enabled?'Disable':'Enable','api-integration-toggle',p.key)+
        apiIntegrationButton('Disconnect','api-integration-disconnect',p.key)+
        (p.oauth ? apiIntegrationButton('OAuth authorize','api-integration-oauth',p.key) : '')+
      '</div></article>';
  }).join('') : '<div class="panel">No providers available.</div>';
  return heading("API Integration Center","Official provider status from real connection tests. No secrets are returned by the API.")+
    '<div class="stats">'+
      stat('Providers', String(providers.length), 'registry entries', '⚡')+
      stat('Connected', String((health.byStatus&&health.byStatus.CONNECTED)||0), 'verified by a real call', '✓')+
      stat('Open circuits', String(health.openCircuits||0), 'cooldown active', '⏱')+
      stat('Credential store', health.credentialStoreAvailable?'ready':'unavailable', 'separate master key', '🔐')+
    '</div>'+
    '<div class="notice">CONNECTED is shown only after a successful official API call or verified local adapter. Missing credentials are never simulated.</div>'+
    apiIntegrationDetailPanel()+
    '<div class="cards">'+cards+'</div>'+loadingBlock();
}

const views = {overview,radar,creators,campaigns,scripts,clipping,youtube,phaseg,content,calendar,analytics,agents,integrations,"api-integrations":apiIntegrationCenter,"agent-browser":agentBrowser};

function renderAuth() {
  const auth = $("#auth-container");
  const markup = authMode === "login" ? authScreen() : signupScreen();
  if (auth) {
    auth.innerHTML = markup;
    auth.hidden = false;
    const page = $("#page"); if (page) page.hidden = true;
  } else {
    // Never replace document.body: keep the shell and all event wiring intact.
    const page = $("#page");
    if (page) { page.innerHTML = markup; page.hidden = false; }
  }
  const lf = $("#login-form"); if (lf) lf.addEventListener("submit", handleLogin);
  const sf = $("#signup-form"); if (sf) sf.addEventListener("submit", handleSignup);
  const sl = $("#show-login"); if (sl) sl.addEventListener("click", (e)=>{e.preventDefault(); authMode="login"; renderAuth();});
  const ss = $("#show-signup"); if (ss) ss.addEventListener("click", (e)=>{e.preventDefault(); authMode="signup"; renderAuth();});
}

// Renders into #page only; the auth screen has its own container.
function renderPage() {
  if (!state.user) { renderAuth(); return; }
  const auth = $("#auth-container"); if (auth) auth.hidden = true;
  const page = $("#page");
  if (!page) { if (window && window.location) window.location.reload(); return; }
  page.hidden = false;
  const errorBanner = state.error
    ? '<div class="notice" role="alert">Data could not be refreshed: '+esc(state.error)+'. Displayed values may be out of date.</div>'
    : '';
  page.innerHTML = errorBanner + (views[state.view]||overview)();
  updateProfile();
  updateRadarBadge();
  updateControlLink();
  const badge = $("#live-badge");
  if (badge) {
    badge.textContent = state.error ? '● STALE DATA' : state.loading ? '● LOADING' : '● WORKSPACE DATA';
    badge.style.color = state.error ? '#ff8a8a' : '';
  }
  const crumb = $("#crumb"); if (crumb) crumb.textContent = titles[state.view]||"Overview";
  document.querySelectorAll(".nav[data-view]").forEach(b=>{b.classList.toggle("active",b.dataset.view===state.view);b.setAttribute("aria-current",b.dataset.view===state.view?"page":"false");});
  const sb = $("#sidebar"); if (sb) sb.classList.remove("open");
}

function render() { renderPage(); }

async function browserPost(path, body, message, beforeReload) {
  try {
    const res = await api(path, { method:"POST", body: JSON.stringify(Object.assign(browserActor(), body || {})) });
    if (message) toast(message);
    if (beforeReload) beforeReload(res);
    await loadView("agent-browser");
    return res;
  } catch (err) { toast("Browser action failed: " + errorText(err)); return null; }
}

async function browserRead() {
  if (!state.browserSessionId) { toast("Create a session first"); return; }
  try {
    const res = await api('/api/browser/sessions/' + encodeURIComponent(state.browserSessionId) + '/read');
    await loadView("agent-browser");
    if (state.data.browser) state.data.browser.read = res;
    render();
  } catch (err) { toast("Browser read failed: " + errorText(err)); }
}

async function browserScreenshot() {
  if (!state.browserSessionId) { toast("Create a session first"); return; }
  try {
    const res = await api('/api/browser/sessions/' + encodeURIComponent(state.browserSessionId) + '/screenshot');
    await loadView("agent-browser");
    if (state.data.browser) state.data.browser.screen = res;
    render();
  } catch (err) { toast("Browser screenshot failed: " + errorText(err)); }
}

async function wireEvents() {
  document.addEventListener("click", async (e)=>{
    const target = e && e.target;
    const v = target && target.closest ? target.closest("[data-view]") : null;
    if (v) { e.preventDefault(); await loadView(v.dataset.view); return; }
    const a = target && target.closest ? target.closest("[data-action]") : null;
    if (!a) return;
    const name = a.dataset.action;
    try {
      if (name === "refresh") { await loadView(state.view); return; }
      if (name && name.startsWith("phaseg-")) {
        const query = (document.getElementById("phaseg-query") || {}).value || "creator workflow";
        let res;
        if (name === "phaseg-youtube") res = await api("/api/discovery/youtube/search?query=" + encodeURIComponent(query));
        else if (name === "phaseg-trending") res = await api("/api/discovery/youtube/trending?regionCode=DE");
        else if (name === "phaseg-creators") res = await api("/api/discovery/youtube/creators?query=" + encodeURIComponent(query));
        else if (name === "phaseg-score") res = await api("/api/discovery/score", {method:"POST", body: JSON.stringify({title:query, rightsStatus:"UNKNOWN"})});
        else if (name === "phaseg-sources") res = await api("/api/media/sources");
        else if (name === "phaseg-profiles") res = await api("/api/production/profiles");
        else if (name === "phaseg-quality") res = await api("/api/quality/reports");
        else if (name === "phaseg-score-save") res = await api("/api/discovery/score", {method:"POST", body: JSON.stringify({title:query, rightsStatus:"UNKNOWN", persist:true})});
        else if (name === "phaseg-scores") res = await api("/api/discovery/scores");
        else if (name === "phaseg-auto-clips") res = await api("/api/media/clip-candidates/auto", {method:"POST", body: JSON.stringify({sourceName: (document.getElementById("phaseg-source")||{}).value||"source.mp4", highlights: [], targetDurationSeconds: 15})});
        else if (name === "phaseg-thumbnail") res = await api("/api/media/thumbnail", {method:"POST", body: JSON.stringify({sourceName: (document.getElementById("phaseg-source")||{}).value||"source.mp4", outputName: "thumbnail-9x16.png", profile:"9:16", atSeconds:1})});
        else if (name === "phaseg-vtt") res = await api("/api/media/subtitles/vtt", {method:"POST", body: JSON.stringify({srtName: (document.getElementById("phaseg-srt")||{}).value||"captions.srt"})});
        else if (name === "phaseg-release") res = await api("/api/media/releases/request", {method:"POST", body: JSON.stringify({clipName: (document.getElementById("phaseg-output")||{}).value||"clip-9x16.mp4", rightsStatus:"AUTHORIZED"})});
        else if (name === "phaseg-releases") res = await api("/api/media/releases");
        else if (name === "phaseg-pipeline") res = await api("/api/phase-g/pipeline", {method:"POST", body: JSON.stringify({sourceName: (document.getElementById("phaseg-source")||{}).value||"source.mp4", outputPrefix: "studio", profile:"9:16", rightsStatus:"AUTHORIZED", highlights: [], topic: query})});
        else throw new Error("UNKNOWN_PHASEG_ACTION");
        state.data.phasegOutput = res;
        render();
        return;
      }
      if (name && name.startsWith("api-integration-")) {
        const provider = String(a.dataset.provider||"");
        const base = "/api/api-integrations/" + encodeURIComponent(provider);
        if (!provider) throw new Error("PROVIDER_REQUIRED");
        if (name === "api-integration-detail") {
          state.data.apiIntegrationDetail = await api(base);
          render();
          return;
        }
        if (name === "api-integration-test") {
          const res = await api(base + "/test", {method:"POST", body: JSON.stringify({})});
          toast("Connection test: " + String(res.status||"unknown") + (res.errorCode ? " ("+res.errorCode+")" : ""));
          await loadView(state.view);
          return;
        }
        if (name === "api-integration-refresh") {
          const res = await api(base + "/refresh", {method:"POST", body: JSON.stringify({})});
          toast("Token refreshed" + (res.tokenExpiresAt ? " (expires "+res.tokenExpiresAt+")" : ""));
          await loadView(state.view);
          return;
        }
        if (name === "api-integration-toggle") {
          const current = (state.data.apiIntegrations||[]).find((p)=>p.key===provider);
          const enabled = !(current && current.connection && current.connection.enabled);
          await api(base, {method:"PATCH", body: JSON.stringify({enabled})});
          toast(enabled ? "Provider enabled" : "Provider disabled");
          await loadView(state.view);
          return;
        }
        if (name === "api-integration-disconnect") {
          await api(base, {method:"DELETE"});
          state.data.apiIntegrationDetail = null;
          toast("Connection disconnected");
          await loadView(state.view);
          return;
        }
        if (name === "api-integration-oauth") {
          const res = await api("/api/api-integrations/oauth/" + encodeURIComponent(provider) + "/start");
          if (res && res.authorizationUrl && window && window.location) window.location.href = res.authorizationUrl;
          return;
        }
      }
      if (name === "logout") { await doLogout(); return; }
      if (name === "h5-account-form") { h5Form("Add publishing account", "account", [{n:"platform",l:"Platform (youtube|tiktok|instagram)"},{n:"accountKey",l:"Account key"},{n:"displayName",l:"Display name",o:true}]); return; }
      if (name === "h5-approval-form") { h5Form("Request publishing approval", "approval", [{n:"platform",l:"Platform"},{n:"entityType",l:"Entity type"},{n:"entityId",l:"Entity id"},{n:"idempotencyKey",l:"Idempotency key"},{n:"accountKey",l:"Account key",o:true},{n:"qualityReportId",l:"Quality report id",o:true},{n:"checksum",l:"Checksum",o:true}]); return; }
      if (name === "h5-schedule-form") { h5Form("Create publishing schedule", "schedule", [{n:"platform",l:"Platform"},{n:"entityType",l:"Entity type"},{n:"entityId",l:"Entity id"},{n:"idempotencyKey",l:"Idempotency key"},{n:"approvalId",l:"Approval id"},{n:"localTime",l:"Local time (HH:MM)"},{n:"timezone",l:"IANA timezone"},{n:"accountKey",l:"Account key",o:true}]); return; }
      if (name === "h5-link-form") { h5Form("Create affiliate link", "link", [{n:"token",l:"Token"},{n:"offerId",l:"Offer id"},{n:"destinationUrl",l:"Destination URL"},{n:"campaignId",l:"Campaign id",o:true},{n:"creatorId",l:"Creator id",o:true},{n:"commissionBps",l:"Commission bps",o:true},{n:"disclosureText",l:"Disclosure",o:true}]); return; }
      if (name === "h5-job-retry") { await api('/api/publishing/jobs/'+encodeURIComponent(a.dataset.jobId)+'/retry',{method:'POST',body:JSON.stringify({})}); toast('Retry requested'); await loadView(state.view); return; }
      if (name === "h5-approval-revoke") { await api('/api/approvals/'+encodeURIComponent(a.dataset.id)+'/revoke',{method:'POST',body:JSON.stringify({})}); toast('Approval revoked'); await loadView(state.view); return; }
      if (name === "h5-account-disable") { await api('/api/publishing/accounts/'+encodeURIComponent(a.dataset.id)+'/status',{method:'PATCH',body:JSON.stringify({status:'DISABLED'})}); toast('Account disabled'); await loadView(state.view); return; }
      if (name === "engine-tick") {
        const res = await api('/api/engine/tick', {method:'POST', body: JSON.stringify({})});
        const s = (res && res.summary) || {};
        toast('Engine ran: ' + (s.succeeded||0) + ' done, ' + (s.retried||0) + ' retried, ' + (s.awaitingApproval||0) + ' awaiting approval');
        await loadView(state.view);
        return;
      }
      if (name === "workflow-run") {
        const res = await api('/api/workflows/' + encodeURIComponent(a.dataset.workflowId) + '/run', { method:"POST", body: JSON.stringify({ input:{} }) });
        toast('Workflow run: ' + ((res && res.run && res.run.status) || 'requested'));
        await loadView(state.view);
        return;
      }
      if (name === "clip-toggle") {
        const m = mediaState(); const i = Number(a.dataset.clipIndex);
        const pos = m.selectedClips.indexOf(i);
        if (pos >= 0) m.selectedClips.splice(pos, 1); else m.selectedClips.push(i);
        return;
      }
      if (name === "highlight-toggle") {
        const m = mediaState(); const i = Number(a.dataset.highlightIndex);
        const pos = m.selectedHighlights.indexOf(i);
        if (pos >= 0) m.selectedHighlights.splice(pos, 1); else m.selectedHighlights.push(i);
        return;
      }
      if (name === "media-preview") { const input = $("#media-name"); await runMediaAction(()=>previewMediaFile(input && input.value), "Preview loaded"); return; }
      if (name === "media-process") {
        const jobId = mediaState().job && mediaState().job.id;
        await runMediaAction(async () => { const job = await processMediaJob(jobId); return await pollMediaJob(job && job.id || jobId); }, "Job processed");
        return;
      }
      if (name === "media-poll") { const jobId = mediaState().job && mediaState().job.id; await runMediaAction(()=>pollMediaJob(jobId), "Status refreshed"); return; }
      if (name === "media-cancel") { const jobId = mediaState().job && mediaState().job.id; await runMediaAction(()=>cancelMediaJob(jobId), "Cancel requested"); return; }
      if (name === "media-retry") { const jobId = mediaState().job && mediaState().job.id; await runMediaAction(()=>retryMediaJob(jobId), "Retry requested"); return; }
      if (name === "media-subtitles") { await runMediaAction(()=>writeSubtitles(), "SRT written"); return; }
      if (name === "media-export") { await runMediaAction(()=>exportSelectedClips(), "Export requested"); return; }
      if (name === "add-product") { openForm("Add product", [{n:"name",l:"Name"},{n:"category",l:"Category"},{n:"source",l:"Source"},{n:"priceCents",l:"Price (cents)",optional:true}], "product"); return; }
      if (name === "add-creator") { openForm("Add creator", [{n:"name",l:"Name"},{n:"email",l:"Email"},{n:"niches",l:"Niches"},{n:"platforms",l:"Platforms"}], "creator"); return; }
      if (name === "add-campaign") { openForm("Add campaign", [{n:"name",l:"Name"},{n:"goal",l:"Goal"},{n:"status",l:"Status"},{n:"budgetCents",l:"Budget (cents)",optional:true}], "campaign"); return; }
      if (name === "add-idea") { openForm("Add idea", [{n:"title",l:"Title"},{n:"format",l:"Format"}], "idea"); return; }
      if (name === "add-workflow") { openForm("Add workflow", [{n:"name",l:"Name"}], "workflow"); return; }
      if (name === "add-task") { openForm("Add task", [{n:"title",l:"Title"},{n:"priority",l:"Priority"},{n:"dueDate",l:"Due date",optional:true,type:"date"}], "task"); return; }
      if (name === "add-post") { openForm("Add post", [{n:"platform",l:"Platform"},{n:"externalId",l:"External ID"},{n:"title",l:"Title"}], "post"); return; }
      if (name === "save-form") { const form = $("#entry-form"); if (form) await saveEntry(form); return; }
      if (name === "browser-create") {
        const input = $("#browser-url");
        const initialUrl = input && input.value ? input.value.trim() : undefined;
        await browserPost('/api/browser/sessions', { initialUrl }, 'Browser session created', (res) => {
          if (res && res.session && res.session.id) state.browserSessionId = res.session.id;
        });
        return;
      }
      if (name === "browser-navigate") {
        if (!state.browserSessionId) { toast('Create a session first'); return; }
        const input = $("#browser-url"); const url = input ? input.value.trim() : "";
        if (!url) { toast('Enter an allowed URL first'); return; }
        await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/navigate', { url }, 'Navigation requested');
        return;
      }
      if (name === "browser-back") { if (state.browserSessionId) await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/back', {}, 'Back requested'); return; }
      if (name === "browser-forward") { if (state.browserSessionId) await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/forward', {}, 'Forward requested'); return; }
      if (name === "browser-reload") { if (state.browserSessionId) await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/reload', {}, 'Reload requested'); return; }
      if (name === "browser-home") {
        const input = $("#browser-url"); if (!input) return;
        const session = state.data.browser && state.data.browser.session;
        const home = session && /^https?:\/\//.test(session.url || "") ? session.url : 'https://example.com';
        input.value = home;
        toast('Address filled with ' + home + '; press Navigate to request navigation');
        return;
      }
      if (name === "browser-new-tab") {
        if (!state.browserSessionId) return;
        const input = $("#browser-url");
        await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/tabs', { url: input ? input.value : undefined }, 'Tab requested');
        return;
      }
      if (name === "browser-screenshot") { await browserScreenshot(); return; }
      if (name === "browser-read") { await browserRead(); return; }
      if (name === "browser-click") {
        if (!state.browserSessionId) return;
        const sel = $("#browser-selector");
        if (!sel || !sel.value.trim()) { toast('Enter a selector first'); return; }
        await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/click', { selector:sel.value }, 'Click requested');
        return;
      }
      if (name === "browser-type") {
        if (!state.browserSessionId) return;
        const sel = $("#browser-selector"); const text = $("#browser-text");
        if (!sel || !sel.value.trim() || !text) { toast('Enter a selector and text first'); return; }
        await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/type', { selector:sel.value, text:text.value }, 'Type requested');
        return;
      }
      if (name === "browser-wait") {
        if (!state.browserSessionId) return;
        const sel = $("#browser-selector"); const ms = $("#browser-ms");
        await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/wait', { selector: sel && sel.value ? sel.value : undefined, ms: ms ? Number(ms.value) : undefined }, 'Wait requested');
        return;
      }
      if (name === "browser-download") {
        if (!state.browserSessionId) return;
        const url = $("#browser-download-url");
        if (!url || !url.value.trim()) { toast('Enter a download URL first'); return; }
        await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/download', { url:url.value }, 'Download requested');
        return;
      }
      if (name === "browser-close-session") {
        const sid = state.browserSessionId;
        if (!sid) return;
        await browserPost('/api/browser/sessions/'+encodeURIComponent(sid)+'/close', {}, 'Session closed', () => { state.browserSessionId = ""; });
        return;
      }
      if (name === "browser-switch-tab") {
        if (!state.browserSessionId) return;
        await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/tabs/'+encodeURIComponent(a.dataset.tabId)+'/activate', {}, 'Tab activated');
        return;
      }
      if (name === "browser-close-tab") {
        if (!state.browserSessionId) return;
        await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/tabs/'+encodeURIComponent(a.dataset.tabId)+'/close', {}, 'Tab closed');
        return;
      }
      if (name === "browser-takeover") { if (state.browserSessionId) await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/control/takeover', {}, 'Control taken over'); return; }
      if (name === "browser-control-request" || name === "browser-control-approve") {
        if (!state.browserSessionId) return;
        const agent = $("#browser-agent-id"); const agentId = agent ? agent.value.trim() : "";
        if (!agentId) { toast('Enter an agent ID first'); return; }
        const suffix = name === "browser-control-request" ? "request" : "approve";
        await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/control/'+suffix, { agentId }, 'Control ' + suffix + ' requested');
        return;
      }
      if (name === "browser-control-release") {
        if (!state.browserSessionId) return;
        await browserPost('/api/browser/sessions/'+encodeURIComponent(state.browserSessionId)+'/control/release', { actorId:(state.user && state.user.id) || 'human' }, 'Control released');
        return;
      }
    } catch (err) {
      if (err && err.status === 401) return;
      toast("Action failed: " + errorText(err));
    }
  });
  document.addEventListener("submit", async (e)=>{
    const form = e.target;
    if (!form || !form.id) return;
    try {
      if (form.id === "entry-form") { e.preventDefault(); await saveEntry(form); return; }
      if (form.id === "h5-action-form") {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        const kind = form.dataset.kind;
        const clean = Object.fromEntries(Object.entries(d).filter(([,v])=>String(v||"").trim()!=="").map(([k,v])=>[k,String(v).trim()]));
        let url; let payload = clean;
        if (kind === "account") url = "/api/publishing/accounts";
        else if (kind === "approval") url = "/api/publishing/approvals";
        else if (kind === "schedule") { url = "/api/publishing/schedules"; payload = { ...clean, options: {} }; }
        else if (kind === "link") {
          url = "/api/affiliate/links";
          if (clean.commissionBps !== undefined) payload = { ...clean, commissionBps: Number(clean.commissionBps) };
        } else throw new Error("UNKNOWN_H5_FORM:" + kind);
        await api(url, { method:"POST", body: JSON.stringify(payload) });
        toast("Saved");
        if ($("#modal")) $("#modal").close();
        await loadView(state.view);
        return;
      }
      if (form.id === "workflow-form") {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        const stepName = String(d.stepName || "").trim();
        const action = String(d.action || "");
        if (stepName && WORKFLOW_ACTIONS.indexOf(action) < 0) throw new Error("UNKNOWN_WORKFLOW_ACTION:" + action);
        const steps = stepName ? [{ name:stepName, action }] : [];
        await api("/api/workflows", { method:"POST", body: JSON.stringify({ name:d.name, steps }) });
        toast("Workflow created"); await loadView(state.view); return;
      }
      if (form.id === "api-integration-credential-form") {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        const provider = String(form.dataset.provider||d.provider||"");
        if (!provider) throw new Error("PROVIDER_REQUIRED");
        const body = {};
        for (const [key, value] of Object.entries(d)) if (key !== "provider" && String(value||"").trim()) body[key] = String(value).trim();
        await api("/api/api-integrations/" + encodeURIComponent(provider) + "/credentials", { method:"POST", body: JSON.stringify(body) });
        state.data.apiIntegrationDetail = await api("/api/api-integrations/" + encodeURIComponent(provider));
        toast("Credential stored encrypted; run Test connection to verify");
        render();
        return;
      }
      if (form.id === "integration-form") {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        if (!String(d.provider || "").trim() || !String(d.apiKey || "").trim()) throw new Error("PROVIDER_AND_KEY_REQUIRED");
        await api("/api/integrations/" + encodeURIComponent(d.provider), { method:"POST", body: JSON.stringify({ apiKey:d.apiKey }) });
        toast("Credential recorded (liveAdapter:false)"); await loadView(state.view); return;
      }
      if (form.id === "agent-form") {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        await api("/api/agents", { method:"POST", body: JSON.stringify({ name:d.name, role:d.role }) });
        toast("Agent created"); await loadView(state.view); return;
      }
      if (form.id === "agent-task-form") {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        await api("/api/agent-tasks", { method:"POST", body: JSON.stringify({ name:d.name, agentId:d.agentId || null, input:d.input || null }) });
        toast("Agent task created"); await loadView(state.view); return;
      }
      if (form.id === "discovery-form") {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        const query = String(d.query || "").trim();
        if (!query) throw new Error("QUERY_REQUIRED");
        let discoveryError = null;
        try {
          await api("/api/discovery/searches", { method:"POST", body: JSON.stringify({ query }) });
          toast("Discovery search queued");
        } catch (err) {
          if (err && err.status === 401) throw err;
          discoveryError = errorText(err);
          toast(discoveryError);
        }
        await loadView(state.view);
        // loadDiscoveryData clears the banner on a successful candidate fetch;
        // restore a real search error (e.g. DISCOVERY_NOT_CONFIGURED) after it.
        if (discoveryError) { state.data.discoveryError = discoveryError; render(); }
        return;
      }
      if (form.id === "analytics-snapshot-form") {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        const value = parseNumberField(d.value, "Value");
        await api("/api/analytics/snapshots", { method:"POST", body: JSON.stringify({ metric:d.metric, value, source:d.source || "manual" }) });
        toast("Snapshot saved"); await loadView(state.view); return;
      }
      if (form.id === "analytics-click-form") {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        const body = { contentId:d.contentId || null, offerId:d.offerId || null };
        if (d.idempotencyKey) body.idempotencyKey = d.idempotencyKey;
        await api("/api/analytics/clicks", { method:"POST", body: JSON.stringify(body) });
        toast("Click recorded"); await loadView(state.view); return;
      }
      if (form.id === "content-snapshot-form") {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        const postId = String(d.postId || "").trim();
        if (!postId || !(state.data.contentPosts || []).some((p)=>p.id === postId)) throw new Error("UNKNOWN_CONTENT_POST");
        const body = {
          views: parseNumberField(d.views, "Views", { integer:true, min:0 }) || 0,
          likes: parseNumberField(d.likes, "Likes", { integer:true, min:0 }) || 0,
          comments: parseNumberField(d.comments, "Comments", { integer:true, min:0 }) || 0,
          shares: parseNumberField(d.shares, "Shares", { integer:true, min:0 }) || 0,
          watchTimeSec: parseNumberField(d.watchTimeSec, "Watch time")
        };
        await api("/api/content-posts/" + encodeURIComponent(postId) + "/snapshots", { method:"POST", body: JSON.stringify(body) });
        toast("Post snapshot saved"); await loadView(state.view); return;
      }
      if (form.id === "media-upload-form") {
        e.preventDefault();
        const input = $("#media-file");
        if (!input || !input.files || !input.files.length) { toast("Choose a file first"); return; }
        await runMediaAction(()=>uploadMedia(input.files[0]), "File uploaded");
        render();
        return;
      }
      if (form.id === "media-job-form") {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        await runMediaAction(async () => {
          const job = await createMediaJob(d.name, d.language);
          const processed = await processMediaJob(job && job.id);
          return await pollMediaJob(processed && processed.id || job && job.id);
        }, "Media job started");
        render();
        return;
      }
      if (form.id === "media-highlights-form") {
        e.preventDefault();
        await runMediaAction(()=>detectHighlights(), "Highlights detected");
        render();
        return;
      }
      if (form.id === "browser-mcp-form") {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        const tool = String(d.tool || "");
        const tools = (state.data.browser && state.data.browser.tools) || [];
        if (tools.indexOf(tool) < 0) throw new Error("TOOL_NOT_REPORTED");
        let args; try { args = JSON.parse(d.arguments || "{}"); } catch { throw new Error("INVALID_TOOL_ARGUMENTS"); }
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("INVALID_TOOL_ARGUMENTS");
        args.sessionId = state.browserSessionId;
        const payload = { jsonrpc:"2.0", id:Date.now(), method:"tools/call", params:{ name:tool, arguments:args } };
        const res = await api("/api/browser/mcp", { method:"POST", body: JSON.stringify(payload) });
        await loadView("agent-browser");
        if (state.data.browser) state.data.browser.result = res;
        render();
        toast("MCP tool call returned a result");
        return;
      }
    } catch (err) {
      if (err && err.status === 401) return;
      toast("Action failed: " + errorText(err));
    }
  });
  const menu = $("#menu"); if (menu) menu.addEventListener("click", ()=>$("#sidebar").classList.toggle("open"));
  const help = $("#help"); if (help) help.addEventListener("click", ()=>{ $("#modal-body").innerHTML="<h2>UGC OS</h2><p>Connected to backend. Data persisted in PostgreSQL.</p><p class='sub'>Shortcuts: Arrow keys navigate tabs. Enter/Space activate. Esc closes dialogs.</p>"; $("#modal").showModal(); });
  const close = $("#close"); if (close) close.addEventListener("click", ()=>$("#modal").close());
  document.addEventListener("keydown", (e)=>{
    if (e.target && (e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA")) return;
    const navs = Array.from(document.querySelectorAll(".nav[data-view]"));
    if (!navs.length) return;
    const idx = navs.findIndex(b=>b.classList.contains("active"));
    if (e.key==="ArrowDown"||e.key==="ArrowRight") { e.preventDefault(); const n=navs[(idx+1)%navs.length]; if (n) n.click(); }
    else if (e.key==="ArrowUp"||e.key==="ArrowLeft") { e.preventDefault(); const n=navs[(idx-1+navs.length)%navs.length]; if (n) n.click(); }
  });
}

async function saveEntry(form) {
  const d = Object.fromEntries(new FormData(form));
  const kind = form.dataset.kind;
  if (kind === "product") {
    await api("/api/products", { method:"POST", body: JSON.stringify(Object.assign({ name:d.name, category:d.category, source:d.source }, centsField(d, "priceCents", "Price (cents)"))) });
  } else if (kind === "creator") {
    await api("/api/creators", { method:"POST", body: JSON.stringify({ name:d.name, email:d.email, niches:d.niches, platforms:d.platforms }) });
  } else if (kind === "campaign") {
    await api("/api/campaigns", { method:"POST", body: JSON.stringify(Object.assign({ name:d.name, goal:d.goal, status:d.status }, centsField(d, "budgetCents", "Budget (cents)"))) });
  } else if (kind === "idea") {
    await api("/api/ideas", { method:"POST", body: JSON.stringify({ title:d.title, format:d.format }) });
  } else if (kind === "workflow") {
    await api("/api/workflows", { method:"POST", body: JSON.stringify({ name:d.name, steps:[] }) });
  } else if (kind === "task") {
    await api("/api/tasks", { method:"POST", body: JSON.stringify({ title:d.title, priority:d.priority, dueDate:d.dueDate || null }) });
  } else if (kind === "post") {
    await api("/api/content-posts", { method:"POST", body: JSON.stringify({ platform:d.platform, externalId:d.externalId, title:d.title }) });
  } else {
    throw new Error("UNKNOWN_FORM_KIND:" + kind);
  }
  const modal = $("#modal"); if (modal && modal.close) modal.close();
  toast("Saved");
  await loadView(state.view);
}

function openForm(title, fields, kind) {
  $("#modal-body").innerHTML = '<div class="eyebrow">WORKSPACE</div><h2>'+title+'</h2><form id="entry-form" data-kind="'+kind+'" class="field-grid">'+fields.map(f=>'<div class="field full"><label>'+f.l+(f.optional?' (optional)':'')+'</label><input name="'+f.n+'"'+(f.type?' type="'+f.type+'"':'')+(f.optional?'':' required')+'></div>').join("")+'<div class="field full"><button class="btn primary" type="button" data-action="save-form">Save</button></div></form>';
  $("#modal").showModal();
}

// Phase H forms post to real backend endpoints; no placeholder actions.
function h5Form(title, kind, fields) {
  $("#modal-body").innerHTML = '<div class="eyebrow">PHASE H</div><h2>'+title+'</h2><form id="h5-action-form" data-kind="'+kind+'" class="field-grid">'+fields.map(f=>'<div class="field full"><label>'+f.l+(f.o?' (optional)':'')+'</label><input name="'+f.n+'"'+(f.o?'':' required')+'></div>').join("")+'<div class="field full"><button class="btn primary" type="submit">Save</button></div></form>';
  $("#modal").showModal();
}

async function boot() {
  wireEvents();
  const prof = document.querySelector(".profile"); if (prof && !prof.querySelector("[data-action=logout]")) { const b=document.createElement("button"); b.className="btn"; b.dataset.action="logout"; b.textContent="Logout"; prof.appendChild(b); }
  const ok = await loadMe();
  if (!ok) { renderAuth(); return; }
  updateProfile();
  await loadProductCount();
  await loadControlStatus();
  await loadView("overview");
}

boot();

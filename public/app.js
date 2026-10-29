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
    niches: [], items: []
  },
  loading: false,
  error: null
};

const titles = {overview:"Overview",radar:"Product Radar",creators:"Creators",campaigns:"Campaigns",scripts:"Script Studio",clipping:"Clipping Studio",youtube:"YouTube Intelligence",content:"Content Factory",calendar:"Publishing Calendar",analytics:"Analytics & Revenue",agents:"Agent Control",integrations:"Integrations"};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function toast(message) { const el=$("#toast"); el.textContent=message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove("show"),2300); }

function tag(text, color) { return '<span class="tag '+(color||"")+'">'+esc(text)+"</span>"; }
function heading(title, desc, action) { return '<div class="heading"><div><div class="eyebrow">CREATOR OPERATIONS</div><h1>'+title+'</h1><p>'+desc+'</p></div>'+(action||"")+'</div>'; }
function button(text, action, primary) { return '<button class="btn '+(primary?"primary":"")+'" data-action="'+action+'">'+text+'</button>'; }
function stat(label, value, note, symbol) { return '<article class="stat"><div class="stat-label">'+label+'<span class="symbol">'+symbol+'</span></div><div class="value">'+value+'</div><div class="sub">'+note+'</div></article>'; }

async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({"Content-Type":"application/json"}, opts.headers || {});
  if (state.workspaceId && !path.startsWith("/api/auth")) headers["X-Workspace-Id"] = state.workspaceId;
  const res = await fetch(path, Object.assign({}, opts, { credentials:"include", headers }));
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

async function loadMe() {
  try {
    const r = await api("/api/auth/me");
    state.user = r.user;
    state.workspaces = r.workspaces || [];
    if (!state.workspaceId && state.workspaces.length) state.workspaceId = state.workspaces[0].id;
    if (state.workspaceId) localStorage.setItem("ugc_workspaceId", state.workspaceId);
    return true;
  } catch {
    state.user = null;
    state.workspaces = [];
    return false;
  }
}

function authScreen() {
  return '<div class="page auth-wrap"><section class="panel"><h2>Sign in</h2><form id="login-form" class="field-grid"><div class="field full"><label>Email</label><input name="email" type="email" required></div><div class="field full"><label>Password</label><input name="password" type="password" required></div><div class="field full"><button class="btn primary" type="submit">Login</button></div></form><p class="sub">No account? <a href="#" id="show-signup">Sign up</a></p><div id="auth-msg" class="sub"></div></section></div>';
}

function signupScreen() {
  return '<div class="page auth-wrap"><section class="panel"><h2>Sign up</h2><form id="signup-form" class="field-grid"><div class="field full"><label>Email</label><input name="email" type="email" required></div><div class="field full"><label>Password (min 10)</label><input name="password" type="password" required minlength="10"></div><div class="field full"><label>Name</label><input name="name"></div><div class="field full"><label>Workspace name</label><input name="workspaceName" required></div><div class="field full"><label>Workspace slug</label><input name="workspaceSlug" required></div><div class="field full"><button class="btn primary" type="submit">Create account</button></div></form><p class="sub">Already have an account? <a href="#" id="show-login">Login</a></p><div id="auth-msg" class="sub"></div></section></div>';
}

let authMode = "login";

async function handleLogin(e) {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  try {
    await api("/api/auth/login", { method:"POST", body: JSON.stringify(d) });
    await loadMe();
    await loadView(state.view);
  } catch (err) { const m=$("#auth-msg"); if (m) m.textContent = err.message; }
}

async function handleSignup(e) {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  if (!d.name) delete d.name;
  try {
    await api("/api/auth/signup", { method:"POST", body: JSON.stringify(d) });
    await loadMe();
    await loadView(state.view);
  } catch (err) { const m=$("#auth-msg"); if (m) m.textContent = err.message; }
}

async function doLogout() {
  try { await api("/api/auth/logout", { method:"POST" }); } catch {}
  state.user = null; state.workspaces = []; state.workspaceId = null;
  localStorage.removeItem("ugc_workspaceId");
  renderAuth();
}

async function loadView(view) {
  state.view = view;
  state.loading = true;
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
        break;
      }
      case "radar": state.data.products = (await api("/api/products")).products; break;
      case "creators": state.data.creators = (await api("/api/creators")).creators; break;
      case "campaigns": state.data.campaigns = (await api("/api/campaigns")).campaigns; break;
      case "analytics": state.data.analytics = await api("/api/analytics/summary"); break;
      case "integrations": state.data.integrations = (await api("/api/integrations")).integrations; break;
      case "agents": {
        state.data.agents = (await api("/api/agents")).agents;
        state.data.agentTasks = (await api("/api/agent-tasks")).tasks;
        break;
      }
      case "content": state.data.contentPosts = (await api("/api/content-posts")).posts; break;
      case "scripts": state.data.ideas = (await api("/api/ideas")).ideas; break;
      case "clipping": state.data.workflows = (await api("/api/workflows")).workflows; break;
      case "youtube": state.data.contentPosts = (await api("/api/content-posts")).posts; break;
      case "calendar": state.data.tasks = (await api("/api/tasks")).tasks; break;
      case "analytics": state.data.analytics = await api("/api/analytics/summary"); break;
    }
  } catch (e) {
    state.error = e.message;
    toast("Error: " + e.message);
  } finally {
    state.loading = false;
    render();
  }
}

function loadingBlock() { return state.loading ? '<p class="sub">Loading…</p>' : ''; }

function overview() {
  const s = state.data.systemStatus;
  const o = state.data.ops || state.data.summary;
  return heading("Your creator engine, at a glance","Live data from backend. Products, creators, campaigns and tasks are persisted in PostgreSQL.", button("Refresh","refresh",true)) +
  '<div class="stats">' +
    stat("DB status", s ? s.status : "—", s ? "version "+s.version : "checking", " ") +
    stat("Workflows", o && o.summary ? o.summary.workflows : "0", "Persisted", "◈") +
    stat("Open incidents", o && o.summary ? o.summary.incidents : "0", "Reliability", "⚠") +
    stat("Content ideas", o && o.summary ? o.summary.ideas : "0", "Persisted", "✳") +
  '</div>' +
  '<div class="notice">Frontend connected to backend API. Data is persisted in PostgreSQL. Integrations show honest status from /api/integrations.</div>' +
  loadingBlock();
}

function radar() {
  const items = state.data.products || [];
  const cards = items.length ? items.map(p=>'<article class="card"><div class="card-top">'+tag(p.category||"product","purple")+'<span class="score">'+(p.priceCents!=null?p.priceCents/100:"—")+'</span></div><h3>'+esc(p.name)+'</h3><p>Persisted product opportunity.</p><div class="metrics"><div><small>Source</small><b>'+esc(p.source||"—")+'</b></div><div><small>Status</small><b>'+esc(p.status||"new")+'</b></div></div></article>').join("") : '<div class="panel">No products yet. Add one.</div>';
  return heading("Product Radar","Persisted products from /api/products.", button("＋ Add product","add-product",true)) + '<div class="cards">'+cards+'</div>' + loadingBlock();
}

function creators() {
  const rows = state.data.creators || [];
  const body = rows.length ? '<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Creator</th><th>Email</th><th>Niches</th><th>Platforms</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.name)+'</td><td>'+esc(r.email||"—")+'</td><td>'+esc(r.niches||"—")+'</td><td>'+esc(r.platforms||"—")+'</td></tr>').join("")+'</tbody></table></div></section>' : '<div class="panel">No creators yet.</div>';
  return heading("Creators","Persisted creators from /api/creators.", button("＋ Add creator","add-creator",true)) + body + loadingBlock();
}

function campaigns() {
  const rows = state.data.campaigns || [];
  const body = rows.length ? '<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Campaign</th><th>Goal</th><th>Status</th><th>Budget</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.name)+'</td><td>'+esc(r.goal||"—")+'</td><td>'+tag(r.status||"draft")+'</td><td>'+esc(r.budgetCents!=null?r.budgetCents/100:"—")+'</td></tr>').join("")+'</tbody></table></div></section>' : '<div class="panel">No campaigns yet.</div>';
  return heading("Campaigns","Persisted campaigns from /api/campaigns.", button("＋ Add campaign","add-campaign",true)) + body + loadingBlock();
}

function scripts() {
  const rows = state.data.ideas || [];
  const body = rows.length ? '<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Idea</th><th>Format</th><th>Score</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.title)+'</td><td>'+esc(r.format||"—")+'</td><td>'+esc(r.score)+'</td></tr>').join("")+'</tbody></table></div></section>' : '<div class="panel">No ideas yet.</div>';
  return heading("Script Studio / Ideas","Persisted content ideas from /api/ideas.", button("＋ Add idea","add-idea",true)) + body + loadingBlock();
}

function clipping() {
  const rows = state.data.workflows || [];
  const body = rows.length ? '<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Workflow</th><th>Steps</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.name)+'</td><td>'+esc(JSON.stringify(r.steps))+'</td></tr>').join("")+'</tbody></table></div></section>' : '<div class="panel">No workflows yet.</div>';
  return heading("Clipping Studio / Workflows","Persisted workflows from /api/workflows. Video processing is not connected.", button("＋ Add workflow","add-workflow",true)) + body + loadingBlock();
}

function content() {
  const rows = state.data.contentPosts || [];
  const body = rows.length ? '<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Platform</th><th>External ID</th><th>Title</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.platform)+'</td><td>'+esc(r.externalId)+'</td><td>'+esc(r.title||"—")+'</td></tr>').join("")+'</tbody></table></div></section>' : '<div class="panel">No content posts yet.</div>';
  return heading("Content Factory","Persisted content posts from /api/content-posts.", button("＋ Add post","add-post",true)) + body + loadingBlock();
}

function youtube() {
  return heading("YouTube Intelligence","Manual research only. No YouTube API configured.") + '<div class="notice">No YouTube API or transcript provider is configured. This workspace accepts manual research notes; it does not download videos.</div>' + loadingBlock();
}

function calendar() {
  const rows = state.data.tasks || [];
  const body = rows.length ? '<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Task</th><th>Status</th><th>Priority</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.title)+'</td><td>'+esc(r.status)+'</td><td>'+esc(r.priority)+'</td></tr>').join("")+'</tbody></table></div></section>' : '<div class="panel">No tasks yet.</div>';
  return heading("Publishing Calendar / Tasks","Persisted tasks from /api/tasks.", button("＋ Add task","add-task",true)) + body + loadingBlock();
}

function analytics() {
  const a = state.data.analytics;
  const m = a && a.summary ? a.summary.metrics : {};
  const clicks = a && a.summary ? a.summary.clicks : 0;
  const convs = a && a.summary ? a.summary.conversions : 0;
  return heading("Analytics & Revenue","Aggregated from persisted snapshots/clicks. No external analytics connected.") +
  '<div class="notice">No external analytics or affiliate network is connected. Values reflect manually recorded data only.</div>' +
  '<div class="stats">'+stat("Clicks", clicks, "Recorded", "↗")+stat("Conversions", convs, "Recorded", "✓")+stat("Metrics", Object.keys(m).length, "Distinct", "⌁")+'</div>' +
  (Object.keys(m).length ? '<section class="panel"><h2>Metrics</h2><pre>'+esc(JSON.stringify(m,null,2))+'</pre></section>' : '') + loadingBlock();
}

function agents() {
  const agents = state.data.agents || [];
  const tasks = state.data.agentTasks || [];
  return heading("Agent Control","Persisted agents/tasks from /api/agents and /api/agent-tasks.") +
  '<div class="notice">Safe mode: agent tasks execute a simple echo. No external AI provider connected.</div>' +
  '<section class="panel"><h2>Agents</h2>' + (agents.length ? agents.map(a=>'<p>'+esc(a.name)+' — '+esc(a.role)+'</p>').join("") : '<p class="sub">No agents yet.</p>') + '</section>' +
  '<section class="panel"><h2>Tasks</h2>' + (tasks.length ? tasks.map(t=>'<p>'+esc(t.name)+' — '+esc(t.status)+'</p>').join("") : '<p class="sub">No tasks yet.</p>') + '</section>' + loadingBlock();
}

function integrations() {
  const rows = state.data.integrations || [];
  const cards = rows.length ? rows.map(i=>'<article class="card">'+tag(i.status==="CONFIGURED"?"CONFIGURED":"NOT CONFIGURED", i.status==="CONFIGURED"?"green":"orange")+'<h3>'+esc(i.name)+'</h3><p>'+esc(i.description)+'</p><p class="sub">env: '+esc(i.envKey)+'</p></article>').join("") : '<div class="panel">No integrations.</div>';
  return heading("Integrations","Honest status from /api/integrations. No secrets stored in browser.") + '<div class="notice">Credentials are never stored in browser code. Set API keys server-side via env or POST /api/integrations/:provider.</div><div class="cards">'+cards+'</div>' + loadingBlock();
}

const views = {overview,radar,creators,campaigns,scripts,clipping,youtube,content,calendar,analytics,agents,integrations};

function renderAuth() {
  document.body.innerHTML = authMode==="login" ? authScreen() : signupScreen();
  const lf = $("#login-form"); if (lf) lf.addEventListener("submit", handleLogin);
  const sf = $("#signup-form"); if (sf) sf.addEventListener("submit", handleSignup);
  const sl = $("#show-login"); if (sl) sl.addEventListener("click", (e)=>{e.preventDefault(); authMode="login"; renderAuth();});
  const ss = $("#show-signup"); if (ss) ss.addEventListener("click", (e)=>{e.preventDefault(); authMode="signup"; renderAuth();});
}

function render() {
  if (!state.user) { renderAuth(); return; }
  // ensure shell exists
  if (!$("#page")) {
    document.body.innerHTML = '<div class="app"><aside class="sidebar" id="sidebar"></aside><main><header class="topbar"></header><section id="page" class="page"></section></main></div>';
  }
  // minimal shell: reuse original index.html? We replaced body, so rebuild minimal
  // Instead, if shell missing, redirect to reload to get original HTML
  if (!document.querySelector(".app")) {
    window.location.reload();
    return;
  }
  $("#page").innerHTML = (views[state.view]||overview)();
  const crumb = $("#crumb"); if (crumb) crumb.textContent = titles[state.view]||"Overview";
  document.querySelectorAll(".nav[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===state.view));
  const sb = $("#sidebar"); if (sb) sb.classList.remove("open");
}

// We rely on original index.html shell. Re-render into #page only.
function renderPage() {
  if (!state.user) { renderAuth(); return; }
  const page = $("#page");
  if (!page) { window.location.reload(); return; }
  page.innerHTML = (views[state.view]||overview)();
  const crumb = $("#crumb"); if (crumb) crumb.textContent = titles[state.view]||"Overview";
  document.querySelectorAll(".nav[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===state.view));
  const sb = $("#sidebar"); if (sb) sb.classList.remove("open");
}

// Override render
function render() { renderPage(); }

// Event wiring (once)
function wireEvents() {
  document.addEventListener("click", async (e)=>{
    const v = e.target.closest("[data-view]");
    if (v) { e.preventDefault(); await loadView(v.dataset.view); return; }
    const a = e.target.closest("[data-action]");
    if (a) {
      const name = a.dataset.action;
      if (name === "refresh") { await loadView(state.view); return; }
      if (name === "logout") { await doLogout(); return; }
      if (name === "add-product") { openForm("Add product", [{n:"name",l:"Name"},{n:"category",l:"Category"},{n:"source",l:"Source"}], "product"); return; }
      if (name === "add-creator") { openForm("Add creator", [{n:"name",l:"Name"},{n:"email",l:"Email"},{n:"niches",l:"Niches"},{n:"platforms",l:"Platforms"}], "creator"); return; }
      if (name === "add-campaign") { openForm("Add campaign", [{n:"name",l:"Name"},{n:"goal",l:"Goal"},{n:"status",l:"Status"}], "campaign"); return; }
      if (name === "add-idea") { openForm("Add idea", [{n:"title",l:"Title"},{n:"format",l:"Format"}], "idea"); return; }
      if (name === "add-workflow") { openForm("Add workflow", [{n:"name",l:"Name"}], "workflow"); return; }
      if (name === "add-task") { openForm("Add task", [{n:"title",l:"Title"},{n:"priority",l:"Priority"}], "task"); return; }
      if (name === "add-post") { openForm("Add post", [{n:"platform",l:"Platform"},{n:"externalId",l:"External ID"},{n:"title",l:"Title"}], "post"); return; }
      if (name === "save-form") {
        const form = $("#entry-form");
        if (!form) return;
        const d = Object.fromEntries(new FormData(form));
        const kind = form.dataset.kind;
        (async () => {
          try {
            if (kind === "product") await api("/api/products", {method:"POST", body: JSON.stringify({name:d.name, category:d.category, source:d.source})});
            if (kind === "creator") await api("/api/creators", {method:"POST", body: JSON.stringify({name:d.name, email:d.email, niches:d.niches, platforms:d.platforms})});
            if (kind === "campaign") await api("/api/campaigns", {method:"POST", body: JSON.stringify({name:d.name, goal:d.goal, status:d.status})});
            if (kind === "idea") await api("/api/ideas", {method:"POST", body: JSON.stringify({title:d.title, format:d.format})});
            if (kind === "workflow") await api("/api/workflows", {method:"POST", body: JSON.stringify({name:d.name, steps:[]})});
            if (kind === "task") await api("/api/tasks", {method:"POST", body: JSON.stringify({title:d.title, priority:d.priority})});
            if (kind === "post") await api("/api/content-posts", {method:"POST", body: JSON.stringify({platform:d.platform, externalId:d.externalId, title:d.title})});
            $("#modal").close();
            toast("Saved");
            await loadView(state.view);
          } catch (err) { toast("Error: "+err.message); }
        })();
        return;
      }
    }
  });
  document.addEventListener("submit", async (e)=>{
    console.log("SUBMIT EVENT", e.target && e.target.id);
    if (e.target.id === "entry-form") {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      const kind = e.target.dataset.kind;
      try {
        if (kind === "product") await api("/api/products", {method:"POST", body: JSON.stringify({name:d.name, category:d.category, source:d.source})});
        if (kind === "creator") await api("/api/creators", {method:"POST", body: JSON.stringify({name:d.name, email:d.email, niches:d.niches, platforms:d.platforms})});
        if (kind === "campaign") await api("/api/campaigns", {method:"POST", body: JSON.stringify({name:d.name, goal:d.goal, status:d.status})});
        if (kind === "idea") await api("/api/ideas", {method:"POST", body: JSON.stringify({title:d.title, format:d.format})});
        if (kind === "workflow") await api("/api/workflows", {method:"POST", body: JSON.stringify({name:d.name, steps:[]})});
        if (kind === "task") await api("/api/tasks", {method:"POST", body: JSON.stringify({title:d.title, priority:d.priority})});
        if (kind === "post") await api("/api/content-posts", {method:"POST", body: JSON.stringify({platform:d.platform, externalId:d.externalId, title:d.title})});
        $("#modal").close();
        toast("Saved");
        await loadView(state.view);
      } catch (err) { toast("Error: "+err.message); }
    }
  });
  const menu = $("#menu"); if (menu) menu.addEventListener("click", ()=>$("#sidebar").classList.toggle("open"));
  const help = $("#help"); if (help) help.addEventListener("click", ()=>{ $("#modal-body").innerHTML="<h2>UGC OS</h2><p>Connected to backend. Data persisted in PostgreSQL.</p>"; $("#modal").showModal(); });
  const close = $("#close"); if (close) close.addEventListener("click", ()=>$("#modal").close());
}

function openForm(title, fields, kind) {
  $("#modal-body").innerHTML = '<div class="eyebrow">WORKSPACE</div><h2>'+title+'</h2><form id="entry-form" data-kind="'+kind+'" class="field-grid">'+fields.map(f=>'<div class="field full"><label>'+f.l+'</label><input name="'+f.n+'" required></div>').join("")+'<div class="field full"><button class="btn primary" type="button" data-action="save-form">Save</button></div></form>';
  $("#modal").showModal();
}

async function boot() {
  wireEvents();
  const prof = document.querySelector(".profile"); if (prof && !prof.querySelector("[data-action=logout]")) { const b=document.createElement("button"); b.className="btn"; b.dataset.action="logout"; b.textContent="Logout"; prof.appendChild(b); }
  const ok = await loadMe();
  if (!ok) { renderAuth(); return; }
  // add logout to profile area if possible
  await loadView("overview");
}

boot();

const state = {
  view: "overview",
  tasks: [
    {id:1,title:"Review skincare product shortlist",done:false},
    {id:2,title:"Approve creator script drafts",done:false},
    {id:3,title:"Review sample clip queue",done:false},
    {id:4,title:"Plan next week content slots",done:true}
  ],
  products: [
    {id:1,name:"Hydration Serum",category:"Beauty & skincare",commission:"18%",price:"€24.90",status:"Shortlisted",score:92},
    {id:2,name:"Portable Blender",category:"Fitness & lifestyle",commission:"12%",price:"€39.00",status:"Review",score:87},
    {id:3,name:"Desk Light Pro",category:"Home & workspace",commission:"15%",price:"€32.50",status:"Shortlisted",score:81},
    {id:4,name:"Travel Organizer",category:"Travel accessories",commission:"10%",price:"€19.90",status:"Research",score:76}
  ],
  campaigns: [
    {name:"Glow Routine UGC",channel:"TikTok · Instagram",status:"In production"},
    {name:"Desk Setup Refresh",channel:"YouTube Shorts",status:"Needs review"},
    {name:"Everyday Carry Test",channel:"TikTok",status:"Planning"}
  ]
};
const titles = {overview:"Overview",radar:"Product Radar",creators:"Creators",campaigns:"Campaigns",scripts:"Script Studio",clipping:"Clipping Studio",youtube:"YouTube Intelligence",content:"Content Factory",calendar:"Publishing Calendar",analytics:"Analytics & Revenue",agents:"Agent Control",integrations:"Integrations"};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function toast(message) { const el=$("#toast"); el.textContent=message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove("show"),2300); }
function tag(text, color) { return '<span class="tag '+(color||"")+'">'+esc(text)+"</span>"; }
function heading(title, desc, action) { return '<div class="heading"><div><div class="eyebrow">CREATOR OPERATIONS</div><h1>'+title+'</h1><p>'+desc+'</p></div>'+(action||"")+'</div>'; }
function button(text, action, primary) { return '<button class="btn '+(primary?"primary":"")+'" data-action="'+action+'">'+text+'</button>'; }
function stat(label, value, note, symbol) { return '<article class="stat"><div class="stat-label">'+label+'<span class="symbol">'+symbol+'</span></div><div class="value">'+value+'</div><div class="sub">'+note+'</div></article>'; }
function panel(title, subtitle, body) { return '<section class="panel"><div class="panel-head"><div><h2>'+title+'</h2><p>'+subtitle+'</p></div></div>'+body+'</section>'; }
function taskList() { return state.tasks.map(t=>'<label class="task"><input type="checkbox" data-task="'+t.id+'" '+(t.done?"checked":"")+'><span class="task-text"><b '+(t.done?'style="text-decoration:line-through;color:#78869a"':"")+'>'+esc(t.title)+'</b><small>Local checklist item</small></span></label>').join(""); }
function overview() {
  return heading("Your creator engine, at a glance","Research products, coordinate creators, and move short-form content through one focused workspace.",button("＋ Create workflow","workflow",true)) +
  '<div class="stats">'+stat("Tracked opportunities","24","Illustrative sample records","⌕")+stat("Active campaigns",state.campaigns.length,"Local sample campaigns","◈")+stat("Assets in pipeline","6","Drafts, edits and reviews","▣")+stat("Open tasks",state.tasks.filter(t=>!t.done).length,"Local checklist items","✓")+'</div>' +
  '<div class="grid"><div>'+panel("Content pipeline","Illustrative stage counts",'<div class="pipeline"><div class="step"><small>Ideas</small><b>12</b><div class="bar"><span style="width:70%"></span></div></div><div class="step"><small>Scripts</small><b>08</b><div class="bar"><span style="width:52%"></span></div></div><div class="step"><small>Editing</small><b>05</b><div class="bar"><span style="width:35%"></span></div></div><div class="step"><small>Review</small><b>03</b><div class="bar"><span style="width:22%"></span></div></div></div>')+
  panel("Priority queue","Check tasks off to update this view",taskList())+
  panel("System status","Honest integration status",'<p class="sub">Dashboard available</p><p class="sub">AI provider not connected</p><p class="sub">Publishing and affiliate APIs not connected</p><p class="sub">Persistent database not configured</p>')+
  '</div><div>'+panel("Activity trend","Illustrative index · not real analytics",'<div class="chart">'+[25,39,32,56,48,66,59,82,72,92,76,100].map(v=>'<div style="height:'+v+'%"></div>').join("")+'</div><p class="sub">Demo only — no revenue data connected</p>')+
  panel("Workspace activity","Local events",'<p class="sub">Workspace initialized</p><p class="sub">Four sample product opportunities loaded</p><p class="sub">AI provider setup required before agent execution</p>')+'</div></div>';
}
function productCards(items) {
  if (!items.length) return '<div class="panel">No matching products. Try another filter.</div>';
  return items.map(p=>'<article class="card"><div class="card-top">'+tag(p.category,"purple")+'<span class="score">'+p.score+'</span></div><h3>'+esc(p.name)+'</h3><p>Sample opportunity. Validate offer terms, audience fit, and product claims before spending.</p><div class="metrics"><div><small>Commission</small><b>'+esc(p.commission)+'</b></div><div><small>Price</small><b>'+esc(p.price)+'</b></div><div><small>Status</small><b>'+esc(p.status)+'</b></div></div><div class="card-actions"><button class="btn" data-action="cycle-product" data-id="'+p.id+'">Change status</button><button class="btn" data-action="brief" data-id="'+p.id+'">Brief</button></div></article>').join("");
}
function radar() { return heading("Product Radar","Affiliate opportunity research. Scores and commissions shown are illustrative.",button("＋ Add opportunity","add-product",true))+'<div class="search-row"><input id="search" class="search" placeholder="Search products or categories…"><select id="filter" class="select"><option value="all">All statuses</option><option>Shortlisted</option><option>Review</option><option>Research</option></select></div><div class="cards" id="product-cards">'+productCards(state.products)+'</div>'; }
function tableView(title, desc, rows, cols, action) {
  return heading(title,desc,button("＋ Add new",action,true))+'<section class="panel"><div class="table-wrap"><table class="table"><thead><tr>'+cols.map(c=>'<th>'+c.label+'</th>').join("")+'<th></th></tr></thead><tbody>'+rows.map((r,i)=>'<tr>'+cols.map(c=>'<td>'+(c.render?c.render(r):esc(r[c.key]))+'</td>').join("")+'<td><button data-action="row" data-kind="'+action+'" data-id="'+i+'">Open</button></td></tr>').join("")+'</tbody></table></div></section>';
}
function campaigns() { return tableView("Campaigns","Coordinate creator briefs and asset delivery.",state.campaigns,[{label:"Campaign",key:"name"},{label:"Channels",key:"channel"},{label:"Status",render:r=>tag(r.status)}],"add-campaign"); }
function creators() { return tableView("Creator workspace","Organize creator research and outreach drafts. No messages are sent.",[{name:"Creator Alpha",niche:"Beauty · Lifestyle",channel:"TikTok",status:"Shortlisted"},{name:"Creator Beta",niche:"Home · Tech",channel:"YouTube Shorts",status:"Outreach draft"}],[{label:"Creator",key:"name"},{label:"Niche",key:"niche"},{label:"Channel",key:"channel"},{label:"Status",render:r=>tag(r.status)}],"add-creator"); }
function scripts() { return tableView("Script Studio","Build hooks, story beats and calls to action.",[{name:"Problem / solution hook",type:"UGC demo",length:"15–20 sec",status:"Draft"},{name:"Three things I wish I knew",type:"Testimonial",length:"30 sec",status:"Needs review"}],[{label:"Script",key:"name"},{label:"Type",key:"type"},{label:"Length",key:"length"},{label:"Status",render:r=>tag(r.status)}],"add-script"); }
function clipping() { return tableView("Clipping Studio","Manage sample jobs. Video processing is not connected yet.",[{name:"Morning routine — hook A",format:"9:16 · 30 sec",status:"Queued"},{name:"Desk setup — before/after",format:"9:16 · 22 sec",status:"Ready for review"}],[{label:"Clip job",key:"name"},{label:"Output",key:"format"},{label:"Status",render:r=>tag(r.status)}],"add-clip"); }
function content() { return tableView("Content Factory","Move content concepts from brief to review.",[{name:"Hydration serum — benefit-led cut",format:"TikTok · 9:16",stage:"Edit",status:"In progress"},{name:"Desk setup — transformation",format:"Shorts · 9:16",stage:"Review",status:"Needs review"}],[{label:"Asset",key:"name"},{label:"Format",key:"format"},{label:"Stage",key:"stage"},{label:"Status",render:r=>tag(r.status)}],"add-content"); }
function youtube() { return heading("YouTube Intelligence","Capture video research, reusable hooks and editing patterns.")+'<div class="notice">No YouTube API or transcript provider is configured. This workspace accepts manual research notes; it does not download videos.</div><section class="panel"><h2>Research intake</h2><form id="yt-form" class="field-grid"><div class="field full"><label>Video URL</label><input type="url" id="yt-url" required placeholder="https://www.youtube.com/watch?v=…"></div><div class="field"><label>Video title</label><input id="yt-title" required placeholder="Title or topic"></div><div class="field"><label>Research type</label><select id="yt-type"><option>Hook analysis</option><option>Editing pattern</option><option>Product review</option></select></div><div class="field full"><label>Notes</label><textarea id="yt-notes" placeholder="Hook, pacing, story structure, proof, CTA…"></textarea></div><div class="field full"><button class="btn primary">Save research note</button></div></form><div id="yt-results"></div></section>'; }
function calendar() { return heading("Publishing Calendar","Plan slots and reviews. Nothing is published automatically.")+'<section class="panel"><h2>October 26 – November 1, 2026</h2><div class="calendar">'+["Mon 26","Tue 27","Wed 28","Thu 29","Fri 30","Sat 31","Sun 1"].map((d,i)=>'<div class="day"><b>'+d+'</b>'+(i===0?'<div class="event">Serum hook draft</div>':"")+(i===2?'<div class="event blue">Desk setup edit</div>':"")+'</div>').join("")+'</div></section>'; }
function analytics() { return heading("Analytics & Revenue","Reporting shell ready for real affiliate and platform data.")+'<div class="notice">No analytics or affiliate network is connected. No real revenue is being reported.</div><div class="stats">'+stat("Clicks","—","Waiting for data source","↗")+stat("Conversions","—","Waiting for data source","✓")+stat("Commission","—","Network not connected","€")+stat("Content ROI","—","Needs cost and revenue data","⌁")+'</div>'; }
function agents() { return heading("Agent Control","Internal agent runtime belongs in this standalone repository.")+'<div class="notice">Safe mode is active. No agents, external messages, publishing or spending run from this frontend.</div><section class="panel"><h2>Internal agent registry</h2><p>Decision Engine — planned</p><p>Product Research Agent — planned</p><p>Creator Ops Agent — planned</p><p>Script Agent — planned</p><p>Clip Planner Agent — planned</p><p>Analytics Agent — planned</p></section>'; }
function integrations() { return heading("Integrations","Documented adapters and explicit connection status.")+'<div class="notice">Never commit API keys. Credentials must be stored server-side, not in browser code.</div><div class="cards">'+["AI / LLM provider","Affiliate networks","YouTube","Video processing","Publishing platforms","Database & queue"].map(n=>'<article class="card">'+tag("NOT CONNECTED","orange")+'<h3>'+n+'</h3><p>Integration adapter not implemented.</p></article>').join("")+'</div>'; }
function render() {
  const views={overview,radar,creators,campaigns,scripts,clipping,youtube,content,calendar,analytics,agents,integrations};
  $("#page").innerHTML=(views[state.view]||overview)();
  $("#crumb").textContent=titles[state.view]||"Overview";
  document.querySelectorAll(".nav[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===state.view));
  $("#sidebar").classList.remove("open");
}
function input(name,label,placeholder) { return '<div class="field"><label>'+label+'</label><input name="'+name+'" required placeholder="'+placeholder+'"></div>'; }
function openForm(title,fields,kind) { $("#modal-body").innerHTML='<div class="eyebrow">LOCAL WORKSPACE</div><h2>'+title+'</h2><form id="entry-form" data-kind="'+kind+'" class="field-grid">'+fields+'<div class="field full"><button class="btn primary">Save locally</button></div></form><p class="sub">Saved in this page session only. Persistent storage is not implemented yet.</p>'; $("#modal").showModal(); }
function action(name,id) {
  if(name==="add-product") openForm("Add opportunity",input("name","Product name","Product or offer")+input("category","Category","Beauty, tech")+input("commission","Commission","e.g. 12%")+input("price","Price","e.g. €29.90"),"product");
  if(name==="add-campaign") openForm("Create campaign",input("name","Campaign name","Campaign title")+input("channel","Channels","TikTok, Shorts"),"campaign");
  if(name==="add-creator") openForm("Add creator",input("name","Creator name","Creator handle")+input("niche","Niche","Beauty, tech")+input("channel","Channel","TikTok / Instagram"),"creator");
  if(name==="add-script") openForm("New script brief",input("name","Script title","Hook or concept")+input("type","Format","UGC demo")+input("length","Target length","15–30 sec"),"script");
  if(name==="add-clip") openForm("New clip job",input("name","Clip job name","Clip concept")+input("format","Output format","9:16 · 30 sec"),"clip");
  if(name==="add-content") openForm("Plan content asset",input("name","Asset title","Content concept")+input("format","Format","TikTok · 9:16")+input("stage","Stage","Brief / Edit / Review"),"content");
  if(name==="workflow") openForm("Create workflow",input("name","Workflow name","Product launch")+input("goal","Goal","Create five short-form assets"),"workflow");
  if(name==="cycle-product") { const p=state.products.find(x=>x.id===id); p.status=({Shortlisted:"Review",Review:"Research",Research:"Shortlisted"})[p.status]||"Review"; render(); toast("Product status updated"); }
  if(name==="brief") { const p=state.products.find(x=>x.id===id); $("#modal-body").innerHTML="<h2>"+esc(p.name)+"</h2><p>Sample commission: "+esc(p.commission)+" · Sample price: "+esc(p.price)+"</p><p>Validate offer source, terms, claims and disclosure requirements before spending.</p>"; $("#modal").showModal(); }
  if(name==="row") toast("Sample record — backend workflow not implemented");
}
document.addEventListener("click",e=>{const v=e.target.closest("[data-view]");if(v){e.preventDefault();state.view=v.dataset.view;render();return;}const a=e.target.closest("[data-action]");if(a)action(a.dataset.action,Number(a.dataset.id));});
document.addEventListener("change",e=>{if(e.target.matches("[data-task]")){const t=state.tasks.find(x=>x.id===Number(e.target.dataset.task));t.done=e.target.checked;render();toast(t.done?"Task completed":"Task reopened");}if(e.target.id==="filter"||e.target.id==="search")filterProducts();});
function filterProducts(){const q=($("#search")?.value||"").toLowerCase(),f=$("#filter")?.value||"all";$("#product-cards").innerHTML=productCards(state.products.filter(p=>(p.name+" "+p.category).toLowerCase().includes(q)&&(f==="all"||p.status===f)));}
document.addEventListener("submit",e=>{
  if(e.target.id==="entry-form"){e.preventDefault();const d=Object.fromEntries(new FormData(e.target)),kind=e.target.dataset.kind;
    if(kind==="product"){state.products.unshift({id:Date.now(),name:d.name,category:d.category,score:0,commission:d.commission,price:d.price,status:"Research"});state.view="radar";}
    if(kind==="campaign"){state.campaigns.unshift({name:d.name,channel:d.channel,status:"Planning"});state.view="campaigns";}
    if(kind==="script"){state.view="scripts";toast("Script brief noted; persistence is not connected.");}
    if(kind==="clip"){state.view="clipping";toast("Clip job noted; processing is not connected.");}
    if(kind==="content"){state.view="content";toast("Content brief noted.");}
    $("#modal").close();render();if(kind==="product"||kind==="campaign")toast("Saved to current session");
  }
  if(e.target.id==="yt-form"){e.preventDefault();const row=document.createElement("div");row.className="activity-row";row.innerHTML='<span class="activity-icon">▷</span><div><b>'+esc($("#yt-title").value)+'</b><p>'+esc($("#yt-url").value)+'<br>'+esc($("#yt-type").value)+' · '+esc($("#yt-notes").value)+'</p></div>';$("#yt-results").append(row);e.target.reset();toast("Research note added to this page session");}
});
$("#menu").addEventListener("click",()=>$("#sidebar").classList.toggle("open"));
$("#help").addEventListener("click",()=>{$("#modal-body").innerHTML="<h2>UGC OS · v0.1.0</h2><p>First working UI foundation for a standalone UGC affiliate and creator platform.</p><p>Demo data only. AI, persistence, video processing, publishing, YouTube and affiliate APIs are not connected yet.</p>";$("#modal").showModal();});
$("#close").addEventListener("click",()=>$("#modal").close());
render();

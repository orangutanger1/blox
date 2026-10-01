// Single-file dashboard UI. Polls /api/state (files) every 3s and /api/studio
// (live attach probe) every 15s. Built to answer three questions, in order:
// does anything need me? is the game working? what is the agent doing?
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>blox dashboard</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--ink:#16181d;--muted:#5d6472;--line:#e3e6eb;--ok:#1f8a4c;--bad:#c4302b;--warn:#b26a00;--accent:#3557d4;--chip:#eef1f6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#171a21;--ink:#e8eaee;--muted:#9aa2b1;--line:#262b35;--ok:#3fbf75;--bad:#ff6b63;--warn:#f0a43a;--accent:#7b96ff;--chip:#20252f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;gap:12px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:1}
header h1{font-size:16px;margin:0}header .sp{flex:1}
.chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;background:var(--chip);font-size:12px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}.ok .dot{background:var(--ok)}.bad .dot{background:var(--bad)}.warn .dot{background:var(--warn)}
main{display:grid;grid-template-columns:repeat(12,1fr);gap:14px;padding:16px 20px;max-width:1400px;margin:0 auto}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;min-width:0}
section h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.c12{grid-column:span 12}.c7{grid-column:span 7}.c5{grid-column:span 5}.c6{grid-column:span 6}
@media (max-width:900px){.c7,.c5,.c6{grid-column:span 12}main{padding:12px 16px}}
.big{font-size:28px;font-weight:650}.muted{color:var(--muted)}.okc{color:var(--ok)}.badc{color:var(--bad)}.warnc{color:var(--warn)}
ul{list-style:none;margin:0;padding:0}li{padding:6px 0;border-top:1px solid var(--line)}li:first-child{border-top:0}
.row{display:flex;gap:8px;align-items:baseline}.row .grow{flex:1;min-width:0;overflow-wrap:anywhere}
code,pre{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}pre{white-space:pre-wrap;margin:4px 0 0;color:var(--muted)}
.ev{display:grid;grid-template-columns:70px 110px 1fr 60px;gap:8px;padding:5px 0;border-top:1px solid var(--line);font-size:13px}
.ev:first-child{border-top:0}.ev .t{color:var(--muted);font-variant-numeric:tabular-nums}.ev .ms{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
@media (max-width:600px){.ev{grid-template-columns:60px 1fr 50px}.ev .tool{display:none}}
.attn li{display:flex;gap:8px}.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.shots img{width:100%;border-radius:6px;border:1px solid var(--line);display:block}
svg.trend{width:100%;height:56px;display:block}
.empty{color:var(--muted);font-style:italic}
</style></head><body>
<header><h1 id="proj">blox</h1><span class="chip" id="studio"><span class="dot"></span>studio…</span><span class="chip" id="activity"><span class="dot"></span>idle</span><span class="sp"></span><span class="muted" id="updated"></span></header>
<main>
<section class="c12"><h2>Needs attention</h2><ul class="attn" id="attn"></ul></section>
<section class="c7"><h2>Goal &amp; acceptance criteria</h2><div id="task"></div></section>
<section class="c5"><h2>Tests</h2><div id="tests"></div></section>
<section class="c6"><h2>Last playtest</h2><div id="play"></div></section>
<section class="c6"><h2>Screenshots</h2><div id="shots"></div></section>
<section class="c12"><h2>Activity</h2><div id="events"></div></section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago = (iso) => { const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
let studio = null;
function chip(el, cls, text){ el.className = 'chip ' + cls; el.innerHTML = '<span class="dot"></span>' + esc(text); }
function trend(h){
  if (!h.length) return '';
  const w = 300, ht = 50, n = h.length, pts = h.map((x, i) => [n === 1 ? w / 2 : i * w / (n - 1), ht - (x.total ? x.passed / x.total : 0) * (ht - 6) - 3]);
  return '<svg class="trend" viewBox="0 0 ' + w + ' ' + ht + '" preserveAspectRatio="none" aria-label="test pass rate over runs"><polyline fill="none" stroke="var(--accent)" stroke-width="2" points="' + pts.map(p => p.join(',')).join(' ') + '"/>' + pts.map(p => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="2.5" fill="var(--accent)"/>').join('') + '</svg><div class="muted">pass rate across the last ' + n + ' run_tests calls</div>';
}
function render(s){
  $('proj').textContent = 'blox · ' + s.project.name;
  $('updated').textContent = 'updated ' + new Date(s.now).toLocaleTimeString();
  const last = s.events[0];
  if (last && Date.now() - Date.parse(last.ts) < 90000) chip($('activity'), 'ok', 'active · ' + last.tool + ' ' + ago(last.ts) + ' ago');
  else chip($('activity'), '', last ? 'idle · last ' + last.tool + ' ' + ago(last.ts) + ' ago' : 'no activity yet');
  // attention
  const attn = [];
  if (studio && !studio.attached) attn.push(['bad', 'Studio not attached: ' + studio.error]);
  for (const b of (s.task && s.task.blockers) || []) attn.push(['bad', 'Blocker: ' + b.text]);
  const lt = s.lastTests;
  if (lt && !lt.ok) attn.push(['warn', (lt.total - lt.passed) + ' failing test(s), ' + (lt.fileErrors || []).length + ' spec file error(s)']);
  const lp = s.lastPlaytest;
  if (lp && lp.logs && lp.logs.errors.length) attn.push(['warn', lp.logs.errors.length + ' runtime error(s) in the last playtest']);
  const errs = s.events.filter(e => !e.ok).slice(0, 3);
  for (const e of errs) if (Date.now() - Date.parse(e.ts) < 600000) attn.push(['warn', e.tool + ' failed ' + ago(e.ts) + ' ago: ' + (e.error || e.summary)]);
  $('attn').innerHTML = attn.length ? attn.map(a => '<li><span class="' + (a[0] === 'bad' ? 'badc' : 'warnc') + '">●</span><span class="grow">' + esc(a[1]) + '</span></li>').join('') : '<li class="okc">Nothing needs you right now.</li>';
  // task
  const t = s.task;
  if (!t) $('task').innerHTML = '<p class="empty">No task recorded. Agents set it with the task tool.</p>';
  else {
    const done = t.criteria.filter(c => c.status === 'pass').length;
    $('task').innerHTML = '<p><b>' + esc(t.goal) + '</b></p><div class="big">' + done + '/' + t.criteria.length + ' <span class="muted" style="font-size:14px">criteria passing</span></div><ul>' +
      t.criteria.map(c => '<li class="row"><span class="' + (c.status === 'pass' ? 'okc' : c.status === 'fail' ? 'badc' : 'muted') + '">' + (c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '○') + '</span><span class="grow"><b>' + esc(c.id) + '</b> ' + esc(c.text) + (c.evidence ? '<pre>' + esc(c.evidence) + '</pre>' : '') + '</span></li>').join('') + '</ul>' +
      (t.notes.length ? '<h2 style="margin-top:12px">Notes</h2><ul>' + t.notes.slice(-5).reverse().map(n => '<li>' + esc(n.text) + ' <span class="muted">' + ago(n.ts) + ' ago</span></li>').join('') + '</ul>' : '');
  }
  // tests
  if (!lt) $('tests').innerHTML = '<p class="empty">Never run.</p>' + trend(s.testHistory);
  else {
    const failing = lt.tests.filter(x => x.status !== 'pass');
    $('tests').innerHTML = '<div class="big ' + (lt.ok ? 'okc' : 'badc') + '">' + lt.passed + '/' + lt.total + '</div><div class="muted">ran ' + ago(lt.ranAt) + ' ago</div>' + trend(s.testHistory) +
      '<ul>' + (lt.fileErrors || []).map(f => '<li><span class="badc">file error</span> ' + esc(f.file) + '<pre>' + esc(f.message) + '</pre></li>').join('') +
      failing.map(x => '<li><span class="badc">' + esc(x.status) + '</span> [' + esc(x.context) + '] ' + esc(x.name) + '<pre>' + esc(x.message || '') + '</pre></li>').join('') + '</ul>';
  }
  // playtest
  if (!lp) $('play').innerHTML = '<p class="empty">No playtest yet.</p>';
  else {
    const L = lp.logs;
    $('play').innerHTML = '<div class="row"><span class="' + (lp.ok ? 'okc' : 'badc') + '"><b>' + (lp.ok ? 'OK' : 'PROBLEMS') + '</b></span><span class="muted grow">' + ago(lp.at) + ' ago · players ' + lp.ready.players + ' · ' + L.errors.length + ' errors · ' + L.warnings.length + ' warnings</span></div><ul>' +
      L.errors.slice(0, 8).map(e => '<li><span class="badc">error</span> [' + esc(e.context) + ']<pre>' + esc(e.message) + '</pre></li>').join('') +
      L.warnings.slice(0, 5).map(e => '<li><span class="warnc">warn</span> [' + esc(e.context) + ']<pre>' + esc(e.message) + '</pre></li>').join('') +
      L.output.slice(-6).map(e => '<li><span class="muted">out</span> [' + esc(e.context) + '] ' + esc(e.message) + '</li>').join('') + '</ul>';
  }
  // screenshots
  $('shots').innerHTML = s.artifacts.length ? '<div class="shots">' + s.artifacts.map(a => '<a href="/artifacts/' + encodeURIComponent(a.name) + '" target="_blank"><img loading="lazy" src="/artifacts/' + encodeURIComponent(a.name) + '" alt="' + esc(a.name) + '"></a>').join('') + '</div>' : '<p class="empty">None yet (playtest {screenshot:true} or screenshot).</p>';
  // events
  $('events').innerHTML = s.events.length ? s.events.slice(0, 80).map(e => '<div class="ev"><span class="t">' + ago(e.ts) + '</span><span class="tool"><code>' + esc(e.tool) + '</code></span><span class="grow"><span class="' + (e.ok ? 'okc' : 'badc') + '">' + (e.ok ? '●' : '✗') + '</span> ' + esc(e.summary) + (e.agent ? ' <span class="muted">· ' + esc(e.agent) + '</span>' : '') + (!e.ok && e.error ? '<pre>' + esc(e.error) + '</pre>' : '') + '</span><span class="ms">' + (e.ms >= 1000 ? (e.ms / 1000).toFixed(1) + 's' : e.ms + 'ms') + '</span></div>').join('') : '<p class="empty">No tool calls yet.</p>';
}
async function tick(){ try { render(await (await fetch('/api/state')).json()); } catch (e) { $('updated').textContent = 'dashboard server unreachable'; } }
async function probe(){ try { studio = await (await fetch('/api/studio')).json(); chip($('studio'), studio.attached ? 'ok' : 'bad', studio.attached ? 'studio · ' + (studio.name || 'attached') + ' · ' + studio.mode : 'studio not attached'); } catch {} }
tick(); probe(); setInterval(tick, 3000); setInterval(probe, 15000);
</script></body></html>`;

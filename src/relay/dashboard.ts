// GET /dashboard on the relay: a self-contained team usage page. The page holds
// no data; it asks for a member token (kept in sessionStorage for the tab) and
// reads the member-auth'd /api/v1/usage, the same summary `blox report` prints.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>blox team usage</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--bar:#16a34a;--warn:#d97706;--over:#dc2626;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--card:#292524}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
.meter{height:10px;background:var(--line);border-radius:5px;overflow:hidden;margin:8px 0}.meter>div{height:100%;background:var(--bar)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line)}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
input,select,button{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
form{display:flex;gap:8px;flex-wrap:wrap}input{flex:1;min-width:200px}.err{color:var(--over)}
</style></head><body><main>
<h1>Team usage</h1><p class="muted">From this blox relay's ledger. Costs are tokens priced at the relay's rates; every request is billed to the team key.</p>
<form id="f"><input id="tok" type="password" placeholder="member token (blx_…)" autocomplete="off">
<select id="win"><option value="">policy window</option><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="all">all time</option></select>
<button>Show</button></form>
<div id="out"></div>
</main><script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n) => '$' + Number(n).toFixed(2);
let token = ''; try { token = sessionStorage.getItem('bloxToken') || ''; } catch {}
$('tok').value = token;
function table(title, rows, unit) {
  return '<div class="card"><table><thead><tr><th>' + title + '</th><th class="n">Cost</th><th class="n">' + unit + '</th></tr></thead><tbody>' +
    (rows.length ? rows.map((b) => '<tr><td>' + esc(b.key) + '</td><td class="n">' + usd(b.costUsd) + '</td><td class="n">' + b.runs + '</td></tr>').join('') : '<tr><td colspan="3" class="muted">none</td></tr>') +
    '</tbody></table></div>';
}
async function load() {
  if (!token) { $('out').innerHTML = ''; return; }
  const w = $('win').value;
  const q = w === '' ? '' : w === 'all' ? '?since=all' : '?since=' + w + 'd';
  let res;
  try { res = await fetch('/api/v1/usage' + q, { headers: { 'x-api-key': token } }); }
  catch (e) { $('out').innerHTML = '<p class="err">relay unreachable</p>'; return; }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { $('out').innerHTML = '<p class="err">' + esc(body.error?.message || ('HTTP ' + res.status)) + '</p>'; return; }
  const s = body;
  const win = s.window.days != null ? 'last ' + s.window.days + ' days' : 'all time';
  const pct = s.capPct != null ? Math.round(s.capPct * 100) : null;
  const color = pct == null ? 'var(--bar)' : pct >= 100 ? 'var(--over)' : pct >= 80 ? 'var(--warn)' : 'var(--bar)';
  const unit = s.unit === 'requests' ? 'Requests' : 'Runs';
  $('out').innerHTML =
    '<div class="card"><div class="muted">' + win + '</div><div style="font-size:28px;font-weight:600">' + usd(s.totalUsd) +
    (s.capUsd != null ? ' <span class="muted" style="font-size:16px">of ' + usd(s.capUsd) + ' cap · ' + pct + '%</span>' : '') + '</div>' +
    (s.capUsd != null ? '<div class="meter"><div style="width:' + Math.min(100, pct) + '%;background:' + color + '"></div></div>' : '') +
    '<div class="muted">' + s.runCount + ' ' + unit.toLowerCase() + ', ' + s.errorCount + ' errors</div></div>' +
    table('Member', s.byUser, unit) + table('Model', s.byModel, unit);
}
$('f').addEventListener('submit', (e) => { e.preventDefault(); token = $('tok').value.trim(); try { sessionStorage.setItem('bloxToken', token); } catch {} load(); });
$('win').addEventListener('change', load);
load();
</script></body></html>`;

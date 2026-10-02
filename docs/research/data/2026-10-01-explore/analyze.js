const {bySort,games}=require('./games.json');
const now=new Date('2026-10-01');
const emojiRe=/\p{Extended_Pictographic}/u;
const emojiAll=/\p{Extended_Pictographic}/gu;
function feat(g){const t=g.name;const d=g.description||'';
 const words=t.replace(/\[[^\]]*\]/g,'').replace(/\p{Extended_Pictographic}|️/gu,'').split(/[\s|]+/).filter(w=>/\w/.test(w));
 return {t, len:t.length, words:words.length, emoji:emojiRe.test(t), bracket:/^\s*[\[(]/.test(t), upd:/\b(UPD|UPDATE|NEW|EVENT|RELEASE|SALE|x\d|2x|\d+x)\b/i.test(t), pipe:/\|/.test(t), num:/\d/.test(t.replace(/\[[^\]]*\]/g,'')), plus1:/\+\s?1/.test(t),
  verbA:/^(?:\W*\[[^\]]*\]\s*)?\W*(Steal|Grow|Ride|Build|Escape|Catch|Find|Be|Become|Hatch|Survive|Dig|Fish|Mine|Raise|Merge|Collect|Make|Break|Sell|Buy|Run|Jump|Climb|Pull|Carry|Feed|Cook|Drop|Spin|Roll|Throw|Eat|Rob|Defend|Hide|Kick|Punch|Lift|Train)\b/i.test(t),
  sim:/simulator|tycoon|obby|rng|incremental|idle|clicker/i.test(t), ageDays:(now-new Date(g.created))/864e5, updDays:(now-new Date(g.updated))/864e5,
  dlen:d.length, dlines:d.split('\n').filter(x=>x.trim()).length, demoji:(d.match(emojiAll)||[]).length,
  dLike:/\b(like|thumbs? ?up|favou?rite)\b/i.test(d), dGroup:/\b(group|join (our|the) (community|group)|community)\b/i.test(d), dCodes:/\bcodes?\b/i.test(d), dUpdate:/\bupdate|upd\b/i.test(d), dSocial:/discord|youtube|tiktok|twitter|\bx\.com|guilded|talk/i.test(d), dPremium:/premium|robux|gamepass|game pass|vip/i.test(d), dDisclaimer:/inspired by|not affiliated|credits?|thanks to/i.test(d)};}
function pct(arr,f){return Math.round(100*arr.filter(f).length/arr.length)+'%'}
function med(a){a=[...a].sort((x,y)=>x-y);return a[Math.floor(a.length/2)]}
const all=games.map(g=>({...g,...feat(g)}));
const seg={ all, topNow25: bySort['top-playing-now'].slice(0,25).map(x=>all.find(g=>g.universeId===x.universeId)), topNow:bySort['top-playing-now'].map(x=>all.find(g=>g.universeId===x.universeId)), trending:bySort['top-trending'].map(x=>all.find(g=>g.universeId===x.universeId)), upcoming:bySort['up-and-coming'].map(x=>all.find(g=>g.universeId===x.universeId)), revisited:bySort['top-revisited'].map(x=>all.find(g=>g.universeId===x.universeId)), friends:bySort['fun-with-friends'].map(x=>all.find(g=>g.universeId===x.universeId))};
console.log('segment n | medLen medWords | emoji bracket updTag pipe num verbA genreword | medAgeDays <90d <365d | updated<7d | dLen dEmoji like group codes update social');
for(const [k,a] of Object.entries(seg)){console.log(k,a.length,'|',med(a.map(x=>x.len)),med(a.map(x=>x.words)),'|',pct(a,x=>x.emoji),pct(a,x=>x.bracket),pct(a,x=>x.upd),pct(a,x=>x.pipe),pct(a,x=>x.num),pct(a,x=>x.verbA),pct(a,x=>x.sim),'|',Math.round(med(a.map(x=>x.ageDays))),pct(a,x=>x.ageDays<90),pct(a,x=>x.ageDays<365),'|',pct(a,x=>x.updDays<7),'|',med(a.map(x=>x.dlen)),med(a.map(x=>x.demoji)),pct(a,x=>x.dLike),pct(a,x=>x.dGroup),pct(a,x=>x.dCodes),pct(a,x=>x.dUpdate),pct(a,x=>x.dSocial))}
const gc={};for(const g of seg.topNow){gc[g.genre_l1||'?']=(gc[g.genre_l1||'?']||0)+1}console.log('topNow genre_l1',gc);
const gc2={};for(const g of seg.upcoming){gc2[g.genre_l1||'?']=(gc2[g.genre_l1||'?']||0)+1}console.log('upcoming genre_l1',gc2);
console.log('\nTOP PLAYING NOW 1-40');
for(const g of seg.topNow.slice(0,40)) console.log(String(g.playing).padStart(8),'|',g.name,'|',g.genre_l1,'/',g.genre_l2,'| created',g.created.slice(0,10),'| upd',g.updated.slice(0,10),'| visits',(g.visits/1e9).toFixed(2)+'B','| maxP',g.maxPlayers);
console.log('\nUP-AND-COMING');
for(const g of seg.upcoming) console.log(String(g.playing).padStart(8),'|',g.name,'|',g.genre_l1,'/',g.genre_l2,'| created',g.created.slice(0,10),'| maxP',g.maxPlayers);

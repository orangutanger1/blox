const fs=require('fs');
const j=require('./sorts.json');
const bySort={}; const uni=new Map();
for (const s of j.sorts){ if(!s.games) continue; bySort[s.sortId]=s.games.map((g,i)=>({rank:i+1,...g}));
  for(const g of s.games){ if(!uni.has(g.universeId)) uni.set(g.universeId,{...g,sorts:[]}); uni.get(g.universeId).sorts.push(s.sortId+'#'+(s.games.indexOf(g)+1)); } }
(async()=>{
 const ids=[...uni.keys()];
 for(let i=0;i<ids.length;i+=50){
   const r=await fetch('https://games.roblox.com/v1/games?universeIds='+ids.slice(i,i+50).join(','));
   const d=await r.json();
   for(const g of d.data||[]) Object.assign(uni.get(g.id),{description:g.description,created:g.created,updated:g.updated,visits:g.visits,maxPlayers:g.maxPlayers,genre:g.genre,genre_l1:g.genre_l1,genre_l2:g.genre_l2,favoritedCount:g.favoritedCount,creator:g.creator&&g.creator.name,creatorType:g.creator&&g.creator.type,playing:g.playing});
 }
 fs.writeFileSync('games.json',JSON.stringify({bySort,games:[...uni.values()]},null,1));
 console.log('games',uni.size, 'with desc', [...uni.values()].filter(g=>g.description!=null).length);
})();

// Poll the existing Registry publication; keep route, layout and pane positions.
(function registryLiveData(){
 if(location.protocol!=='http:'&&location.protocol!=='https:')return;
 let busy=false;
 async function refresh(){
  if(busy||document.hidden)return;
  const active=document.activeElement;
  if(active&&(/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)||active.isContentEditable))return;
  busy=true;
  try{
   const url=new URL(location.href);url.hash='';url.searchParams.set('_registry_refresh',String(Date.now()));
   const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!response.ok)return;
   const html=await response.text(),match=/const DATA = (.*?);\r?\n/.exec(html);if(!match)return;
   const next=JSON.parse(match[1]);if(JSON.stringify(DATA)===JSON.stringify(next))return;
   const panes=['tree','detail'].map(id=>[id,document.getElementById(id)?.scrollTop||0]);
   for(const key of Object.keys(DATA))delete DATA[key];Object.assign(DATA,next);render();
   for(const[id,top]of panes)document.getElementById(id)?.scrollTo(0,top);
  }catch{}finally{busy=false;}
 }
 setInterval(refresh,15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
})();

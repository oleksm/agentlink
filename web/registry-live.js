// Read canonical project data from the base runtime; no page snapshots or mirrored stores.
(function registryLiveData(){
 if(location.protocol!=='http:'&&location.protocol!=='https:')return;
 let busy=false,revision,etag;
 async function refresh(){
  if(busy||document.hidden)return;
  const active=document.activeElement;if(active&&(/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)||active.isContentEditable))return;
  busy=true;
  try{
   const response=await fetch('/api/registry-page',{cache:'no-store',headers:etag?{'If-None-Match':etag}:{},signal:AbortSignal.timeout(20000)});if(response.status===304||!response.ok)return;etag=response.headers.get("ETag");
   const next=await response.json();if(next.revision===revision)return;revision=next.revision;
   const panes=['tree','detail'].map(id=>[id,document.getElementById(id)?.scrollTop||0]);
   const registers=(next.registers||[]).filter(r=>r.root==='DevProjects');
   for(const r of(DATA.registers||[]).filter(r=>r.root==='DevProjects'))for(const row of r.records||[])delete DATA.key_pages?.[row.key||row.identity?.key];
   DATA.registers=[...(DATA.registers||[]).filter(r=>r.root!=='DevProjects'),...registers];DATA.roots??={};DATA.roots.DevProjects=next.roots?.DevProjects;DATA.register_groups??={};DATA.key_pages??={};
   for(const r of registers){if(next.register_groups?.[r.kind])DATA.register_groups[r.kind]=next.register_groups[r.kind];for(const row of r.records||[]){const k=row.key||row.identity?.key;if(next.key_pages[k])DATA.key_pages[k]=next.key_pages[k];}}
   for(const[k,v]of Object.entries(next))if(k.startsWith('project_')||k.startsWith('retrospective_'))DATA[k]=v;
   render();for(const[id,top]of panes)document.getElementById(id)?.scrollTo(0,top);
  }catch{}finally{busy=false;}
 }
 setInterval(refresh,15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
})();

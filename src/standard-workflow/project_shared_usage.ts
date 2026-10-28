import {existsSync,readFileSync,openSync,closeSync,readSync,fstatSync} from 'node:fs';
import {join} from 'node:path';
import {session_file} from './project_review_recovery.js';
import type {RecordData} from './common.js';
/** Shared-root usage joins workflow totals only for turns naming this project. */
export function sample_shared(rec:RecordData,home:string,state:RecordData,now:string):void {
 const configPath=join(home,'agents.json');if(!existsSync(configPath))return;
 const agents=JSON.parse(readFileSync(configPath,'utf8')),slug=rec.identity.key.replace(/^project\./,''),streams=(state.shared??={}),stages=(state.stages??={});
 const baseline=Object.values(stages).map((v:any)=>v.observed_at).filter(Boolean).sort().at(-1)||now;
 const stageAt=(at:string)=>(rec.status||[]).find((s:RecordData)=>s.timestamp<=at)?.workflow_step||'unattributed';
 for(const id of new Set<string>([rec.identity.submitted_by,rec.identity.manager||'project-manager'])){
  const a=agents[id];if(!a?.session)continue;const file=session_file(a.runtime,a.session);if(!file)continue;
  const q=streams[id]??={session:a.session,offset:0,seen:{},matched:false,pending:[],since:state.shared_since||baseline,previous:null};
  if(q.session!==a.session){q.session=a.session;q.offset=0;q.seen={};q.previous=null;q.pending=[];q.matched=false;q.since=now;}
  const flush=()=>{if(!q.matched)return;for(const x of q.pending){const t=stages[x.stage]??={input:0,output:0,cached_input:0,since:x.at,observed_at:now,partial:true};for(const k of ['input','output','cached_input'])t[k]+=x[k];t.observed_at=now;}q.pending=[];};
  const fd=openSync(file,'r');try{const size=fstatSync(fd).size;if(size<q.offset)continue;let offset=q.offset,pending=Buffer.alloc(0);while(offset<size){const buf=Buffer.alloc(Math.min(65536,size-offset)),n=readSync(fd,buf,0,buf.length,offset);if(!n)break;offset+=n;pending=Buffer.concat([pending,buf.subarray(0,n)]);let boundary;while((boundary=pending.indexOf(10))>=0){const bytes=pending.subarray(0,boundary),line=bytes.toString('utf8');pending=pending.subarray(boundary+1);q.offset+=bytes.length+1;let row;try{row=JSON.parse(line);}catch{continue;}
   const human=a.runtime==='codex'?row.type==='event_msg'&&row.payload?.type==='task_started':row.type==='user'&&(typeof row.message?.content==='string'||row.message?.content?.some((c:RecordData)=>c.type==='text'));
   if(human){flush();q.pending=[];q.matched=false;}
   if(['user','assistant','response_item'].includes(row.type)&&line.includes(slug))q.matched=true;
   let c:RecordData|undefined,b:RecordData|undefined;
   if(a.runtime==='claude'&&row.type==='assistant'&&row.message?.usage){const u=row.message.usage,key=row.message.id||row.uuid;c={input:(u.input_tokens||0)+(u.cache_creation_input_tokens||0)+(u.cache_read_input_tokens||0),output:u.output_tokens||0,cached_input:u.cache_read_input_tokens||0};b=q.seen[key]||{input:0,output:0,cached_input:0};for(const k of Object.keys(c))c[k]=Math.max(c[k],b![k]);q.seen[key]=c;}
   if(a.runtime==='codex'&&row.type==='event_msg'&&row.payload?.type==='token_count'&&row.payload.info?.total_token_usage){const u=row.payload.info.total_token_usage;c={input:u.input_tokens||0,output:u.output_tokens||0,cached_input:u.cached_input_tokens||0};b=q.previous||c;q.previous=c;}
   if(c&&b&&row.timestamp>q.since){const x={input:Math.max(0,c.input-b.input),output:Math.max(0,c.output-b.output),cached_input:Math.max(0,c.cached_input-b.cached_input),stage:stageAt(row.timestamp),at:row.timestamp};q.pending.push(x);}flush();
  }} }finally{closeSync(fd);}
 }
}

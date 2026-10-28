import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {nativeRegistryCli} from './native_registry.js';
import {network_cli} from './native_network.js';
import {snapshot as ownerSnapshot} from './project_owner_actions.js';
import {probe_cli} from './native_probe.js';
import {Agentmsg,agentmsg_cli,parse as mailArgs} from './agentmsg.js';
import {NativeTransport} from './agentmsg_transport.js';
import {make_native_ports} from './native_ports.js';
import {startService} from '../daemon.js';
import {parseArgs} from 'node:util';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
import {Store} from '../store.js';
import {Records,locked,validate_record} from './records.js';
import {configureNativeWorkspace,publishNativePages} from './platform.js';
import {Workers} from './workers.js';
import * as work from './project_work.js';
import * as flow from './workflow.js';
import * as intakes from './intakes.js';
import * as projects from './projects.js';
import {assign} from './project_ids.js';
import {bind_worker} from './native_identity.js';
import {join} from 'node:path';

export async function nativeCli(store:Store,args:string[],actor?:string):Promise<{handled:boolean;value?:unknown;output?:string;exitCode?:number}>{
 const [command,action,id]=args,records=new Records(store.home);
 const own=()=>{const name=actor||process.env.AGL_AGENT;if(!name)throw Error('--as ACTOR is required');return name;};
 const manager=()=>{const name=own();if(name!=='project-manager' || !new Agentmsg(store.home).conf()[name] || new Agentmsg(store.home).aliases()[name])throw Error('Project manager identity required');return name;};
 const key=(value:string|undefined,kind='project')=>{if(!value)throw Error('Record ID required');return value.startsWith(kind+'.')?value:kind+'.'+value;};
 const options=(argv:string[])=>parseArgs({args:argv,allowPositionals:true,options:{file:{type:'string'},check:{type:'boolean'},all:{type:'boolean'},product:{type:'string'},name:{type:'string'},session:{type:'string'},'stall-minutes':{type:'string'}}});
 const success=(value:unknown)=>({handled:true,value});
 if(command==='actions'){if(action==='show'){if(!id)throw Error('Project ID required');return success(ownerSnapshot(records.read(key(id))));}return success(records.list('project').map(rec=>({project:rec.identity.key,...ownerSnapshot(rec)})));}
 if(command==='msg'){
  const networkResult=await network_cli(store.home,args.slice(1),actor);if(networkResult)return {handled:true,...networkResult};
  const probeResult=probe_cli(store.home,args.slice(1),actor);if(probeResult)return {handled:true,...probeResult};
  const log:string[]=[],transport=new NativeTransport(store.home,text=>log.push(text)),runtime=make_native_ports(store.home),argv=args.slice(2),separator=argv.indexOf('--'),[pos,opt]=mailArgs(separator<0?argv:argv.slice(0,separator));if(actor)opt.as=actor;
  if(action==='deliver'){if(!pos[0])throw Error('Recipient required');transport.deliver(pos[0],Number(opt.delay??12));return{handled:true,output:log.join('\n'),exitCode:0};}
  if(action==='up'){await startService(store);transport.up(pos,opt);return{handled:true,output:log.join('\n'),exitCode:0};}
  if(action==='term'){transport.term(pos,opt,separator<0?undefined:argv.slice(separator+1));return{handled:true,output:log.join('\n'),exitCode:0};}
  if(action==='hook-claude'){let data={};try{data=JSON.parse(readFileSync(0,'utf8'));}catch{}const result=transport.hook_claude(data,opt);return{handled:true,output:result?JSON.stringify(result):'',exitCode:0};}
  if(action==='serve'){const controller=new AbortController();process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());await transport.serve(controller.signal);return{handled:true,output:log.join('\n'),exitCode:0};}
  const result=await agentmsg_cli(store.home,args.slice(1),actor,{tmux_alive:name=>transport.tmux_alive(name),running:name=>transport.running(name),usage:(kind,session)=>{const file=kind&&session?runtime.session_file(kind,session):null;return file?runtime.usage(kind!,file):{};}});
  return{handled:true,...result};
 }
 if(command==='work'){const lines:string[]=[];configureNativeWorkspace(store,own(),text=>lines.push(text));await work.execute(work.parse_args(args.slice(1)),store.home);return {handled:true,output:lines.join('\n'),exitCode:0};}
 if(command==='workers'){
  const {values:v,positionals:p}=options(args.slice(2)),project=p[0];if(!project)throw Error('Project ID required');configureNativeWorkspace(store,own());
  if(action==='bind'){if(!p[1])throw Error('Worker identity required');return success(bind_worker(store,project,p[1],own(),v.session));}
  if(action!=='status')manager();
  
  const result=locked(join(store.home,'projects',project,'workers.lock'),()=>{const workers=new Workers(project,store.home,store.home);
   switch(action){case'status':return workers.status();case'workspace':if(!p[1])throw Error('Product required');return workers.workspace(p[1]);case'init':if(!p[1]||!v.product)throw Error('Source and --product required');return workers.init(p[1],v.product,v.name);case'start':case'verify':case'resume':if(!p[1])throw Error('Worker required');return action==='start'?workers.start(p[1]):action==='verify'?workers.verify(p[1]):workers.resume_missing(p[1]);default:throw Error('Workers: workspace, init, start, verify, resume, bind, status');}
  });return success(result);
 }
 if(command==='workflow'){
  manager();configureNativeWorkspace(store,own());const {values:v,positionals:p}=options(args.slice(2));
  if(action==='enable'){const project=p[0];if(!project)throw Error('Project required');const rec=records.read(key(project)),intake=records.read(rec.intake);if(!intake.authorization?.request?.trim())throw Error('The intake must record the direct human project request before execution');flow.enable(store.home,project);return success({enabled:project});}
  if(action==='disable'){if(!p[0])throw Error('Project required');flow.disable(store.home,p[0]);return success({disabled:p[0]});}
  if(action==='tick'){const errors=await flow.tick_projects(store.home,store.home,{project:p[0],all:v.all,stall_minutes:v['stall-minutes']?Number(v['stall-minutes']):undefined},()=>publishNativePages(store));return success({ok:!errors.length,errors});}
  throw Error('Workflow: enable PROJECT, disable PROJECT, tick PROJECT|--all');
 }
 if(command==='submit-intake'||command==='project'&&action==='submit'){
  const {values:v,positionals:p}=options(args.slice(command==='project'?2:1)),file=v.file||p[0];if(!file)throw Error('--file draft.yaml required');const lines:string[]=[];configureNativeWorkspace(store,own(),text=>lines.push(text));intakes.submit(store.home,file,Boolean(v.check));return {handled:true,output:lines.join('\n'),exitCode:0};
 }
 if(command==='project'){
  if(action==='list')return success(records.list('project'));
  if(action==='show')return success(records.read(key(id)));
  if(action==='check'){const values=id?[records.read(key(id))]:records.list(),errors=values.flatMap(r=>{try{validate_record(r,store.home);return projects.check_record(r).map(error=>({key:r.identity?.key,error}));}catch(error){return [{key:r.identity?.key,error:(error as Error).message}];}});return success({valid:!errors.length,checked:values.length,errors});}
  if(action==='import'||action==='create'){
   const {values:v}=options(args.slice(2));if(!v.file)throw Error('--file original-record.yaml required');const record=parse(readFileSync(v.file,'utf8'),{maxAliasCount:10000});own();
   if(action==='create'){manager();if(!record.identity?.key?.startsWith('project.'))throw Error('Project record required');const intake=records.read(record.intake);if(!intake.authorization?.request?.trim())throw Error('The intake must record the direct human project request');assign(record,store.home);}
   validate_record(record,store.home);const result=records.import(record);publishNativePages(store);return success(result);
  }
  throw Error('Project commands use the standard schemas: submit, create, import, list, show, check. Execution commands: agentlink work.');
 }
 if(command==='registry'){
  if(action==='mail')return {handled:true,...await agentmsg_cli(store.home,['inbox'],'registry')};
  if(action==='page'){publishNativePages(store);const scoped=id&&/^(root:DevProjects|rg:(projects|intakes)|x:(projects|intakes):)/.test(id),url=pathToFileURL(join(store.home,'registry',scoped?'DevProjects/index.html':'index.html'));if(id)url.hash=id;await new Promise<void>((resolve,reject)=>{const child=spawn('xdg-open',[url.href],{stdio:'ignore',detached:true});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});return success({page:url.href});}
  if(['new','set','put','own'].includes(action||''))own();const page=action==='check'&&args.includes('--page'),value=nativeRegistryCli(store.home,args.slice(1).filter(a=>a!=='--page'));if(page||['new','set','put'].includes(action||''))publishNativePages(store);return typeof value==='string'?{handled:true,output:value,exitCode:0}:success(value);
 }
 if(['worker','lifecycle','coverage','integration','ownership','retrospective','owner'].includes(command||''))throw Error('Use the native workflow commands: agentlink work, agentlink workers, agentlink workflow. Project records must follow the installation’s canonical schemas.');
 return{handled:false};
}

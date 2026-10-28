import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {Records,atomic} from './records.js';
import {json_sorted,sha256,type RecordData} from './common.js';
import * as review from './project_review.js';
export const digest=(value:any)=>sha256(json_sorted(value));
export function pending(rec:RecordData){const rows:RecordData[]=[];for(const d of rec.decisions||[])if(d.status==='open'&&d.owner?.toLowerCase()==='owner')rows.push({id:d.id,kind:'decision',title:d.question,context:d.outcome||'',revision:digest(d)});const holds=rec.logistics?.owner_holds||[],contract=holds.length?review.snapshot(rec):'';for(const hold of holds)rows.push({id:'hold-'+digest(hold).slice(0,16),kind:'hold',title:hold,context:'Approval releases this exact owner hold only. Independent acceptance and integration checks remain.',revision:digest([hold,contract])});return rows;}
export function snapshot(rec:RecordData){return{actions:pending(rec),history:[...(rec.events||[])].reverse().filter(e=>e.id.startsWith('owner-ui-')).slice(0,20).map(e=>({id:e.id,at:e.at,detail:e.detail}))};}
export function submit(slug:string,payload:RecordData,home:string){if(!/^[a-z][a-z0-9-]{0,62}$/.test(slug))throw Error('Invalid project');const ident=payload.request_id||'';if(!/^[a-f0-9-]{32,36}$/.test(ident))throw Error('Invalid request ID');const choice=payload.choice;if(!['approve','reject','direction'].includes(choice))throw Error('Choose approve, reject or direction');const detail=payload.detail||'';if(typeof detail!=='string'||detail.length>8000)throw Error('Direction must be text, at most 8000 characters');if(['reject','direction'].includes(choice)&&!detail.trim())throw Error('Provide a reason or direction');
 return new Records(home).update('project.'+slug,rec=>{const eid='owner-ui-'+ident;if(rec.events.some((e:RecordData)=>e.id===eid))return snapshot(rec);let action:RecordData|undefined;
  if(choice!=='direction'){action=pending(rec).find(a=>a.id===payload.target);if(!action||action.revision!==payload.revision)throw Error('This action changed or was already resolved. Refresh and review it again.');}
  const at=new Date().toISOString(),title=action?.title||'Project direction',description=`Owner ${choice}: ${title}`+(detail.trim()?' — '+detail.trim():''),record=join(home,'projects',slug,'owner-actions',ident+'.json');
  atomic(record,JSON.stringify({project:rec.identity.key,actor:'owner',at,action:action||null,choice,detail},null,2));const proof='owner-evidence-'+ident;
  rec.evidence.push({id:proof,kind:'decision',location:record,description,recorded_by:'owner',at,sha256:sha256(readFileSync(record))});
  if(action?.kind==='decision'){const d=rec.decisions.find((d:RecordData)=>d.id===action!.id);d.status='decided';d.outcome=description+'\nPrior proposal: '+(d.outcome||'');(d.evidence??=[]).push(proof);}
  else{rec.decisions.push({id:eid,question:title,status:'decided',owner:'owner',outcome:description,evidence:[proof]});if(action&&choice==='approve')rec.logistics.owner_holds.splice(rec.logistics.owner_holds.indexOf(action.title),1);}
  rec.events.push({id:eid,at,actor:'owner',kind:'decision',detail:description,evidence:[proof]});return snapshot(rec);
 });
}

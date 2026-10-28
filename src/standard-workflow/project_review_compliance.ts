import {configured,reason,time_remaining} from './project_budgets.js';
import {json_sorted,sha256,type RecordData} from './common.js';
import * as token_budget from './project_token_budget.js';
export function policy(rec:RecordData,c:RecordData){return{configuration:rec.configuration||{},max_action_seconds:Math.min(240,Number(c.experiment_budget_minutes??4)*60,configured(rec,"time_budget_per_turn")),owner_holds:rec.logistics?.owner_holds||[],prohibited_actions:rec.logistics?.prohibited_actions||[],goal:rec.goal||'',exit_criteria:rec.logic?.exit_criteria||'',constraints:rec.logistics?.resources||[],criterion:c.observable_pass_condition||''};}
export const fingerprint=(rec:RecordData,c:RecordData)=>sha256(json_sorted(policy(rec,c)));
export function template(rec:RecordData,c:RecordData){return{constraints_sha256:fingerprint(rec,c),requirement_changes:[],finish_condition:'',total_expected_seconds:0,estimated_remaining_tokens:0,actions:[{kind:(c.token_review?.threshold||0)>=token_budget.limit(c,rec)?'verify':'implement',instruction:'',expected_seconds:0,timeout_seconds:policy(rec,c).max_action_seconds,on_timeout:''}]};}
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:RecordData,names:string[])=>Object.keys(v).sort().join() === [...names].sort().join();
export function errors(rec:RecordData,c:RecordData,report:RecordData){const problems:string[]=[],value=report.compliance;
 if(!object(value)||!keys(value,['constraints_sha256','actions','requirement_changes','finish_condition','total_expected_seconds','estimated_remaining_tokens']))return['compliance: use work token-review-template; declare current constraints and bounded actions'];
 if(value.constraints_sha256!==fingerprint(rec,c))problems.push('compliance: constraints changed; regenerate the template and revise guidance');
 const changes=value.requirement_changes;
 if(!Array.isArray(changes)||changes.some(x=>typeof x!=='string'||!x.trim()))problems.push('compliance.requirement_changes: list the exact requirements changed, or []');
 if(changes?.length&&report.decision!=='hold')problems.push('compliance: changed requirements require hold and formal gate/scope disposition before resume');
 if(changes?.length&&!(report.gate_update||report.scope_correction?.changes_project_goal))problems.push('compliance: declared changes need gate_update or changes_project_goal scope_correction');
 if(typeof value.finish_condition!=='string'||!value.finish_condition.trim())problems.push('compliance.finish_condition: name the finite end of the remaining plan');
 const estimate=value.estimated_remaining_tokens;
 if(!Number.isInteger(estimate)||estimate<0||(report.decision==='resume'&&estimate===0))problems.push('compliance.estimated_remaining_tokens: supply a positive resume estimate');
 const u=c.token_usage||{},threshold=Math.max(report.threshold||0,Math.max(0,(u.input||0)-(u.cached_input||0))+(u.output||0));
 if(token_budget.warning(rec)<=threshold&&threshold<token_budget.limit(c,rec)&&Number.isInteger(estimate)&&estimate>token_budget.limit(c,rec)-threshold)problems.push('compliance: remaining work estimate exceeds token budget; reduce work or hold');
 if(report.decision==='resume'&&value.total_expected_seconds>time_remaining(rec,c))problems.push('compliance: plan exceeds remaining project or AC time budget');
 const actions=value.actions;if(!Array.isArray(actions))return[...problems,'compliance.actions: expected a list'];
 if(report.decision==='resume'&&!actions.length)problems.push('compliance.actions: resume requires at least one bounded action (including publication)');
 const limit=policy(rec,c).max_action_seconds;
 for(const[i,a]of actions.entries()){const at=`compliance.actions[${i}]`;
  if(!object(a)||!keys(a,['kind','instruction','expected_seconds','timeout_seconds','on_timeout'])){problems.push(at+': require kind, instruction, expected_seconds, timeout_seconds, on_timeout');continue;}
  if(!['implement','verify','publish','coordinate'].includes(a.kind))problems.push(at+': kind must be implement, verify, publish or coordinate');
  if((threshold>=token_budget.limit(c,rec)||reason(rec,c))&&a.kind==='implement')problems.push(at+': token limit reached; implementation is forbidden, wrap up existing work');
  if(/continue.*(?:next|each) (?:block|batch)|repeat until|retry until/i.test(String(a.on_timeout||'')))problems.push(at+': timeout cannot authorize an unbounded continuation; checkpoint and stop');
  for(const k of ['instruction','on_timeout'])if(typeof a[k]!=='string'||!a[k].trim())problems.push(at+'.'+k+': state concrete work or checkpoint/scope-reduction fallback');
  if(!Number.isInteger(a.expected_seconds)||!Number.isInteger(a.timeout_seconds)||!(0<a.expected_seconds&&a.expected_seconds<=a.timeout_seconds&&a.timeout_seconds<=limit))problems.push(at+`: require 0 < expected_seconds <= timeout_seconds <= ${limit}; shrink the sample or use incremental work`);
 }
 const total=actions.reduce((sum,a)=>sum+(object(a)&&Number.isInteger(a.expected_seconds)?a.expected_seconds:0),0);
 if(!Number.isInteger(value.total_expected_seconds)||value.total_expected_seconds!==total)problems.push('compliance.total_expected_seconds: must equal the sum of all listed actions; list each bounded batch separately');
 const scope=report.scope_correction||{},texts=[report.direction||'',scope.reduced_task||'',scope.finish_condition||'',...actions.filter(object).map(a=>a.instruction||'')];
 for(const text of texts){if(typeof text!=='string')continue;
  for(const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:[-–]\s*(\d+(?:\.\d+)?)\s*)?(seconds?|secs?|s|minutes?|mins?|min|hours?|hrs?|h)\b/gi)){const amount=Math.max(Number(m[1]),Number(m[2]||m[1])),unit=m[3]!.toLowerCase(),seconds=amount*(unit.startsWith('h')?3600:unit.startsWith('m')?60:1);if(seconds>limit)problems.push(`direction: ${m[0]} exceeds ${limit}s; replace with a compliant bounded action`);}
  if(/\b(?:uninterruptible|unbounded|no timeout|without (?:a )?(?:timeout|time limit)|ignore (?:the )?(?:budget|timeout))\b/i.test(text))problems.push('direction: unbounded/budget-bypassing execution is not allowed, including final builds');
 }return[...new Set(problems)];
}

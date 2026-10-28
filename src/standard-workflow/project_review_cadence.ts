import type {RecordData} from './common.js';
import * as token_budget from './project_token_budget.js';
export const RESULT_REVIEW='Open the actual result. For visual work, put its frame beside the reference at the same camera and scale. Name what is wrong and where; passing numbers do not excuse a broken picture. Ask for missing output. Choose the next small test from what failed. Do not interrupt a running test.';
export const FIELDS=['retained_artifacts','dropped_work','reduced_task','reduced_project','finish_condition'];
export function next_sequence(rec:RecordData,cid:string,previous:RecordData){if(previous.sequence)return previous.sequence+1;return(rec.events||[]).filter((e:RecordData)=>e.criterion===cid&&['safe pause and source-root review required.','safe pause and requestor-root review required.'].some(t=>(e.detail||'').includes(t))).length+1;}
export const required=(review:RecordData)=>review.course_correction||false;
export function template(review:RecordData,warningAt=token_budget.WARNING,ceiling=review.limit??token_budget.LIMIT){return {...(required(review)?{scope_correction:{...Object.fromEntries(FIELDS.map(k=>[k,''])),changes_project_goal:false}}:{}),...token_budget.template(review,warningAt,ceiling)};}
export function validate(review:RecordData,report:RecordData){if(!required(review)&&report.scope_correction==null)return;const value=report.scope_correction;
 if(!value||Array.isArray(value)||Object.keys(value).sort().join()!==[...FIELDS,'changes_project_goal'].sort().join())throw Error('third review requires scope_correction: retained_artifacts, dropped_work, reduced_task, reduced_project, finish_condition, changes_project_goal');
 for(const key of FIELDS)if(typeof value[key]!=='string'||!value[key].trim())throw Error('scope_correction requires concrete '+key);
 if(typeof value.changes_project_goal!=='boolean')throw Error('changes_project_goal must be boolean');
 if(value.changes_project_goal&&(report.decision!=='hold'||report.release_after||report.release_requests))throw Error('changed project goal requires hold for recorded owner scope decision; no automatic release');
}
export const QUESTION='Reduce the task to a finishable outcome. Name retained artifacts, dropped work and a concrete finish condition, grounded in failed attempts. Apply goal-preserving gate corrections through gate_update. A changed goal requires a recorded scope decision and hold; retain the original failures.';

import {readFileSync,statSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {parse} from 'yaml';
import {Ajv} from 'ajv';
import addFormats from 'ajv-formats';
const names:Record<string,string>={root:'root.schema.yaml',project:'DevProjects/schema/project.schema.yaml',intake:'DevProjects/schema/intake.schema.yaml',retrospective:'DevProjects/schema/retrospective.schema.yaml'};
const cache=new Map<string,{ajv:Ajv;files:Map<string,string>}>();
const stamp=(p:string)=>{const s=statSync(p);return `${s.mtimeMs}:${s.size}:${realpathSync(p)}`;};
function validator(home:string,kind:string){
 if(!home)throw Error('Explicit workspace is required for canonical schema validation');
 const relative=names[kind];if(!relative)throw Error('Unknown standard schema: '+kind);
 const file=resolve(home,'registry',relative),key=pathToFileURL(file).href;
 let entry=cache.get(key);
 if(!entry||[...entry.files].some(([p,v])=>stamp(p)!==v)){
  const ajv=new Ajv({strict:false,allErrors:true});(addFormats as unknown as (a:Ajv)=>void)(ajv);
  const files=new Map<string,string>(),seen=new Set<string>();
  const load=(p:string)=>{p=resolve(p);if(seen.has(p))return;seen.add(p);const schema=parse(readFileSync(p,'utf8'),{maxAliasCount:10000});files.set(p,stamp(p));const refs=new Set<string>();
   const visit=(v:any)=>{if(!v||typeof v!=='object')return;if(typeof v.$ref==='string'&&!v.$ref.startsWith('#'))refs.add(v.$ref.split('#')[0]);for(const x of Object.values(v))visit(x);};visit(schema);
   for(const ref of refs){if(/^[a-z]+:/i.test(ref)) {if(!ref.startsWith('file:'))throw Error('Schema references must be local: '+ref);load(fileURLToPath(ref));}else load(resolve(dirname(p),ref));}
   ajv.addSchema(schema,pathToFileURL(p).href);
  };load(file);entry={ajv,files};cache.set(key,entry);
 }
 return {ajv:entry.ajv,key};
}
export function validateStandardRecord(kind:string,value:unknown,home:string):string[]{const {ajv,key}=validator(home,kind),validate=ajv.getSchema(key)!;return validate(value)?[]:(validate.errors||[]).map(e=>`${e.instancePath||'/'} ${e.message}`);}
export function validateStandardPart(kind:string,property:string,value:unknown,home:string):string[]{const {ajv,key}=validator(home,kind),pointer=property.split('.').map(x=>'properties/'+x.replaceAll('~','~0').replaceAll('/','~1')).join('/'),validate=ajv.getSchema(key+'#/'+pointer);if(!validate)throw Error('Unknown standard schema property: '+property);return validate(value)?[]:(validate.errors||[]).map(e=>`${e.instancePath||'/'} ${e.message}`);}

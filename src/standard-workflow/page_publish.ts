import {existsSync,readFileSync,realpathSync,statSync,chmodSync} from 'node:fs';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Store} from '../store.js';
import {registryPageData,renderRegistryPage} from '../registry-page.js';
import {atomic,locked} from './records.js';
const self=fileURLToPath(import.meta.url);
export const redirect='<!doctype html><html><head><meta charset="utf-8"><title>Projects — Registry</title><script>location.replace("../index.html"+(location.hash||"#rg:projects"));</script></head><body><a href="../index.html#rg:projects">Open Projects in Registry</a></body></html>\n';
function write(path:string,text:string){const mode=existsSync(path)?statSync(path).mode&0o777:0o644;atomic(path,text);chmodSync(path,mode);}
export function publish(home:string){
 const config=join(home,'registry-publication.json');
 if(existsSync(config)){const spec=JSON.parse(readFileSync(config,'utf8'));if(typeof spec.root!=='string'||typeof spec.page!=='string')throw Error('registry-publication.json requires root and page');const root=realpathSync(resolve(spec.root)),page=resolve(root,spec.page),rel=relative(root,page);if(isAbsolute(rel)||rel==='..'||rel.startsWith('../'))throw Error('Publication page must be within root');const lock=join('/tmp','pages-'+process.getuid!()+'-'+createHash('sha256').update(root).digest('hex').slice(0,24)+'.lock');execFileSync('flock',['-x',lock,process.execPath,self,home,page],{stdio:['ignore','pipe','pipe']});return;}
 locked(join(home,'registry/.publication'),()=>{const store=new Store(home),{html}=renderRegistryPage(store);write(join(home,'registry/index.html'),html);write(join(home,'registry/DevProjects/index.html'),redirect);});
}
// Read the latest domain page only after acquiring its existing publication lock.
if(process.argv[1]&&resolve(process.argv[1])===self){const home=process.argv[2]!,page=process.argv[3]!,text=readFileSync(page,'utf8'),match=/const DATA = (.*?);\r?\n/.exec(text);if(!match)throw Error('Shared registry page has no DATA payload');const old=JSON.parse(match[1]!),next=registryPageData(new Store(home)),registers=(next.registers||[]).filter((r:any)=>r.root==='DevProjects');const prior=(old.registers||[]).filter((r:any)=>r.root==='DevProjects');for(const r of prior)for(const row of r.records||[])delete old.key_pages?.[row.key||row.identity?.key];old.registers=[...(old.registers||[]).filter((r:any)=>r.root!=='DevProjects'),...registers];old.roots??={};if(next.roots?.DevProjects)old.roots.DevProjects=next.roots.DevProjects;old.register_groups??={};for(const r of registers)if(next.register_groups?.[r.kind])old.register_groups[r.kind]=next.register_groups[r.kind];old.key_pages??={};for(const r of registers)for(const row of r.records||[]){const key=row.key||row.identity?.key;if(next.key_pages[key])old.key_pages[key]=next.key_pages[key];}for(const [key,value]of Object.entries(next))if(key.startsWith('project_')||key.startsWith('retrospective_'))old[key]=value;let html=text.replace(match[0],()=> 'const DATA = '+JSON.stringify(old).replace(/</g,'\\u003c')+';\n');const live=readFileSync(new URL('../../web/registry-live.js',import.meta.url),'utf8');html=html.replace(/<!-- AGENTLINK_LIVE_START -->[\s\S]*?<!-- AGENTLINK_LIVE_END -->/g,'');html=html.replace('</body>','<!-- AGENTLINK_LIVE_START --><script>'+live+'</script><!-- AGENTLINK_LIVE_END --></body>');write(page,html);write(join(dirname(page),'DevProjects/index.html'),redirect);}

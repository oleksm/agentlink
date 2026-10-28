import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {Store} from '../store.js';
import {registryPageData,renderRegistryPage} from '../registry-page.js';
/** Publication configuration points to the original Registry; never creates a second store or page. */
export function publication(home:string):{page:string;directory:string;url?:string}|null {
 const p=join(home,'registry-publication.json');if(!existsSync(p))return null;
 const spec=JSON.parse(readFileSync(p,'utf8'));if(typeof spec.root!=='string'||typeof spec.page!=='string')throw Error('registry-publication.json requires root and page');
 const root=realpathSync(resolve(spec.root)),page=realpathSync(resolve(root,spec.page)),rel=relative(root,page);if(isAbsolute(rel)||rel==='..'||rel.startsWith('../'))throw Error('Registry page must be within configured root');
 return {page,directory:dirname(page),...(spec.url?{url:spec.url}:{})};
}
export function publicationUrl(store:Store):URL {const spec=publication(store.home);if(spec?.url)return new URL(spec.url);const port=store.config().port;if(port)return new URL(`http://127.0.0.1:${port}/`);if(spec)return pathToFileURL(spec.page);throw Error('Configure the Registry URL before opening it');}
/** Canonical data is rendered on request, so workflow writes require no page-copy synchronization. */
export function publish(_home:string):void {}
export function renderPublication(store:Store):{html:string;nonce:string} {
 const spec=publication(store.home);if(!spec)return renderRegistryPage(store);
 const text=readFileSync(spec.page,'utf8'),match=/const DATA = (.*?);\r?\n/.exec(text);if(!match)throw Error('Registry page has no DATA payload');
 const data=JSON.parse(match[1]!),next=registryPageData(store),registers=(next.registers||[]).filter((r:any)=>r.root==='DevProjects');
 for(const r of(data.registers||[]).filter((r:any)=>r.root==='DevProjects'))for(const row of r.records||[])delete data.key_pages?.[row.key||row.identity?.key];
 data.registers=[...(data.registers||[]).filter((r:any)=>r.root!=='DevProjects'),...registers];data.roots??={};data.roots.DevProjects=next.roots?.DevProjects;data.register_groups??={};data.key_pages??={};
 for(const r of registers){if(next.register_groups?.[r.kind])data.register_groups[r.kind]=next.register_groups[r.kind];for(const row of r.records||[]){const k=row.key||row.identity?.key;if(next.key_pages[k])data.key_pages[k]=next.key_pages[k];}}
 for(const[k,v]of Object.entries(next))if(k.startsWith('project_')||k.startsWith('retrospective_'))data[k]=v;
 let html=text.replace(match[0],()=> 'const DATA = '+JSON.stringify(data).replace(/</g,'\\u003c')+';\n').replace(/<!-- AGENTLINK_LIVE_START -->[\s\S]*?<!-- AGENTLINK_LIVE_END -->/g,'');
 const nonce=randomBytes(18).toString('base64');html=html.replace(/<script\b([^>]*)>/g,(_m,attrs:string)=>'<script'+attrs.replace(/\snonce=("[^"]*"|'[^']*')/g,'')+' nonce="'+nonce+'">');html=html.replace('</body>','<script src="/api/dev-projects.js" nonce="'+nonce+'"></script></body>');return {html,nonce};
}

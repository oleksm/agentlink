import {Store} from '../store.js';
import {Agentmsg} from './agentmsg.js';
import {publish} from './page_publish.js';
import {configure_runtime_ports} from './project_runtime_ports.js';
import {make_native_ports} from './native_ports.js';
import {configure_work_ports} from './project_work.js';
import {configure_intake_ports} from './intakes.js';
import {archive_completed} from './projects.js';

export function publishNativePages(store:Store){publish(store.home);}
/** Wire native operating-system/messaging services; project objects are never translated. */
export function configureNativeWorkspace(store:Store,actor?:string,output:(value:string)=>void=()=>{}){
 const caller=()=>{const name=actor||process.env.AGL_AGENT;if(!name)throw Error('--as ACTOR is required');return name;};
 configure_runtime_ports(make_native_ports(store.home));
 configure_work_ports({home:store.home,caller,send:(from,to,summary,key,see)=>new Agentmsg(store.home).send([to,'task'],{as:from,summary,ref:key,see}).id,request_pages:()=>publishNativePages(store),refresh_pages:()=>publishNativePages(store),archive_completed,output});
 configure_intake_ports({home:store.home,caller,send:(from,key,destination,summary)=>new Agentmsg(store.home).send(['project-manager','task'],{as:from,summary,ref:key,see:[destination]}).id,refresh_pages:()=>publishNativePages(store),output});
}

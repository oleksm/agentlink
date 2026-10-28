import type {Store} from './store.js';
import {nativeRegistryCli} from './standard-workflow/native_registry.js';
export function runRegistryCommand(store:Store,args:string[],actor?:string):unknown {
 if(['new','set','put','own'].includes(args[0]||'')&&!actor)throw Error('--as ACTOR is required');
 return nativeRegistryCli(store.home,args);
}

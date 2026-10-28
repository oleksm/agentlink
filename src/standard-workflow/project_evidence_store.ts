import {openSync,closeSync,readSync,writeSync,mkdirSync,chmodSync,renameSync,existsSync,readFileSync,unlinkSync} from 'node:fs';
import {join,extname} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {sha256,type RecordData} from './common.js';
export function snapshot(source:string,directory:string):[string,string]{
 mkdirSync(directory,{recursive:true});const name=join(directory,'.copy-'+randomUUID());let output:number|undefined,input:number|undefined;
 try{output=openSync(name,'wx',0o600);input=openSync(source,'r');const digest=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let n;
  while((n=readSync(input,buffer,0,buffer.length,null))>0){digest.update(buffer.subarray(0,n));let offset=0;while(offset<n)offset+=writeSync(output,buffer,offset,n-offset);}
  closeSync(input);input=undefined;closeSync(output);output=undefined;
  const sha=digest.digest('hex'),dest=join(directory,sha+extname(source));
  if(existsSync(dest)){if(sha256(readFileSync(dest))!==sha)throw Error('published evidence snapshot was modified: '+dest);}
  else{chmodSync(name,0o444);renameSync(name,dest);}return[dest,sha];
 }finally{if(input!==undefined)closeSync(input);if(output!==undefined)closeSync(output);if(existsSync(name))unlinkSync(name);}
}
export function folder(rec:RecordData,home=process.env.AGL_HOME||join(homedir(),'.local/share/agenlink')){return join(home,'projects',rec.identity.key.replace(/^project\./,''),'evidence','published');}

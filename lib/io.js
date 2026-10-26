import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(typeof s==='string'?s:JSON.stringify(s)).digest('hex');
export const TERMINAL = new Set(['complete','partial','failed','cancelled','blocked','interrupted']);
export const sleep = (ms,signal) => new Promise((resolve,reject)=>{if(signal?.aborted)return reject(signal.reason??new Error('ABORTED'));const t=setTimeout(done,ms);const abort=()=>{clearTimeout(t);signal?.removeEventListener('abort',abort);reject(signal.reason??new Error('ABORTED'))};function done(){signal?.removeEventListener('abort',abort);resolve()}signal?.addEventListener('abort',abort,{once:true});});
export function checkAbort(signal){if(signal?.aborted)throw signal.reason??new Error('ABORTED');}
export async function readJson(file,fallback){for(let n=0;;n++){try{return JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));}catch(e){if(n<5&&['EACCES','EPERM','EBUSY'].includes(e.code)){await sleep(40*(n+1));continue;}if(e.code==='ENOENT')return fallback;throw e;}}}
export async function writeJson(file,value){await writeText(file,JSON.stringify(value,null,2)+'\n');}
export async function writeText(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,value,{encoding:'utf8',flag:'wx'});try{for(let n=0;;n++){try{await fs.rename(tmp,file);break;}catch(e){if(n>=5||!['EACCES','EPERM','EBUSY'].includes(e.code))throw e;await sleep(40*(n+1));}}}finally{await fs.rm(tmp,{force:true}).catch(()=>{});}}
export function inside(root,name){const target=path.resolve(root,name);if(target!==path.resolve(root)&&!target.startsWith(path.resolve(root)+path.sep))throw new Error('PATH_OUTSIDE_PROJECT');return target;}
export function dateInShanghai(d=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(d));}
export function validDate(d){return typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+'T00:00:00+08:00'));}
export function safeError(e){return String(e?.message??e).replace(/https?:\/\/[^\s]+/g,'[url]').replace(/(?:token|secret|key|password)=\S+/gi,'[redacted]').slice(0,500);}
export async function mapLimit(items,limit,fn,signal){let next=0;const result=new Array(items.length);await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){checkAbort(signal);const i=next++;result[i]=await fn(items[i],i);}}));return result;}

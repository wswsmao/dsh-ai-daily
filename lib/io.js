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
export function publicHostSafe(host){const h=String(host).toLowerCase().replace(/^\[|\]$/g,'');if(!h||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.includes('%')||h.includes(':')||/^(0\.|127\.|10\.|192\.168\.|169\.254\.)/.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h)||/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h))return false;return true;}
export function inside(root,name){const target=path.resolve(root,name);if(target!==path.resolve(root)&&!target.startsWith(path.resolve(root)+path.sep))throw new Error('PATH_OUTSIDE_PROJECT');return target;}
export function dateInShanghai(d=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(d));}
export function validDate(d){if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d))return false;const x=new Date(d+'T00:00:00+08:00');return !Number.isNaN(x.valueOf())&&new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(x)===d;}
export function safeError(e){return String(e?.message??e).replace(/https?:\/\/[^\s]+/g,'[url]').replace(/(?:token|secret|key|password)=\S+/gi,'[redacted]').slice(0,500);}

/** Record a tolerated failure so it is diagnosable later.
 *
 *  A few operations must not abort a run - pruning old runs, reconciling stale state, restoring a
 *  collector handle - but "must not abort" is not "must stay invisible". Every such site calls this so
 *  the run log names what failed and why, while a genuinely broken path still throws.
 */
const LOG_LIMIT = 200;
export function recordTolerated(state, where, error) {
  if (!state) return;
  const entry = { at: new Date().toISOString(), where, error: safeError(error) };
  state.tolerated = Array.isArray(state.tolerated) ? state.tolerated : [];
  state.tolerated.push(entry);
  if (state.tolerated.length > LOG_LIMIT) state.tolerated = state.tolerated.slice(-LOG_LIMIT);
}

export async function mapLimit(items,limit,fn,signal){if(!Number.isSafeInteger(limit)||limit<1)throw new Error('INVALID_MAP_CONCURRENCY');let next=0;const result=new Array(items.length);let firstError;const workers=Array.from({length:Math.min(limit,items.length)},async()=>{while(true){if(firstError)return;try{checkAbort(signal);}catch(e){firstError??=e;return;}const i=next++;if(i>=items.length)return;try{result[i]=await fn(items[i],i);}catch(e){firstError??=e;return;}}});await Promise.allSettled(workers);if(firstError)throw firstError;checkAbort(signal);return result;}

import {sha256,checkAbort,safeError} from './io.js';

const decode=(s='')=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
export function htmlText(html=''){return decode(String(html).replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/(p|div|li|h[1-6]|section|article)>/gi,'\n').replace(/<[^>]+>/g,' ')).replace(/[\t ]+/g,' ').replace(/\n\s*\n\s*\n/g,'\n\n').replace(/ +([.,;:!?])/g,'$1').trim();}
const field=(xml,name)=>{const escaped=name.replace(':','\\:');const m=new RegExp('<'+escaped+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+escaped+'>','i').exec(xml);return m?decode(m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/,'$1').trim()):'';};
export function parseFeed(xml,source,cutoff,reference){
  if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('FEED_EXTERNAL_ENTITIES_REFUSED');
  const items=[...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi)].map(x=>x[0]);
  if(!/<rss\b|<feed\b|<rdf:RDF/i.test(xml))throw new Error('NOT_A_FEED');
  const records=[];let unknownDates=0;
  for(const item of items){const title=field(item,'title');const link=field(item,'link')||(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(item)?.[1]??'');const stamp=field(item,'pubDate')||field(item,'published')||field(item,'updated')||field(item,'dc:date');const ms=Date.parse(stamp);if(!Number.isFinite(ms)){unknownDates++;continue;}if(ms<Date.parse(cutoff)||ms>Date.parse(reference))continue;
    let u;try{u=new URL(decode(link));if(u.protocol!=='https:'&&u.protocol!=='http:')continue;}catch{continue;}
    const raw=field(item,'content:encoded')||field(item,'content')||field(item,'description')||field(item,'summary');
    const text=htmlText(raw);const id='web:'+sha256(u.href);
    records.push({id,identity:id,title,url:u.href,author:field(item,'dc:creator')||field(item,'author').replace(/<[^>]+>/g,''),account:source.id,date:new Date(ms).toISOString().slice(0,10),published_at_iso:new Date(ms).toISOString(),publication_precision:'minute',content_type:source.id.startsWith('arxiv')?'paper_abstract':source.type==='github-atom'?'release_notes':'article',body_text:text,body_status:text?'read':'unavailable',body_complete:!!text,body_basis:source.id.startsWith('arxiv')?'论文摘要':source.type==='github-atom'?'版本说明':'订阅摘要',language:source.language,topics:[source.topic],source_id:source.id});
  }
  return {records,entry_count:items.length,date_unknown:unknownDates,coverage:{source_id:source.id,scope:source.scope,complete:unknownDates===0}};
}
export function makePublicFetch(fetchFn=globalThis.fetch){return async function(url,signal){const u=new URL(url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.hostname==='localhost'||u.hostname==='[::1]'||/^(127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)||/^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname))throw new Error('PRIVATE_FETCH_REFUSED');const timeout=AbortSignal.timeout(45000);const combined=signal?AbortSignal.any([signal,timeout]):timeout;const res=await fetchFn(u.href,{signal:combined,redirect:'follow',headers:{'user-agent':'DSH-AI-Daily/1.0 (+local technical digest)'}});if(!res.ok)throw new Error('HTTP_'+res.status);const body=await res.text();if(body.length>5000000)throw new Error('SOURCE_TOO_LARGE');return body;};}
export async function collectSource(source,cutoff,reference,{fetchText,signal}){checkAbort(signal);try{const xml=await fetchText(source.url,signal);return {...parseFeed(xml,source,cutoff,reference),status:'complete'};}catch(e){checkAbort(signal);return {records:[],status:'failed',source_id:source.id,error:safeError(e),coverage:{source_id:source.id,scope:source.scope,complete:false}};}}
export async function readWebBody(article,{fetchText,signal}){
  if(article.content_type==='paper_abstract'||article.content_type==='release_notes')return article;
  try{const html=await fetchText(article.url,signal);const content=/<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1]??/<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1]??html;const text=htmlText(content);if(text.length<200)throw new Error('BODY_TOO_SHORT');return {...article,body_text:text.slice(0,500000),body_status:'read',body_complete:text.length<=500000,body_basis:'网页正文',body_truncated:text.length>500000};}
  catch(e){checkAbort(signal);return {...article,body_complete:false,body_status:article.body_text?'abstract_only':'unavailable',body_error:safeError(e)};}
}

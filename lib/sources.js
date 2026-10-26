import dns from 'node:dns/promises';
import {isIP} from 'node:net';
import {sha256,checkAbort,safeError,publicHostSafe} from './io.js';

const decode=(s='')=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
export function htmlText(html=''){return decode(String(html).replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/(p|div|li|h[1-6]|section|article)>/gi,'\n').replace(/<[^>]+>/g,' ')).replace(/[\t ]+/g,' ').replace(/\n\s*\n\s*\n/g,'\n\n').replace(/ +([.,;:!?])/g,'$1').trim();}
const field=(xml,name)=>{const escaped=name.replace(':','\\:');const m=new RegExp('<'+escaped+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+escaped+'>','i').exec(xml);return m?decode(m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/,'$1').trim()):'';};
export function parseFeed(xml,source,cutoff,reference){
  if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('FEED_EXTERNAL_ENTITIES_REFUSED');
  const items=[...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi)].map(x=>x[0]);
  if(!/<rss\b|<feed\b|<rdf:RDF/i.test(xml))throw new Error('NOT_A_FEED');
  const records=[];const unknownDates=[];
  for(const item of items){const title=field(item,'title');const link=field(item,'link')||(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(item)?.[1]??'');const stamp=field(item,'pubDate')||field(item,'published')||field(item,'updated')||field(item,'dc:date');const ms=Date.parse(stamp);if(!Number.isFinite(ms)){unknownDates.push({title:title.slice(0,600),url:link.slice(0,2048),date_raw:stamp.slice(0,200),source_id:source.id,language:source.language,topic:source.topic,identity:'pending-date:'+sha256(source.id+'|'+title+'|'+link)});continue;}if(ms<Date.parse(cutoff)||ms>Date.parse(reference))continue;
    let u;try{u=new URL(decode(link));if(!['http:','https:'].includes(u.protocol)||u.username||u.password||!publicHostSafe(u.hostname))continue;}catch{continue;}
    const raw=field(item,'content:encoded')||field(item,'content')||field(item,'description')||field(item,'summary');
    const text=htmlText(raw);const id='web:'+sha256(u.href);
    records.push({id,identity:id,title,url:u.href,author:field(item,'dc:creator')||field(item,'author').replace(/<[^>]+>/g,''),account:source.id,date:new Date(ms).toISOString().slice(0,10),published_at_iso:new Date(ms).toISOString(),publication_precision:'minute',content_type:source.id.startsWith('arxiv')?'paper_abstract':source.type==='github-atom'?'release_notes':'article',body_text:text,body_status:text?'read':'unavailable',body_complete:!!text,body_basis:source.id.startsWith('arxiv')?'论文摘要':source.type==='github-atom'?'版本说明':'订阅摘要',language:source.language,topics:[source.topic],source_id:source.id});
  }
  return {records,entry_count:items.length,date_unknown:unknownDates.length,pending_records:unknownDates,coverage:{source_id:source.id,scope:source.scope,complete:unknownDates.length===0}};
}
const PRIVATE_IPV6=/^(::1|::|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|fc[0-9a-f]{2}:)/i;
function ipLiteralSafe(host){
  const h=String(host).toLowerCase().replace(/^\[|\]$/g,'');
  if(isIP(h)){
    if(h.includes(':'))return !PRIVATE_IPV6.test(h)&&!h.startsWith('::ffff:127.')&&!h.startsWith('::ffff:10.')&&!h.startsWith('::ffff:192.168.');
    return publicHostSafe(h);
  }
  return null;
}
export async function assertHostPublic(host,{lookup=dns.lookup}={}){
  if(!publicHostSafe(host))throw new Error('PRIVATE_HOST_REFUSED');
  const literal=ipLiteralSafe(host);
  if(literal!==null){if(!literal)throw new Error('PRIVATE_HOST_REFUSED');return true;}
  let addresses;
  try{addresses=await lookup(host,{all:true});}
  catch(e){throw new Error('HOST_RESOLUTION_FAILED:'+String(e?.code??e));}
  if(!Array.isArray(addresses)||!addresses.length)throw new Error('HOST_RESOLUTION_FAILED:EMPTY');
  for(const entry of addresses){
    const ip=typeof entry==='string'?entry:entry?.address;
    if(!ip||isIP(ip)===0)throw new Error('HOST_RESOLUTION_FAILED:UNPARSED');
    if(!publicHostSafe(ip))throw new Error('PRIVATE_HOST_REFUSED');
    if(ip.includes(':')&&PRIVATE_IPV6.test(ip))throw new Error('PRIVATE_HOST_REFUSED');
  }
  return true;
}
export function makePublicFetch(fetchFn=globalThis.fetch,options={}){return async function(url,signal){
  const u=new URL(url);
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw new Error('PRIVATE_FETCH_REFUSED');
  await assertHostPublic(u.hostname,options);
  const timeout=AbortSignal.timeout(45000);
  const combined=signal?AbortSignal.any([signal,timeout]):timeout;
  let current=u;
  for(let hop=0;hop<5;hop++){
    checkAbort(signal);
    const res=await fetchFn(current.href,{signal:combined,redirect:'manual',headers:{'user-agent':'DSH-AI-Daily/1.0 (+local technical digest)'}});
    if(res.status>=300&&res.status<400){
      const location=res.headers.get('location');
      if(!location)throw new Error('SOURCE_REDIRECT_LIMIT');
      if(hop===4)throw new Error('SOURCE_REDIRECT_LIMIT');
      let next;
      try{next=new URL(location,current);}
      catch{throw new Error('SOURCE_REDIRECT_INVALID');}
      if(!['http:','https:'].includes(next.protocol)||next.username||next.password)throw new Error('PRIVATE_FETCH_REDIRECT_REFUSED');
      await assertHostPublic(next.hostname,options);
      current=next;continue;
    }
    if(!res.ok)throw new Error('HTTP_'+res.status);
    if(!res.body){const body=await res.text();if(body.length>5000000)throw new Error('SOURCE_TOO_LARGE');return body;}
    const reader=res.body.getReader();const decoder=new TextDecoder();let out='',size=0;
    for(;;){checkAbort(signal);const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>5000000){await reader.cancel();throw new Error('SOURCE_TOO_LARGE');}out+=decoder.decode(value,{stream:true});}
    out+=decoder.decode();return out;
  }
  throw new Error('SOURCE_REDIRECT_LIMIT');
};}
export async function collectSource(source,cutoff,reference,{fetchText,signal}){checkAbort(signal);try{const xml=await fetchText(source.url,signal);const parsed=parseFeed(xml,source,cutoff,reference);return {...parsed,status:parsed.coverage.complete?'complete':'partial'};}catch(e){checkAbort(signal);return {records:[],status:'failed',source_id:source.id,error:safeError(e),coverage:{source_id:source.id,scope:source.scope,complete:false}};}}
export async function readWebBody(article,{fetchText,signal}){
  if(article.content_type==='paper_abstract'||article.content_type==='release_notes')return article;
  try{const html=await fetchText(article.url,signal);const content=/<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1]??/<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1]??html;const text=htmlText(content);if(text.length<200)throw new Error('BODY_TOO_SHORT');return {...article,body_text:text.slice(0,500000),body_status:'read',body_complete:text.length<=500000,body_basis:'网页正文',body_truncated:text.length>500000};}
  catch(e){checkAbort(signal);return {...article,body_complete:false,body_status:article.body_text?'abstract_only':'unavailable',body_error:safeError(e)};}
}

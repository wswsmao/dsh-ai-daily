// Internal limits for one analysis call. These bound a single call rather than the run, so they are
// constants here instead of project settings: the caller groups articles to fit one call.
const MAX_BATCH_SIZE = 6;
const MAX_BATCH_ARTICLE_CHARS = 12000;
const MAX_BATCH_CHARS = 18000;
const MAX_OUTPUT_TOKENS = 6000;

import {sha256,checkAbort,writeJson,readJson,safeError,sleep,mapLimit} from './io.js';
import {TOPICS} from './config.js';
import path from 'node:path';

export function splitBody(text,maxChars=18000){const chunks=[];for(let i=0;i<text.length;i+=maxChars){chunks.push(text.slice(i,i+maxChars));}return chunks;}
export function parseModelJson(text){const cleaned=String(text).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');let data;try{data=JSON.parse(cleaned);}catch{throw new Error('MODEL_JSON_INVALID');}return data;}
export function validateQuality(q){
  if(!q||typeof q!=='object')return null;
  const dims=['novelty','specificity','depth','firstHand','honesty'];
  const vals=dims.map(d=>Number(q[d]));
  if(vals.some(v=>!Number.isFinite(v)||v<0||v>2))return null;
  const [novelty,specificity,depth,firstHand,honesty]=vals;
  return {novelty,specificity,depth,firstHand,honesty,total:novelty+specificity+depth+firstHand+honesty};
}
export function validateAnalysis(data,id,body){
  if(!data||data.article_id!==id||!['technical','uncertain','promotional'].includes(data.status)||typeof data.summary_zh!=='string'||typeof data.reason!=='string'||!Array.isArray(data.evidence_quotes)||!Array.isArray(data.topics))throw new Error('MODEL_ANALYSIS_SCHEMA_INVALID');
  if(data.summary_zh.length>1800||data.reason.length>1000||data.evidence_quotes.length>3)throw new Error('MODEL_ANALYSIS_TOO_LONG');
  const quotes=data.evidence_quotes.filter(q=>typeof q==='string'&&q.length>=4&&q.length<=350&&body.includes(q));
  // Quote verification is a string fact check: it proves the model did not invent evidence.
  // Whether the article counts as technical is the model's judgement, so an unverified quote is
  // recorded as a flag rather than silently downgrading the status.
  const status=data.status;
  const quotesUnverified=quotes.length===0&&Array.isArray(data.evidence_quotes)&&data.evidence_quotes.length>0;
  return {article_id:id,status,summary_zh:data.summary_zh.slice(0,1800),reason:data.reason.slice(0,1000),evidence_quotes:quotes,topics:[...new Set((Array.isArray(data.topics)?data.topics:[]).filter(t=>typeof t==='string'&&t.trim()).map(t=>t.trim().slice(0,60)))].slice(0,3),event_key:typeof data.event_key==='string'?data.event_key.slice(0,180):'',novelty:String(data.novelty??'').slice(0,1000),limitations:String(data.limitations??'').slice(0,1000),confidence:Math.max(0,Math.min(1,Number(data.confidence)||0)),body_basis:String(data.body_basis??'').slice(0,100),quality:validateQuality(data.quality),quotes_unverified:quotesUnverified};
}
export async function streamJson(llm,selection,system,payload,options){
  checkAbort(options.signal);let text='',finish,usage;
  for await(const c of llm.stream({...selection,maxTokens:options.maxTokens??6000,messages:[{role:'user',content:[{type:'text',text:JSON.stringify(payload)}]}],system,tools:[],signal:options.signal})){
    if(c.type==='text-delta')text+=c.text;
    if(c.type==='usage')usage=c.usage;
    if(c.type==='finish')finish=c.reason;
  }
  if(finish?.kind!=='stop')throw new Error('MODEL_FINISH_'+(finish?.kind??'MISSING'));
  return {data:parseModelJson(text),usage};
}
export class ArticleReviewer{
  constructor({llm,selection,policy,cacheDir,config,signal,onUsage}){Object.assign(this,{llm,selection,policy,cacheDir,config,signal,onUsage});this.calls=0;
    this.warnings=[];this.batchSize=Math.max(1,Number(config?.batch_size??MAX_BATCH_SIZE));
    this.batchArticleChars=Math.max(2000,Number(config?.batch_article_chars??MAX_BATCH_ARTICLE_CHARS));}
  async call(payload,id,body){let last;for(let retry=0;retry<=this.config.max_retries;retry++){checkAbort(this.signal);if(this.calls>=this.config.max_calls)throw new Error('MODEL_CALL_BUDGET_EXCEEDED');this.calls++;try{const {data,usage}=await streamJson(this.llm,this.selection,this.policy+'\n\n仅输出一个JSON对象。article_id必须原样返回。字段: article_id,status,summary_zh,reason,evidence_quotes,topics,event_key,novelty,limitations,confidence,body_basis,quality。quality 由你阅读内容后判断，不是匹配关键词：{novelty:0-2,specificity:0-2,depth:0-2,firstHand:0-2,honesty:0-2}。novelty=是否新论文/新系统/新版本发布；specificity=是否有架构细节与量化数据；depth=是否系统架构层（调度/记忆/权限/协议/运行时）而非使用层；firstHand=是否自己实验或读源码而非转述；honesty=是否如实标注局限与未验证部分。营销话术堆砌的“发布”应给低分。允许领域:'+TOPICS.join('、'),payload,{signal:this.signal,maxTokens:this.config.max_output_tokens});this.onUsage?.(usage,this.calls);return validateAnalysis(data,id,body);}catch(e){checkAbort(this.signal);last=e;await sleep(500*(retry+1),this.signal);}}throw last;}
  async review(article){
    const body=String(article.body_text??'');
    // No body means no basis for judgement. Publishing a guess from the title would silently lower
    // the edition's quality, so this fails with the article named.
    if(!body.trim())throw new Error('ARTICLE_BODY_MISSING: 《'+String(article.title??article.id).slice(0,60)+'》没有正文，不能只凭标题判断（'+String(article.body_error??'未读取到正文')+'）');
    const fingerprint=sha256({body,policy:this.policy,selection:this.selection});const file=path.join(this.cacheDir,fingerprint+'.json');const prior=await readJson(file);if(prior)return {...prior,article_id:article.id,cached:true};
    try{
      const chunks=splitBody(body,Math.max(200,Number(this.config.batch_chars??MAX_BATCH_CHARS)));const parts=[];
      for(let i=0;i<chunks.length;i++){const p=await this.call({article_id:article.id,title:article.title,url:article.url,body_basis:article.body_basis??'正文',chunk_index:i+1,chunk_count:chunks.length,text:chunks[i]},article.id,chunks[i]);parts.push(p);}
      const classifications=new Set(parts.map(p=>p.status));const status=classifications.has('technical')?'technical':classifications.has('uncertain')?'uncertain':'promotional';
      const analysis={article_id:article.id,status,summary_zh:parts.map(p=>p.summary_zh).join('\n').slice(0,2400),reason:parts.map(p=>p.reason).join('；').slice(0,1200),topics:[...new Set(parts.flatMap(p=>p.topics))].slice(0,3),event_key:parts.find(p=>p.event_key)?.event_key??'',evidence_quotes:parts.flatMap(p=>p.evidence_quotes).slice(0,3),novelty:parts.map(p=>p.novelty).filter(Boolean).join('；').slice(0,1200),limitations:parts.map(p=>p.limitations).filter(Boolean).join('；').slice(0,1200),confidence:Math.min(...parts.map(p=>p.confidence)),quality:(()=>{const qs=parts.map(p=>p.quality).filter(Boolean);if(!qs.length)return null;const avg=k=>Math.round(qs.reduce((a,b)=>a+b[k],0)/qs.length);const q={novelty:avg('novelty'),specificity:avg('specificity'),depth:avg('depth'),firstHand:avg('firstHand'),honesty:avg('honesty')};q.total=q.novelty+q.specificity+q.depth+q.firstHand+q.honesty;return q;})(),quotes_unverified:parts.some(p=>p.quotes_unverified===true),body_basis:article.body_basis??'正文',chunks_processed:chunks.length,body_complete:article.body_complete===true};
      if(!article.body_complete){analysis.status='uncertain';analysis.limitations+='；正文不完整，保留待看。';}
      await writeJson(file,analysis);return analysis;
    }catch(e){checkAbort(this.signal);throw new Error('ARTICLE_ANALYSIS_FAILED: 《'+String(article.title??article.id).slice(0,60)+'》分析失败：'+safeError(e));}
  }
  /** Review several articles in one model call. The model must return one JSON object per requested
   *  article_id; every entry is still validated individually, so a bad entry cannot corrupt the rest. */
  async reviewBatch(articles){
    const usable=articles.filter(a=>String(a.body_text??'').trim());
    const results=new Map();
    for(const a of articles)if(!String(a.body_text??'').trim())results.set(a.id,this.emptyBodyAnalysis(a));
    let pending=usable;
    for(let offset=0;offset<usable.length;offset+=this.batchSize){
      checkAbort(this.signal);
      const slice=usable.slice(offset,offset+this.batchSize);
      const outcome=await this.callBatch(slice,pending);
      for(const [id,value] of outcome)results.set(id,value);
      pending=slice;
    }
    return results;
  }
  emptyBodyAnalysis(article){return {article_id:article.id,status:'uncertain',summary_zh:'正文未能读取；保留原文链接供查看。',reason:'无正文，不能根据标题推测内容。',topics:article.topics??[],evidence_quotes:[],event_key:'',confidence:0,body_basis:'缺失',limitations:article.body_error??'正文缺失'};}
  async callBatch(articles,fallback){
    checkAbort(this.signal);
    if(this.calls>=this.config.max_calls)throw new Error('MODEL_CALL_BUDGET_EXCEEDED');
    this.calls++;
    const payload={instruction:'articles 数组中每篇都必须返回一个条目，article_id 必须原样返回，不得省略或合并。',articles:articles.map(a=>({article_id:a.id,title:a.title,url:a.url,body_basis:a.body_basis??'正文',text:String(a.body_text??'').slice(0,this.batchArticleChars)}))};
    const system=this.policy+'\n\n只输出一个JSON对象：{"articles":[ {article_id,status,summary_zh,reason,evidence_quotes,topics,event_key,novelty,limitations,confidence,body_basis,quality} ]}。每篇的 quality 由你阅读内容后判断，不是匹配关键词：{novelty:0-2,specificity:0-2,depth:0-2,firstHand:0-2,honesty:0-2}。novelty=是否新论文/新系统/新版本发布；specificity=是否有架构细节与量化数据；depth=是否系统架构层（调度/记忆/权限/协议/运行时）而非使用层；firstHand=是否自己实验或读源码而非转述；honesty=是否如实标注局限与未验证部分。营销话术堆砌的“发布”应给低分。。articles 数量必须与输入一致，顺序不限，article_id 必须原样返回。status 取值 technical|uncertain|promotional。允许领域:'+TOPICS.join('、');
    const {data,usage}=await streamJson(this.llm,this.selection,system,payload,{signal:this.signal,maxTokens:Math.max(MAX_OUTPUT_TOKENS,2400*articles.length)});
    this.onUsage?.(usage,this.calls);
    const rows=Array.isArray(data?.articles)?data.articles:(Array.isArray(data)?data:null);
    if(!rows)throw new Error('MODEL_BATCH_SCHEMA_INVALID');
    const byId=new Map(rows.filter(r=>r&&typeof r.article_id!=='undefined').map(r=>[String(r.article_id),r]));
    const out=new Map();
    for(const a of articles){
      const row=byId.get(String(a.id));
      // A batch reply that omits an article is a broken reply, not an unjudged article. Treating it
      // as analysed would put a title-only guess into the pool.
      if(!row)throw new Error('BATCH_RESULT_INCOMPLETE: 《'+String(a.title??a.id).slice(0,60)+'》在批量返回中缺失，不能当作已分析');
      try{
        const single=validateAnalysis(row,String(a.id),String(a.body_text??''));
        const analysis={...single,chunks_processed:1,body_complete:a.body_complete===true};
        if(!a.body_complete){analysis.status='uncertain';analysis.limitations=(analysis.limitations?analysis.limitations+'；':'')+'正文不完整，保留待看。';}
        out.set(a.id,analysis);
      }catch(e){checkAbort(this.signal);throw new Error('BATCH_RESULT_INVALID: 《'+String(a.title??a.id).slice(0,60)+'》的模型返回不可校验：'+safeError(e));}
    }
    return out;
  }
}
const ARXIV_ID=/arxiv\.org\/(?:abs|pdf|html)\/([0-9]{4}\.[0-9]{4,5})(?:v(\d+))?/gi;
const REPO_PATH=/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/gi;
const RELEASE_PATH=/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/releases\/tag\/([^/?#\s]+)/gi;
const VERSION_TAG=/\b(v?\d+\.\d+(?:\.\d+)?(?:[-.][A-Za-z0-9]+)?)\b/g;
function identityTokens(article){
  const text=`${article.url??''} ${article.title??''}`;
  const tokens=new Set();
  for(const m of text.matchAll(ARXIV_ID))tokens.add('arxiv:'+m[1].toLowerCase());
  for(const m of text.matchAll(REPO_PATH))tokens.add('repo:'+m[1].toLowerCase()+'/'+m[2].toLowerCase());
  for(const m of text.matchAll(RELEASE_PATH))tokens.add('release:'+decodeURIComponent(m[1]).toLowerCase());
  for(const m of text.matchAll(VERSION_TAG))tokens.add('version:'+m[1].toLowerCase());
  return tokens;
}
/** Accept a model event_key only when it matches an identity token present in this article. */
export function trustedEventKey(article){
  const key=String(article?.analysis?.event_key??'').trim();
  if(!key)return '';
  const tokens=identityTokens(article);
  if(!tokens.size)return '';
  const k=key.toLowerCase();
  for(const token of tokens){
    const bare=token.slice(token.indexOf(':')+1);
    if(k===bare||k===token||k.includes(bare))return key;
  }
  return '';
}
export function groupEvents(articles){const map=new Map();for(const a of articles){if(a.analysis?.status==='promotional')continue;const key=trustedEventKey(a)||a.id;let event=map.get(key);if(!event){event={id:sha256(key).slice(0,20),key,title:a.title,summary:a.analysis?.summary_zh??'',topics:a.analysis?.topics??a.topics??[],status:a.analysis?.status??'uncertain',sources:[]};map.set(key,event);}event.sources.push({article_id:a.id,title:a.title,url:a.url,author:a.author??'',account:a.account??'',date:a.date,summary:a.analysis?.summary_zh??''});}
  for(const event of map.values()){
    if(event.sources.length<2||event.key===event.sources[0].article_id)continue;
    // An accepted shared key still needs corroboration: every member must carry that identity.
    const holders=event.sources.filter(s=>{const src=articles.find(x=>x.id===s.article_id);return src&&trustedEventKey(src)===event.key;});
    if(holders.length!==event.sources.length){for(const s of event.sources){const src=articles.find(x=>x.id===s.article_id);if(!src)continue;map.set(src.id,{id:sha256(src.id).slice(0,20),key:src.id,title:src.title,summary:src.analysis?.summary_zh??'',topics:src.analysis?.topics??src.topics??[],status:src.analysis?.status??'uncertain',sources:[{article_id:src.id,title:src.title,url:src.url,author:src.author??'',account:src.account??'',date:src.date,summary:src.analysis?.summary_zh??''}]});}map.delete(event.key);}
  }
  return [...map.values()];}

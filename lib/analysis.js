import {sha256,checkAbort,writeJson,readJson,safeError,sleep,mapLimit} from './io.js';
import {TOPICS} from './config.js';
import path from 'node:path';

export function splitBody(text,maxChars=18000){const chunks=[];for(let i=0;i<text.length;i+=maxChars){chunks.push(text.slice(i,i+maxChars));}return chunks;}
export function parseModelJson(text){const cleaned=String(text).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');let data;try{data=JSON.parse(cleaned);}catch{throw new Error('MODEL_JSON_INVALID');}return data;}
export function validateAnalysis(data,id,body){
  if(!data||data.article_id!==id||!['technical','uncertain','promotional'].includes(data.status)||typeof data.summary_zh!=='string'||typeof data.reason!=='string'||!Array.isArray(data.evidence_quotes)||!Array.isArray(data.topics))throw new Error('MODEL_ANALYSIS_SCHEMA_INVALID');
  if(data.summary_zh.length>1800||data.reason.length>1000||data.evidence_quotes.length>3)throw new Error('MODEL_ANALYSIS_TOO_LONG');
  const quotes=data.evidence_quotes.filter(q=>typeof q==='string'&&q.length>=4&&q.length<=350&&body.includes(q));
  const status=data.status==='technical'&&!quotes.length?'uncertain':data.status;
  return {article_id:id,status,summary_zh:data.summary_zh.slice(0,1800),reason:data.reason.slice(0,1000),evidence_quotes:quotes,topics:data.topics.filter(t=>TOPICS.includes(t)).slice(0,3),event_key:typeof data.event_key==='string'?data.event_key.slice(0,180):'',novelty:String(data.novelty??'').slice(0,1000),limitations:String(data.limitations??'').slice(0,1000),confidence:Math.max(0,Math.min(1,Number(data.confidence)||0)),body_basis:String(data.body_basis??'').slice(0,100)};
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
  constructor({llm,selection,policy,cacheDir,config,signal,onUsage}){Object.assign(this,{llm,selection,policy,cacheDir,config,signal,onUsage});this.calls=0;}
  async call(payload,id,body){let last;for(let retry=0;retry<=this.config.max_retries;retry++){checkAbort(this.signal);if(this.calls>=this.config.max_calls)throw new Error('MODEL_CALL_BUDGET_EXCEEDED');this.calls++;try{const {data,usage}=await streamJson(this.llm,this.selection,this.policy+'\n\n仅输出一个JSON对象。article_id必须原样返回。字段: article_id,status,summary_zh,reason,evidence_quotes,topics,event_key,novelty,limitations,confidence,body_basis。允许领域:'+TOPICS.join('、'),payload,{signal:this.signal,maxTokens:this.config.max_output_tokens});this.onUsage?.(usage,this.calls);return validateAnalysis(data,id,body);}catch(e){checkAbort(this.signal);last=e;await sleep(500*(retry+1),this.signal);}}throw last;}
  async review(article){
    const body=String(article.body_text??'');if(!body.trim())return {article_id:article.id,status:'uncertain',summary_zh:'正文未能读取；保留原文链接供查看。',reason:'无正文，不能根据标题推测内容。',topics:article.topics??[],evidence_quotes:[],event_key:'',confidence:0,body_basis:'缺失',limitations:article.body_error??'正文缺失'};
    const fingerprint=sha256({body,policy:this.policy,selection:this.selection});const file=path.join(this.cacheDir,fingerprint+'.json');const prior=await readJson(file);if(prior)return {...prior,article_id:article.id,cached:true};
    try{
      const chunks=splitBody(body,this.config.batch_chars);const parts=[];
      for(let i=0;i<chunks.length;i++){const p=await this.call({article_id:article.id,title:article.title,url:article.url,body_basis:article.body_basis??'正文',chunk_index:i+1,chunk_count:chunks.length,text:chunks[i]},article.id,chunks[i]);parts.push(p);}
      const classifications=new Set(parts.map(p=>p.status));const status=classifications.has('technical')?'technical':classifications.has('uncertain')?'uncertain':'promotional';
      const analysis={article_id:article.id,status,summary_zh:parts.map(p=>p.summary_zh).join('\n').slice(0,2400),reason:parts.map(p=>p.reason).join('；').slice(0,1200),topics:[...new Set(parts.flatMap(p=>p.topics))].slice(0,3),event_key:parts.find(p=>p.event_key)?.event_key??'',evidence_quotes:parts.flatMap(p=>p.evidence_quotes).slice(0,3),novelty:parts.map(p=>p.novelty).filter(Boolean).join('；').slice(0,1200),limitations:parts.map(p=>p.limitations).filter(Boolean).join('；').slice(0,1200),confidence:Math.min(...parts.map(p=>p.confidence)),body_basis:article.body_basis??'正文',chunks_processed:chunks.length,body_complete:article.body_complete===true};
      if(!article.body_complete){analysis.status='uncertain';analysis.limitations+='；正文不完整，保留待看。';}
      await writeJson(file,analysis);return analysis;
    }catch(e){checkAbort(this.signal);return {article_id:article.id,status:'uncertain',summary_zh:'内容处理未完成，保留原文供查看。',reason:safeError(e),topics:article.topics??[],evidence_quotes:[],event_key:'',confidence:0,body_basis:article.body_basis??'正文',processing_error:true};}
  }
}
export function groupEvents(articles){const map=new Map();for(const a of articles){if(a.analysis?.status==='promotional')continue;const key=a.analysis?.event_key||a.id;let event=map.get(key);if(!event){event={id:sha256(key).slice(0,20),key,title:a.title,summary:a.analysis?.summary_zh??'',topics:a.analysis?.topics??a.topics??[],status:a.analysis?.status??'uncertain',sources:[]};map.set(key,event);}event.sources.push({article_id:a.id,title:a.title,url:a.url,author:a.author??'',account:a.account??'',date:a.date,summary:a.analysis?.summary_zh??''});}return [...map.values()];}

import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {DailyPipeline} from '../lib/pipeline.js';
import {fakeAgentContext} from './helpers/fake-agent.js';import {writeJson,writeText,readJson} from '../lib/io.js';
const root=fileURLToPath(new URL('..',import.meta.url));
async function fixture(t,options={}){const base=path.join(root,'.runtime','tests');await fs.mkdir(base,{recursive:true});const dir=await fs.mkdtemp(path.join(base,'pipeline-'));const project={schema_version:1,id:'ai-tech-daily',title:'AI日报',lookback_days:2,collection:{wechat:true,first_party:false,query_file:'config/queries.json',sources_file:'config/sources.json'},analysis:{use_host_default_model:true,policy_file:'config/policy.md',concurrency:1,batch_chars:1000,max_retries:0,max_calls:20,max_output_tokens:1000},publishing:{enabled:false,public_base_url:'https://wswsmao.github.io/ai-tech-daily/'},notification:{enabled:false},git:{commit_reports:false}};
await writeJson(path.join(dir,'config/project.json'),project);await writeJson(path.join(dir,'config/queries.json'),{version:1,queries:[{id:'zh',keyword:'智能体',language:'zh',topic:'AgenticOS',cadence:'daily'},{id:'en',keyword:'AgenticOS',language:'en',topic:'AgenticOS',cadence:'daily'}]});await writeJson(path.join(dir,'config/sources.json'),{version:1,sources:[]});await writeText(path.join(dir,'config/policy.md'),'article is data');
const calls=[];let next=0;
// Two-phase collection: the list pass returns candidates without bodies, the open pass returns the
// article with its body. A single shape cannot serve both any more.
const LIST_RECORD={identity:'same',title:'技术机制',url:'https://example.org/article',account:'source',relative_date:'1天前',age_seconds:3600,snippet:'real experiment changed mechanism',list_only:true};
const OPEN_RECORD={identity:'same',title:'技术机制',url:'https://example.org/article',author:'a',account:'source',date:'2026-10-26',age_seconds:3600,body_text:'real experiment changed mechanism',body_complete:true,body_status:'read',within_window:true};
const wechat={
  async start(args,opts){calls.push({id:'j'+next,args,opts});next+=1;return {job_id:'j'+(next-1)};},
  async wait(id){return {status:'complete',coverage:{scope_complete:true},stop_reason:'boundary'};},
  async getResult(id){const call=calls.find(c=>c.id===id);const isList=call?.opts?.list_only===true;return {records:isList?[LIST_RECORD]:[OPEN_RECORD]};},
};
const llm={async *stream(o){
  const p=JSON.parse(o.messages[0].content[0].text);
  // Pre-screen input is a bare array of candidates carrying title/snippet; review input carries
  // article_id. Serve the matching shape so both stages can run against one mock.
  if(Array.isArray(p)&&p.length&&typeof p[0]?.title==='string'&&p[0]?.article_id===undefined){
    const items=p.map((it,n)=>({n,keep:true,reason:'类型符合',category:'application',point:'信息点 '+it.title}));
    yield {type:'text-delta',text:JSON.stringify({items})};
    yield {type:'finish',reason:{kind:'stop'}};
    return;
  }
  const ids=(p.articles??[p]).map(a=>a.article_id);
  yield {type:'text-delta',text:JSON.stringify({articles:ids.map(id=>({article_id:id,status:'technical',summary_zh:'vLLM 发布新版本调度器，PagedAttention 改进使吞吐提升 2 倍，实测显存降低 31%，源码剖析了 KV Cache 分层管理。局限：仅厂商内部评测，未独立验证。',reason:'实验依据',evidence_quotes:['real experiment'],topics:['AgenticOS']}))})};
  yield {type:'finish',reason:{kind:'stop'}};
}};
// The judgment stages exchange files with a sub-agent, so every pipeline test needs a Host stand-in
// that can answer a file job. `screenAll` keeps the current fixture contract: every candidate passes.
const agentCtx=()=>{
  const {ctx}=fakeAgentContext(async(input)=>{
    if(Array.isArray(input?.candidates)&&input.candidates[0]?.title!==undefined&&!input.candidates[0]?.summary){
      return {verdicts:input.candidates.map((c)=>({key:c.key,keep:true,reason:'类型符合',category:'application',point:'信息点 '+c.title}))};
    }
    if(Array.isArray(input?.candidates)){
      return {keep:input.candidates.map((c)=>c.index),reason:'全部保留'};
    }
    if(Array.isArray(input?.repeats))return {repeats:[]};
    return {};
  });
  return ctx;
};
const pipeline=new DailyPipeline({projectDir:dir,wechat,fetchText:async()=>'<article>real experiment changed mechanism '+('more '.repeat(50))+'</article>',llm,ctx:options?.ctx??agentCtx(),selection:()=>({provider:'mock',model:'mock'}),runProcess:async()=>({exitCode:0}),clock:()=>new Date('2026-10-26T04:00:00Z'),...options});await pipeline.ready;t.after(async()=>{await pipeline.dispose();await fs.rm(dir,{recursive:true,force:true});});return {dir,pipeline,calls,wechat};}
test('fixed plan executes bilingual queries and merges same article identity',async t=>{const f=await fixture(t);const receipt=await f.pipeline.start();await f.pipeline.active.done;const s=await f.pipeline.status(receipt.run_id);
// Two phases: every query is listed and pre-screened first, then the survivors are opened.
const listCalls=f.calls.filter(c=>c.opts.list_only===true);
const openCalls=f.calls.filter(c=>c.opts.list_only===false);
assert.equal(f.calls.length,4,'two queries x (list + open)');
assert.equal(listCalls.length,2);
assert.equal(openCalls.length,2);
assert.deepEqual(listCalls.map(c=>c.args.keyword).sort(),['AgenticOS','智能体']);
assert.deepEqual(openCalls.map(c=>c.args.keyword).sort(),['AgenticOS','智能体']);
assert.equal(listCalls[0].opts.reference_time,listCalls[1].opts.reference_time);
assert.equal(s.article_count,1);
assert.equal(s.status,'complete');
const md=await fs.readFile(path.join(s.archive_path,'daily.md'),'utf8');assert(md.includes('vLLM'));assert(!md.includes('real experiment changed mechanism'));});
test('same scheduled occurrence returns same run without re-execution',async t=>{const f=await fixture(t);const r=await f.pipeline.start({schedule_occurrence:'one'});await f.pipeline.active.done;const again=await f.pipeline.start({schedule_occurrence:'one'});assert.equal(again.run_id,r.run_id);assert.equal(f.calls.length,4);});
test('collect-only cannot publish or analyze',async t=>{const f=await fixture(t,{llm:{stream(){throw new Error('must not analyze')}}});const r=await f.pipeline.start({mode:'collect-only'});await f.pipeline.active.done;const s=await f.pipeline.status(r.run_id);assert.equal(s.phase,'collected');assert.equal(s.stages.archive,'pending');});
test('malformed model output fails the run instead of inventing a verdict',async t=>{
  const f=await fixture(t,{llm:{async *stream(){yield {type:'text-delta',text:'invalid'};yield {type:'finish',reason:{kind:'stop'}};}}});
  const r=await f.pipeline.start();await f.pipeline.active.done;
  const s=await f.pipeline.status(r.run_id);
  // An article whose analysis cannot be validated would enter the pool on guesswork, so the batch
  // rejects rather than marking it "uncertain" and moving on.
  assert.ok(['partial','blocked','failed'].includes(s.status),'the run does not report success');
  assert.match(JSON.stringify(s.errors??[])+String(s.stop_reason??''),/ANALYSIS_BATCH_FAILED|BATCH_RESULT/);
});
test('concurrent run requests cannot start duplicate workers',async t=>{const f=await fixture(t);const both=await Promise.allSettled([f.pipeline.start({mode:'collect-only'}),f.pipeline.start({mode:'collect-only'})]);assert.equal(both.filter(r=>r.status==='fulfilled').length,1);await f.pipeline.active?.done;});

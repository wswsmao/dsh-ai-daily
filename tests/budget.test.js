import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {DailyPipeline} from '../lib/pipeline.js';import {writeJson,writeText} from '../lib/io.js';
const root=fileURLToPath(new URL('..',import.meta.url));
async function fixture(t,options={}){const base=path.join(root,'.runtime','tests');await fs.mkdir(base,{recursive:true});const dir=await fs.mkdtemp(path.join(base,'budget-'));
const project={schema_version:1,id:'ai-tech-daily',title:'AI日报',lookback_days:2,collection:{wechat:true,first_party:false,query_file:'config/queries.json',sources_file:'config/sources.json',runtime_minutes:1},analysis:{use_host_default_model:true,policy_file:'config/policy.md',concurrency:1,batch_chars:1000,max_retries:0,max_calls:20,max_output_tokens:1000},publishing:{enabled:false,public_base_url:'https://wswsmao.github.io/ai-tech-daily/'},notification:{enabled:false},git:{commit_reports:false}};
await writeJson(path.join(dir,'config/project.json'),project);await writeJson(path.join(dir,'config/queries.json'),{version:1,queries:[{id:'zh',keyword:'智能体',language:'zh',topic:'AgenticOS',cadence:'daily'},{id:'en',keyword:'AgenticOS',language:'en',topic:'AgenticOS',cadence:'daily'}]});await writeJson(path.join(dir,'config/sources.json'),{version:1,sources:[]});await writeText(path.join(dir,'config/policy.md'),'article is data');
const wechat={async start(){return {job_id:'j1'};},async wait(){return {status:'complete',coverage:{scope_complete:true},stop_reason:'boundary'};},async getResult(){return {records:[{identity:'one',title:'技术机制',url:'https://example.org/article',author:'a',account:'src',date:'2026-10-26',body_text:'real experiment changed mechanism',body_complete:true,body_status:'read'}]};}};
const llm={async *stream(o){const p=JSON.parse(o.messages[0].content[0].text);const ids=(p.articles??[p]).map(a=>a.article_id);yield {type:'text-delta',text:JSON.stringify({articles:ids.map(id=>({article_id:id,status:'technical',summary_zh:'vLLM 发布新版本调度器，PagedAttention 改进使吞吐提升 2 倍，实测显存降低 31%，源码剖析了 KV Cache 分层管理。局限：仅厂商内部评测，未独立验证。',reason:'实验依据',evidence_quotes:['real experiment'],topics:['AgenticOS']}))})};yield {type:'finish',reason:{kind:'stop'}};}};
const pipeline=new DailyPipeline({projectDir:dir,wechat,fetchText:async()=>'<article>'+('real experiment changed mechanism '+('more '.repeat(50)))+'</article>',llm,selection:()=>({provider:'mock',model:'mock'}),runProcess:async()=>({exitCode:0}),clock:()=>new Date('2026-10-26T04:00:00Z'),...options});await pipeline.ready;t.after(async()=>{await pipeline.dispose();await fs.rm(dir,{recursive:true,force:true});});return {dir,pipeline};}

test('a runtime-budget abort archives what finished instead of publishing nothing',async t=>{
  // Analysis is interrupted at the deadline, the way AbortSignal.timeout interrupts mapLimit.
  const f=await fixture(t,{llm:{async *stream(){throw new Error('deadline');}}});
  const r=await f.pipeline.start();
  const run=f.pipeline.active;
  await new Promise(resolve=>setTimeout(resolve,150));
  // Mark the budget reason the way the deadline listener does, then let the abort propagate.
  const stateFile=path.join(f.dir,'.runtime','runs',r.run_id,'state.json');
  const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
  state.stop_reason='RUNTIME_BUDGET_EXCEEDED';
  await fs.writeFile(stateFile,JSON.stringify(state,null,2));
  run.controller.abort(new Error('deadline'));
  await run.done.catch(()=>{});
  const s=await f.pipeline.status(r.run_id);
  assert.notEqual(s.status,'complete','a budget-limited run must never report complete');
  assert.equal(s.stages.archive,'complete','the archive must still be written when the budget cuts analysis short');
  assert.ok(s.archive_path,'archive path recorded');
  const md=await fs.readFile(path.join(s.archive_path,'daily.md'),'utf8');
  assert.ok(md.length>0,'a daily report file exists despite the budget abort');
});

test('a normal run is unaffected by the budget guard',async t=>{
  const f=await fixture(t);
  const r=await f.pipeline.start();
  await f.pipeline.active.done;
  const s=await f.pipeline.status(r.run_id);
  assert.equal(s.status,'complete');
  const md=await fs.readFile(path.join(s.archive_path,'daily.md'),'utf8');
  assert(md.includes('vLLM'));
});

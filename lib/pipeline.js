import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readJson,writeJson,writeText,sha256,dateInShanghai,validDate,TERMINAL,safeError,checkAbort,mapLimit,sleep} from './io.js';
import {prescreenCandidates,loadPolicy as loadPrescreen,candidateKey} from './prescreen.js';
import {selectEdition} from './selection.js';
import {loadProject} from './config.js';
import {collectSource,readWebBody} from './sources.js';
import {ArticleReviewer,groupEvents} from './analysis.js';
import {renderSite,renderMarkdown} from './site.js';
import {PublishGithub} from './publish.js';
import {createImAdapter,resolveDelivery} from './im-delivery.js';

function normalizedUrl(raw){const u=new URL(raw);if(!['https:','http:'].includes(u.protocol))throw new Error('INVALID_SOURCE_URL');for(const k of [...u.searchParams.keys()])if(/^utm_|^(fbclid|gclid)$/.test(k))u.searchParams.delete(k);u.hash='';return u.href;}
function sanitizeTitle(article){if(article.content_type==='text_share'&&article.title.length>300)return article.title.split(/[。！？\n]/)[0].slice(0,180)+'（公众号文字分享）';return article.title.slice(0,1000);}
export class DailyPipeline{
  constructor({projectDir,ctx,wechat,fetchText,llm,selection,runProcess,imAdapter,clock=()=>new Date()}){Object.assign(this,{projectDir:path.resolve(projectDir),ctx,wechat,fetchText,llm,selection,runProcess,imAdapter,clock});this.active=null;this.serial=Promise.resolve();this.ready=this.initialize();}
  get runtime(){return path.join(this.projectDir,'.runtime');}
  runDir(id){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('INVALID_RUN_ID');return path.join(this.runtime,'runs',id);}
  async initialize(){await fs.mkdir(path.join(this.runtime,'runs'),{recursive:true});for(const id of await fs.readdir(path.join(this.runtime,'runs'))){try{const s=await readJson(path.join(this.runDir(id),'state.json'));if(s&&!TERMINAL.has(s.status)){s.status='interrupted';s.stop_reason='HOST_RESTART';await writeJson(path.join(this.runDir(id),'state.json'),s);}}catch{}}}
  async start(input={}){await this.ready;const operation=this.serial.then(()=>this.startLocked(input));this.serial=operation.catch(()=>{});return operation;}
  async startLocked(input={}){if(this.active){if(input.schedule_occurrence){const existing=await this.status(this.active.id);if(existing.schedule_occurrence===input.schedule_occurrence)return {run_id:this.active.id,status:'running',existing:true};}throw new Error('DAILY_BUSY');}const date=input.date??dateInShanghai(this.clock());if(!validDate(date))throw new Error('INVALID_DATE');const occurrences=await readJson(path.join(this.runtime,'occurrences.json'),{});const occurrence=input.schedule_occurrence;if(occurrence&&occurrences[occurrence])return this.status(occurrences[occurrence]);
    if(input.project_dir&&path.resolve(input.project_dir)!==this.projectDir)throw new Error('PROJECT_DIRECTORY_MISMATCH');const config=await loadProject(this.projectDir,date);const id=randomUUID();const all=await this.list();const version=1+Math.max(0,...all.runs.filter(s=>s.date===date).map(s=>s.version));const ref=new Date(this.clock()).toISOString();
    const state={schema_version:1,run_id:id,date,version,status:'running',phase:'collecting',reference_time:ref,cutoff_time:new Date(Date.parse(ref)-config.config.lookback_days*86400000).toISOString(),config_hash:config.hash,started_at:ref,updated_at:ref,trigger:input.trigger??'manual',schedule_occurrence:occurrence??null,stages:{collection:'pending',analysis:'pending',archive:'pending',site:'pending',publication:'pending',notification:'pending'},queries:[],sources:[],article_count:0,errors:[],report_url:null,mode:input.mode??'full',owner_pid:process.pid};
    await writeJson(path.join(this.runDir(id),'snapshot.json'),config);await writeJson(path.join(this.runDir(id),'state.json'),state);if(occurrence){occurrences[occurrence]=id;await writeJson(path.join(this.runtime,'occurrences.json'),occurrences);}this.launch(state,config);return {run_id:id,date,version,status:'running'};
  }
  launch(state,snapshot){const controller=new AbortController();const active={id:state.run_id,controller};this.active=active;state.budget_started_at=new Date().toISOString();
    const budgetMs=Math.max(1,Number(snapshot.config?.collection?.runtime_minutes??480))*60000;
    // Budget is per launch: a resumed run must get a fresh allowance, not one already consumed by the earlier attempt.
    const budgetFrom=Date.parse(state.budget_started_at??state.started_at??new Date().toISOString());
    const elapsed=Number.isFinite(budgetFrom)?Math.max(0,Date.now()-budgetFrom):0;
    const remaining=Math.max(1000,budgetMs-elapsed);
    const deadline=AbortSignal.timeout(remaining);
    const signal=AbortSignal.any([controller.signal,deadline]);
    deadline.addEventListener('abort',()=>{state.deadline_armed=true;if(!controller.signal.aborted)state.stop_reason='RUNTIME_BUDGET_EXCEEDED';},{once:true});
    state.deadline_armed=true;
    active.deadline=deadline;
    active.done=this.execute(state,snapshot,signal).catch(async e=>{
      if(state.stop_reason==='RUNTIME_BUDGET_EXCEEDED'){state.status=state.status==='complete'?'partial':state.status;}
      else if(controller.signal.aborted)state.status=String(controller.signal.reason?.message)==='PLUGIN_UNLOADED'?'interrupted':'cancelled';
      else state.status='failed';
      state.stop_reason=state.stop_reason??safeError(e);state.phase='finished';state.updated_at=new Date().toISOString();await writeJson(path.join(this.runDir(state.run_id),'state.json'),state);}).finally(()=>{if(this.active===active)this.active=null;});}
  async status(id){await this.ready;const s=await readJson(path.join(this.runDir(id),'state.json'));if(!s)throw new Error('RUN_NOT_FOUND');return s;}
  async list(){await this.ready;const runs=[];for(const id of await fs.readdir(path.join(this.runtime,'runs'))){try{const s=await readJson(path.join(this.runDir(id),'state.json'));if(s)runs.push(s);}catch{}}return {runs:runs.sort((a,b)=>Date.parse(b.started_at)-Date.parse(a.started_at))};}
  async cancel(id){await this.ready;if(this.active?.id===id){this.active.controller.abort(new Error('CANCELLED'));await this.active.done;}return this.status(id);}
  async resume(id,stage){await this.ready;const operation=this.serial.then(()=>this.resumeLocked(id,stage));this.serial=operation.catch(()=>{});return operation;}
  async resumeLocked(id,stage){if(this.active)throw new Error('BUSY');const state=await this.status(id);if(state.status==='complete')return state;const snapshot=await readJson(path.join(this.runDir(id),'snapshot.json'));if(!snapshot)throw new Error('SNAPSHOT_NOT_FOUND');state.status='running';state.stop_reason=null;if(!stage){delete state.retry_stage;if(['complete','partial'].includes(state.stages.archive)){const all=await this.list();state.version=1+Math.max(...all.runs.filter(r=>r.date===state.date).map(r=>r.version));state.stages.archive='pending';state.stages.site='pending';state.stages.publication='pending';state.stages.notification='pending';}}if(stage&&['publication','notification'].includes(stage)){state.retry_stage=stage;state.stages[stage]='pending';}await writeJson(path.join(this.runDir(id),'state.json'),state);this.launch(state,snapshot);return state;}
  /** Keep the run history bounded. Each run keeps a full articles.json (a few MB), so an unbounded
   *  history would grow without limit. Archives under reports/ are the durable record; runtime runs
   *  are only diagnostics. */
  async pruneRuns({keep=20}={}){
    await this.ready;
    const dirRoot=path.join(this.runtime,'runs');
    let ids;
    try{ids=await fs.readdir(dirRoot);}catch{return {removed:0};}
    const rows=[];
    for(const id of ids){
      try{const st=await readJson(path.join(this.runDir(id),'state.json'));rows.push({id,started:Date.parse(st?.started_at??0)});}
      catch{rows.push({id,started:0});}
    }
    rows.sort((a,b)=>b.started-a.started);
    let removed=0;
    for(const row of rows.slice(Math.max(1,keep))){
      if(this.active?.id===row.id)continue;
      try{await fs.rm(path.join(this.runDir(row.id)),{recursive:true,force:true});removed+=1;}catch{/* leave it for next time */}
    }
    return {removed,kept:Math.min(rows.length,keep)};
  }
  async dispose(){if(this.active){this.active.controller.abort(new Error('PLUGIN_UNLOADED'));await this.active.done;}}
  /** The WeChat collector releases its single-slot lock asynchronously after a job reaches a terminal state.
   *  Retry a short, bounded number of times instead of failing every remaining query of the day.
   *  NEVER attempts to restart or relaunch WeChat: the user cannot re-login unattended, so a dead client
   *  must fail fast and leave the run blocked for a human to fix. */
  async startWechatWithHandoff(input,options,{attempts=12,delayMs=15000}={}){
    let lastError;
    for(let n=0;n<attempts;n++){
      checkAbort(options?.signal);
      try{return await this.wechat.start(input,options);}
      catch(e){
        checkAbort(options?.signal);
        lastError=e;
        const message=String(e?.message??e);
        // A missing/closed WeChat client needs a human to sign in again. Do not retry and do not relaunch.
        if(/WECHAT_NOT_LOGGED_IN_OR_NOT_RUNNING|NOT_LOGGED|VERSION_UNSUPPORTED/.test(message)){
          throw Object.assign(new Error('WECHAT_CLIENT_UNAVAILABLE_HUMAN_REQUIRED'),{code:'WECHAT_CLIENT_UNAVAILABLE',detail:message});
        }
        const busy=/已有微信采集任务|存在未结束的微信采集任务|BUSY/.test(message);
        if(!busy)throw e;
        const jobId=String(e?.data?.job_id??'');
        if(jobId){
          try{const s=await this.wechat.status(jobId);if(s&&!['running','starting','cancelling'].includes(s.status))throw e;}catch(inner){if(inner===e)throw e;}
        }
        await sleep(delayMs,options?.signal);
      }
    }
    throw lastError;
  }
  /** Run a stage that may be cut short by the runtime budget. A budget abort stops the stage but the
   *  run must continue to archive/publish whatever it did complete, because publish_partial is on. */
  async stageGuarded(stage,state,signal,fn){
    try{await fn();}
    catch(e){
      checkAbort(signal);
      throw e;
    }
    return state.stages[stage];
  }
  async execute(state,snapshot,signal){const dir=this.runDir(state.run_id);const save=async()=>{state.updated_at=new Date().toISOString();await writeJson(path.join(dir,'state.json'),state);};const cfg=snapshot.config;const articlesFile=path.join(dir,'articles.json');let articles=await readJson(articlesFile,[]);const known=await readJson(path.join(this.runtime,'article-index.json'),{});
    // A runtime-budget abort must not discard completed work: catch it per stage and fall through to publishing.
    // The deadline listener sets stop_reason, but the abort can surface before that assignment is visible,
    // so also treat "signal aborted while a deadline was armed" as a budget stop.
    const budgetExceeded=()=>state.stop_reason==='RUNTIME_BUDGET_EXCEEDED'||(signal.aborted&&!!state.deadline_armed);
    const softStage=async(fn)=>{try{await fn();}catch(e){if(!budgetExceeded())throw e;}};
    await softStage(async()=>{
    if(state.stages.collection!=='complete' && !state.retry_stage){
      state.phase='collecting';state.stages.collection='running';await save();const merged=new Map(articles.map(a=>[a.id,a]));
      const add=(record,query,source)=>{const url=normalizedUrl(record.url);const id=record.identity??'url:'+sha256(url);let a=merged.get(id);if(!a){a={...record,id,url,original_title:record.title,title:sanitizeTitle(record),language:record.language??query?.language??'zh',topics:record.topics??[query?.topic??source?.topic??'技术应用与新探索'],matched_queries:[],source_ids:[],first_seen:known[id]?.first_seen??state.reference_time};merged.set(id,a);}if(query&&!a.matched_queries.includes(query.id))a.matched_queries.push(query.id);if(source&&!a.source_ids.includes(source.id))a.source_ids.push(source.id);if(!a.body_text&&record.body_text)Object.assign(a,{body_text:record.body_text,body_status:record.body_status,body_complete:record.body_complete});};
      // Analysis runs alongside collection instead of after it: the collector is bound to one WeChat
      // window, so collection stays serial, but model review needs no desktop and can overlap.
      const analysisSelection=cfg.analysis.use_host_default_model?this.selection():cfg.analysis.model;
      const earlyReviewer=new ArticleReviewer({llm:this.llm,selection:analysisSelection,policy:snapshot.policy,cacheDir:path.join(this.runtime,'analysis-cache'),config:cfg.analysis,signal,onUsage:(usage,calls)=>{state.model_calls=calls;state.token_usage=state.token_usage??{input:0,output:0};state.token_usage.input+=usage?.inputTokens??0;state.token_usage.output+=usage?.outputTokens??0;}});
      const collectorSettings={timeout_minutes:snapshot.tuning?.per_query_timeout_minutes,delay_ms:snapshot.tuning?.delay_ms,max_retries:1};
      const analysisSlots=Math.max(1,Number(cfg.analysis.concurrency??8));
      let analysisRunning=0;const analysisJobs=[];
      const analyzeBatch=async(batch)=>{
        analysisRunning+=1;
        try{
          if(!batch||!batch.length)return;
          const needsBody=batch.filter(a=>!(a.analysis&&!a.analysis.processing_error&&a.body_text&&a.body_complete)&&!a.account?.startsWith('arxiv')&&a.url&&!a.url.includes('mp.weixin.qq.com'));
          await mapLimit(needsBody,Math.max(2,cfg.analysis.concurrency*4),async a=>{checkAbort(signal);Object.assign(a,await readWebBody(a,{fetchText:this.fetchText,signal}));},signal);
          const todo=batch.filter(a=>!(a.analysis&&!a.analysis.processing_error&&a.body_text&&a.body_complete));
          const batchSize=Math.max(1,Number(cfg.analysis.batch_size??6));
          const groups=[];for(let i=0;i<todo.length;i+=batchSize)groups.push(todo.slice(i,i+batchSize));
          await mapLimit(groups,Math.max(1,cfg.analysis.concurrency),async group=>{
            checkAbort(signal);
            const forward=[];
            for(const a of group){
              const old=known[a.id];
              const bodyFingerprint=sha256(a.body_text??'');
              const reviewFingerprint=sha256({body:bodyFingerprint,policy:snapshot.policy,selection:analysisSelection});
              if(old?.analysis&&!old.analysis.processing_error&&a.body_complete===true&&old.body_fingerprint===bodyFingerprint&&old.review_fingerprint===reviewFingerprint){a.analysis=old.analysis;a.repeated=!!old.reported_on?.length;continue;}
              a.__reviewFingerprint=reviewFingerprint;forward.push(a);
            }
            let reviewed=new Map();
            if(forward.length){
              try{reviewed=await earlyReviewer.reviewBatch(forward);}
              catch(e){checkAbort(signal);for(const a of forward)a.analysis={article_id:a.id,status:'uncertain',summary_zh:'内容处理未完成，保留原文供查看。',reason:safeError(e),topics:a.topics??[],evidence_quotes:[],event_key:'',confidence:0,body_basis:a.body_basis??'正文',processing_error:true};}
            }
            for(const a of group){
              if(reviewed.has(a.id))a.analysis=reviewed.get(a.id);
              const old=known[a.id];
              a.content_fingerprint=sha256(a.body_text??'');
              a.repeated=!!old?.reported_on?.length&&old.body_fingerprint===a.content_fingerprint;
              known[a.id]={first_seen:old?.first_seen??state.reference_time,body_fingerprint:a.content_fingerprint,review_fingerprint:a.__reviewFingerprint??(old?.review_fingerprint??null),analysis:a.analysis,reported_on:old?.reported_on??[]};
              delete a.__reviewFingerprint;
            }
          },signal);
        }finally{analysisRunning-=1;}
      };
      // Hand newly collected articles to the model without blocking the next query; apply back
      // pressure only when every analysis slot is busy.
      const enqueueAnalysis=async(batch)=>{
        if(!batch||!batch.length)return;
        const job=analyzeBatch(batch);
        analysisJobs.push(job);
        if(analysisRunning>=analysisSlots){await Promise.race(analysisJobs).catch(()=>{});}
      };
      if(cfg.collection.wechat){let consecutiveFailures=0;for(const query of snapshot.queries){checkAbort(signal);let q=state.queries.find(x=>x.id===query.id);if(q?.status==='complete')continue;q={id:query.id,keyword:query.keyword,language:query.language,topic:query.topic,status:'running'};state.queries=state.queries.filter(x=>x.id!==q.id);state.queries.push(q);await save();try{
        // Default is the proven single pass. Two-pass (list-only screen, then open only survivors)
        // Two passes is the default: pass 1 lists candidates without opening them, the model
        // pre-screens them, and pass 2 opens only survivors. This is what keeps junk like
        // "院士发言" from costing a full article open each. Set collection.two_pass=false to
        // fall back to opening every candidate (no pre-screening).
        const twoPass=cfg.collection.two_pass!==false;
        // Record which branch actually ran. Without this, "pre-screen never happened" and "the old
        // plugin generation was still loaded" look identical after the fact.
        state.two_pass_resolved=twoPass;
        if(!twoPass){
          const receipt=await this.startWechatWithHandoff({keyword:query.keyword,lookback_days:query.lookback_days},{reference_time:state.reference_time,include_body:true,signal,settings:collectorSettings});
          q.job_id=receipt.job_id;await save();const terminal=await this.wechat.wait(q.job_id,{signal});const result=await this.wechat.getResult(q.job_id);
          const before=merged.size;
          for(const a of result.records??[])add(a,query);
          q.trace=[{pass:'open_full',job_id:receipt.job_id,records:result.records?.length??0,stop:terminal.stop_reason??null}];
          q.status=terminal.coverage?.scope_complete?'complete':'partial';q.count=result.records?.length??0;q.stop_reason=terminal.stop_reason;state.article_count=merged.size;await writeJson(articlesFile,[...merged.values()]);await save();
          // Review what this query just produced while the next query is still being collected.
          await enqueueAnalysis([...merged.values()].slice(before));
        }else{
        // Pass 1: gather the whole result list without opening anything. Opening every article is the
        // expensive part, so we screen on title/account/snippet first and only open survivors.
        const listReceipt=await this.startWechatWithHandoff({keyword:query.keyword,lookback_days:query.lookback_days},{reference_time:state.reference_time,include_body:false,list_only:true,signal,settings:collectorSettings});
        const listTerminal=await this.wechat.wait(listReceipt.job_id,{signal});
        const listResult=await this.wechat.getResult(listReceipt.job_id);
        const listed=listResult.records??[];
        q.listed=listed.length;
        // Trace pass 1 so "listed=0" can be told apart from "pass 1 never ran".
        q.trace=[{pass:'list',job_id:listReceipt.job_id,records:listed.length,stop:listTerminal.stop_reason??null}];
        const prescreenEnabled=cfg.collection.prescreen!==false&&listed.length>0;
        let keepKeys=null;
        if(prescreenEnabled){
          const policy=cfg.analysis.prescreen_policy_file?await loadPrescreen(path.join(this.projectDir,cfg.analysis.prescreen_policy_file)):'';
          try{
            const verdicts=await prescreenCandidates({llm:this.llm,selection:this.selection(),policy,items:listed.map(r=>({key:candidateKey(r.title,r.account),title:r.title,account:r.account,relative_date:r.relative_date,snippet:r.snippet})),signal,onUsage:(u,c)=>{state.prescreen_calls=c;},batchSize:snapshot.tuning?.prescreen_batch_size,maxCalls:snapshot.tuning?.prescreen_max_calls});
            const kept=[...verdicts.values()].filter(v=>v.keep).length;
            state.prescreen={total:listed.length,kept,calls:state.prescreen_calls??0,error:null};
            q.trace.push({pass:'prescreen',total:listed.length,kept,calls:state.prescreen_calls??0,error:null});
            keepKeys=[...verdicts.entries()].filter(([,v])=>v.keep).map(([k])=>k);
            await writeJson(path.join(dir,'prescreen.json'),Object.fromEntries(verdicts));
          }catch(e){
            checkAbort(signal);
            // Pre-screen failure is a real gap: record it instead of silently opening everything.
            state.prescreen={total:listed.length,kept:null,calls:state.prescreen_calls??0,error:safeError(e)};
            q.trace.push({pass:'prescreen',total:listed.length,kept:null,calls:state.prescreen_calls??0,error:safeError(e)});
            keepKeys=null;
          }
        }else{
          q.trace.push({pass:'prescreen',skipped:true,reason:listed.length?'disabled':'empty_list'});
        }
        q.prescreened=keepKeys?keepKeys.length:null;
        await save();
        // Pass 2: open only what survived (or everything when pre-screening is off / failed).
        const receipt=await this.startWechatWithHandoff({keyword:query.keyword,lookback_days:query.lookback_days},{reference_time:state.reference_time,include_body:true,list_only:false,open_keys:keepKeys??undefined,signal,settings:collectorSettings});
        q.job_id=receipt.job_id;await save();const terminal=await this.wechat.wait(q.job_id,{signal});const result=await this.wechat.getResult(q.job_id);
        const beforeTwo=merged.size;
        for(const a of result.records??[])add(a,query);
        q.trace.push({pass:'open',job_id:receipt.job_id,records:result.records?.length??0,stop:terminal.stop_reason??null});
        // Review what this query just produced while the next query is still being collected.
        await enqueueAnalysis([...merged.values()].slice(beforeTwo));
        // Attach the pre-screen verdict so selection can dedupe by information point.
        if(prescreenEnabled){
          const verdicts=await readJson(path.join(dir,'prescreen.json'),{});
          for(const a of merged.values()){const v=verdicts[candidateKey(a.original_title??a.title,a.account)];if(v)a.prescreen=v;}
        }
        q.status=terminal.coverage?.scope_complete?'complete':'partial';q.count=result.records?.length??0;q.stop_reason=terminal.stop_reason;state.article_count=merged.size;await writeJson(articlesFile,[...merged.values()]);await save();
        }
      }catch(e){
          checkAbort(signal);
          q.status='failed';q.error=safeError(e);await save();
          // Circuit breaker: a dead WeChat client will fail every remaining query. Stop instead of hammering it.
          // Never relaunch WeChat - an unattended host cannot sign in again.
          const fatal=/WECHAT_CLIENT_UNAVAILABLE|WECHAT_NOT_LOGGED_IN_OR_NOT_RUNNING|NOT_LOGGED|DESKTOP_LOCKED|VERSION_UNSUPPORTED/.test(String(e?.message??e));
          if(fatal){state.stop_reason='WECHAT_CLIENT_UNAVAILABLE_HUMAN_REQUIRED';throw Object.assign(new Error('WECHAT_CLIENT_UNAVAILABLE_HUMAN_REQUIRED'),{code:'WECHAT_CLIENT_UNAVAILABLE'});}
          consecutiveFailures++;
          if(consecutiveFailures>=4){state.stop_reason='WECHAT_REPEATEDLY_FAILING_HUMAN_REQUIRED';throw Object.assign(new Error('WECHAT_REPEATEDLY_FAILING_HUMAN_REQUIRED'),{code:'WECHAT_REPEATEDLY_FAILING'});}
        }
        if(q.status!=='failed')consecutiveFailures=0;
      }}
      if(cfg.collection.first_party){for(const source of snapshot.sources){checkAbort(signal);if(state.sources.find(x=>x.id===source.id)?.status==='complete')continue;const beforeSource=merged.size;const result=await collectSource(source,state.cutoff_time,state.reference_time,{fetchText:this.fetchText,signal});for(const a of result.records??[])add(a,null,source);state.sources=state.sources.filter(x=>x.id!==source.id);state.sources.push({id:source.id,status:result.status,count:result.records.length,error:result.error??null,scope:source.scope});await writeJson(articlesFile,[...merged.values()]);await save();await enqueueAnalysis([...merged.values()].slice(beforeSource));}}
      // Collection is done; let every review started during collection finish before moving on.
      await Promise.all(analysisJobs).catch(()=>{});
      articles=[...merged.values()];state.article_count=articles.length;state.stages.collection=state.queries.some(q=>q.status!=='complete')||state.sources.some(s=>s.status!=='complete')?'partial':'complete';await writeJson(articlesFile,articles);await save();
    }
    });
    if(state.mode==='collect-only'){state.status=state.stages.collection==='complete'?'complete':'partial';state.phase='collected';await save();return;}
    await softStage(async()=>{
    if(state.stages.analysis!=='complete' && !state.retry_stage){
      state.phase='analysis';state.stages.analysis='running';await save();
      const selection=cfg.analysis.use_host_default_model?this.selection():cfg.analysis.model;const reviewer=new ArticleReviewer({llm:this.llm,selection,policy:snapshot.policy,cacheDir:path.join(this.runtime,'analysis-cache'),config:cfg.analysis,signal,onUsage:(usage,calls)=>{state.model_calls=calls;state.token_usage=state.token_usage??{input:0,output:0};state.token_usage.input+=usage?.inputTokens??0;state.token_usage.output+=usage?.outputTokens??0;}});
      // Fetch missing web bodies concurrently, then review in batches: one call covers several articles.
      const needsBody=articles.filter(a=>!(a.analysis&&!a.analysis.processing_error&&a.body_text&&a.body_complete)&&!a.account?.startsWith('arxiv')&&a.url&&!a.url.includes('mp.weixin.qq.com'));
      await mapLimit(needsBody,Math.max(2,cfg.analysis.concurrency*4),async a=>{checkAbort(signal);Object.assign(a,await readWebBody(a,{fetchText:this.fetchText,signal}));},signal);
      const todo=articles.filter(a=>!(a.analysis&&!a.analysis.processing_error&&a.body_text&&a.body_complete));
      const batchSize=Math.max(1,Number(cfg.analysis.batch_size??6));
      const groups=[];for(let i=0;i<todo.length;i+=batchSize)groups.push(todo.slice(i,i+batchSize));
      await mapLimit(groups,Math.max(1,cfg.analysis.concurrency),async group=>{
        checkAbort(signal);
        const reuse=[];
        const forward=[];
        for(const a of group){
          const old=known[a.id];
          const bodyFingerprint=sha256(a.body_text??'');
          const reviewFingerprint=sha256({body:bodyFingerprint,policy:snapshot.policy,selection});
          if(old?.analysis&&!old.analysis.processing_error&&a.body_complete===true&&old.body_fingerprint===bodyFingerprint&&old.review_fingerprint===reviewFingerprint){a.analysis=old.analysis;a.repeated=!!old.reported_on?.length;reuse.push(a);continue;}
          a.__reviewFingerprint=reviewFingerprint;forward.push(a);
        }
        let reviewed=new Map();
        if(forward.length){
          try{reviewed=await reviewer.reviewBatch(forward);}
          catch(e){checkAbort(signal);for(const a of forward)a.analysis={article_id:a.id,status:'uncertain',summary_zh:'内容处理未完成，保留原文供查看。',reason:safeError(e),topics:a.topics??[],evidence_quotes:[],event_key:'',confidence:0,body_basis:a.body_basis??'正文',processing_error:true};}
        }
        for(const a of group){
          if(reviewed.has(a.id))a.analysis=reviewed.get(a.id);
          const old=known[a.id];
          a.content_fingerprint=sha256(a.body_text??'');
          a.repeated=!!old?.reported_on?.length&&old.body_fingerprint===a.content_fingerprint;
          known[a.id]={first_seen:old?.first_seen??state.reference_time,body_fingerprint:a.content_fingerprint,review_fingerprint:a.__reviewFingerprint??(old?.review_fingerprint??null),analysis:a.analysis,reported_on:old?.reported_on??[]};
          delete a.__reviewFingerprint;
        }
        await writeJson(articlesFile,articles);await save();
      },signal);
      state.stages.analysis=articles.some(a=>a.analysis?.processing_error||!a.body_text||!a.analysis||a.analysis?.body_complete===false)?'partial':'complete';await writeJson(path.join(this.runtime,'article-index.json'),known);await writeJson(articlesFile,articles);await save();
    }
    });
    articles=await readJson(articlesFile,[]);
    // The budget abort already fired; the publishing tail must still be able to write, commit and publish.
    const tailSignal=signal.aborted?undefined:signal;
    const coverage={queries_planned:cfg.collection.wechat?snapshot.queries.length:0,queries_complete:state.queries.filter(q=>q.status==='complete').length,queries_failed:state.queries.filter(q=>q.status==='failed').length,queries_partial:state.queries.filter(q=>q.status==='partial').length,zh_complete:state.queries.filter(q=>q.language==='zh'&&q.status==='complete').length,en_complete:state.queries.filter(q=>q.language==='en'&&q.status==='complete').length,sources_planned:cfg.collection.first_party?snapshot.sources.length:0,sources_complete:state.sources.filter(s=>s.status==='complete').length,source_failures:state.sources.filter(s=>s.status!=='complete').map(s=>s.id),articles_total:articles.length,body_unread:articles.filter(a=>!a.body_text).length,analysis_pending:articles.filter(a=>!a.analysis||a.analysis.processing_error).length,technical:articles.filter(a=>a.analysis?.status==='technical').length,uncertain:articles.filter(a=>a.analysis?.status==='uncertain').length,promotional:articles.filter(a=>a.analysis?.status==='promotional').length,global_complete:false,partial:state.stages.collection!=='complete'||state.stages.analysis!=='complete'};
    const fresh=articles.filter(a=>!a.repeated);
    // Stage L5: collapse to distinct information points, then apply the 7:2:1 budget. The target is a
    // constraint that drives out low-value content, not a quota to be padded.
    const eligible=fresh.filter(a=>a.analysis?.status!=='promotional');
    const chosen=selectEdition(eligible,{target:Math.max(1,Number(cfg.selection?.target??30)),minScore:snapshot.tuning?.min_score});
    state.selection=chosen.stats;
    const publicArticles=chosen.articles.map(a=>({id:a.id,title:a.title,url:a.url,author:a.author??'',account:a.account??'',date:a.date,language:a.language,categories:a.analysis?.topics?.length?a.analysis.topics:a.topics,status:a.analysis?.status??'uncertain',summary:a.analysis?.summary_zh??'',readStatus:a.body_status??'unavailable',reason:a.analysis?.reason??'',point:a.prescreen?.point??'',category:a.prescreen?.category??'none'}));
    const publicCoverage={...coverage,complete:!coverage.partial,status:coverage.partial?'partial':'complete',plannedQueries:coverage.queries_planned,completedQueries:coverage.queries_complete,partialQueries:coverage.queries_partial,failedQueries:coverage.queries_failed,candidates:coverage.articles_total,processedArticles:articles.filter(a=>a.analysis).length,unreadArticles:coverage.body_unread,note:`英文一手来源${coverage.sources_complete}/${coverage.sources_planned}完成；中文查询${coverage.zh_complete}，英文查询${coverage.en_complete}。${coverage.source_failures.length?'未成功来源：'+coverage.source_failures.join('、')+'。':''}所有候选私有留存，公开页不包含全文。`,byLanguage:{zh:{planned:snapshot.queries.filter(q=>q.language==='zh').length,completed:coverage.zh_complete,failed:state.queries.filter(q=>q.language==='zh'&&q.status==='failed').length},en:{planned:snapshot.queries.filter(q=>q.language==='en').length,completed:coverage.en_complete,failed:state.queries.filter(q=>q.language==='en'&&q.status==='failed').length}}};
    const edition={date:state.date,version:state.version,title:cfg.title,overview:`候选${chosen.stats.candidates}篇，去重后${chosen.stats.uniquePoints}个信息点，精选${chosen.stats.selected}篇（应用${chosen.stats.counts.application}／模型${chosen.stats.counts.model}／硬件${chosen.stats.counts.hardware}）。`,events:groupEvents(chosen.articles).map(e=>({...e,categories:e.topics})),articles:publicArticles,coverage:publicCoverage};
    if(state.stages.archive!=='complete'){
      // Archive directory is <date>-<num> so a day with several runs (tests, retries, resumes) keeps
      // every edition instead of overwriting one directory.
      state.phase='archiving';const dest=path.join(this.projectDir,'reports',`${state.date}-${state.version}`);await fs.mkdir(dest,{recursive:true});const publicEdition=edition;
      await writeText(path.join(dest,'daily.md'),renderMarkdown(publicEdition));await writeJson(path.join(dest,'public.json'),publicEdition);await writeJson(path.join(dest,'manifest.json'),{date:state.date,version:state.version,run_id:state.run_id,coverage,config_hash:state.config_hash});state.archive_path=dest;
      if(cfg.git.commit_reports){const git=cfg.git.executable;for(const argv of [[git,'add','--',path.relative(this.projectDir,dest)],[git,'diff','--cached','--quiet']]){const r=await this.runProcess({argv,cwd:this.projectDir,signal:tailSignal});if(argv.includes('diff')&&r.exitCode===1){const c=await this.runProcess({argv:[git,'commit','-m',`daily: ${state.date} v${state.version}`],cwd:this.projectDir,signal:tailSignal});if(c.exitCode!==0)throw new Error('ARCHIVE_GIT_COMMIT_FAILED');state.archive_commit=true;}else if(r.exitCode!==0)throw new Error('ARCHIVE_GIT_FAILED');}}
      // Persist the terminal archive state first, then mark articles reported: a crash here repeats rather than drops articles.
      state.stages.archive='complete';await save();
      for(const a of publicArticles){if(known[a.id])known[a.id].reported_on=[...new Set([...(known[a.id].reported_on??[]),state.date])];}await writeJson(path.join(this.runtime,'article-index.json'),known);await save();
    }
    if(state.stages.site!=='complete'){state.phase='rendering';const rendered=await renderSite({siteDir:path.join(this.projectDir,'site'),edition,publicBaseUrl:cfg.publishing.public_base_url});state.report_url=rendered.reportUrl;state.stages.site='complete';await save();}
    if(cfg.publishing.enabled&&state.stages.publication!=='complete'){
      state.phase='publishing';try{const publisher=new PublishGithub({siteDir:path.join(this.projectDir,'site'),repository:cfg.publishing.repository,branch:cfg.publishing.branch,publicBaseUrl:cfg.publishing.public_base_url,gitExecutable:cfg.git.executable,runProcess:this.runProcess});const result=await publisher.publish({date:state.date,version:state.version,signal:tailSignal});state.publication=result;state.report_url=result.publishedUrl??result.reportUrl??state.report_url;state.stages.publication=result.status==='published'&&result.verified===true?'complete':'blocked';}catch(e){checkAbort(signal);state.stages.publication='failed';state.errors.push({stage:'publication',reason:safeError(e)});}await save();
    }else if(!cfg.publishing.enabled)state.stages.publication='disabled';
    if(cfg.notification.enabled&&state.stages.publication==='complete'&&state.stages.notification!=='complete'){
      state.phase='notifying';const deliveryKey=sha256({project:cfg.id,date:state.date,version:state.version,target:cfg.notification});const deliveries=await readJson(path.join(this.runtime,'deliveries.json'),{});if(deliveries[deliveryKey]?.status==='sent'){state.stages.notification='complete';}else if(deliveries[deliveryKey]?.status==='unknown'){state.stages.notification='blocked';state.errors.push({stage:'notification',reason:'PREVIOUS_DELIVERY_OUTCOME_UNKNOWN'});}else{
        const adapter=this.imAdapter??createImAdapter(this.ctx);const target=await resolveDelivery(this.ctx,{...cfg.notification,botId:cfg.notification.bot_id,targetId:cfg.notification.target_id,adapter});if(!target.ready){state.stages.notification='blocked';state.notification=target;}else{deliveries[deliveryKey]={status:'unknown',at:new Date().toISOString(),run_id:state.run_id};await writeJson(path.join(this.runtime,'deliveries.json'),deliveries);try{const result=await adapter.sendNotification({botId:target.botId,targetId:target.targetId,text:`${state.date} AI技术日报\n${edition.overview}\n${coverage.partial?'本期有检索或正文处理缺口，请见覆盖说明。\n':''}${state.report_url}`,signal:tailSignal});if(result.sent===true){deliveries[deliveryKey].status='sent';state.stages.notification='complete';state.notification={sent:true,botId:target.botId,targetId:target.targetId};}else{deliveries[deliveryKey].status=result.uncertain?'unknown':'failed';state.stages.notification='blocked';state.notification=result;} }catch(e){checkAbort(signal);state.stages.notification='failed';state.errors.push({stage:'notification',reason:safeError(e)});}await writeJson(path.join(this.runtime,'deliveries.json'),deliveries);}}
      await save();
    }else if(!cfg.notification.enabled)state.stages.notification='disabled';
    state.phase='finished';state.coverage=coverage;state.status=Object.values(state.stages).some(s=>['failed','blocked','pending'].includes(s))?'blocked':coverage.partial?'partial':'complete';
    if(budgetExceeded()&&state.status==='complete')state.status='partial';
    await save();
    // Diagnostics are bounded: after the run is safely finished, drop the oldest run directories.
    // Never fatal - a cleanup failure must not turn a good run into a failed one.
    try{const pruned=await this.pruneRuns({keep:20});if(pruned.removed)state.runs_pruned=pruned.removed;}catch{/* ignore */}
    await save();
  }
}

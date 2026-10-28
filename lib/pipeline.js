import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readJson,writeJson,writeText,sha256,dateInShanghai,validDate,TERMINAL,safeError,checkAbort,mapLimit,sleep} from './io.js';
import {prescreenCandidates,loadPolicy as loadPrescreen,candidateKey} from './prescreen.js';
import {selectEdition,toRows} from './selection.js';
import {chooseEdition} from './edition-select.js';
import {judgeRepeats} from './repeat-judge.js';
import {pruneExpired} from './retention.js';
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
  /** Runs left in `running` by a crash or an older plugin generation are noise, not work in progress.
   *  Mark them cancelled so history stays honest and no manual cleanup is needed. */
  async reconcileStaleRuns(){
    await this.ready;
    const dirRoot=path.join(this.runtime,'runs');
    let ids;try{ids=await fs.readdir(dirRoot);}catch{return 0;}
    let fixed=0;
    for(const id of ids){
      if(this.active?.id===id)continue;
      const p=path.join(this.runDir(id),'state.json');
      let st;try{st=await readJson(p);}catch{continue;}
      if(!st||st.status!=='running')continue;
      st.status='cancelled';st.stop_reason=st.stop_reason??'STALE_RUN_RECONCILED';st.phase='finished';st.updated_at=new Date().toISOString();
      try{await writeJson(p,st);fixed+=1;}catch{/* next run retries */}
    }
    return fixed;
  }
  async startLocked(input={}){if(this.active){if(input.schedule_occurrence){const existing=await this.status(this.active.id);if(existing.schedule_occurrence===input.schedule_occurrence)return {run_id:this.active.id,status:'running',existing:true};}throw new Error('DAILY_BUSY');}await this.reconcileStaleRuns().catch(()=>{});
    // Expired diagnostics are dropped before anything new is written, so a month of runs never
    // accumulates into a full disk. Published reports and the dedupe index are never touched.
    try{
      const current=await loadProject(this.projectDir,dateInShanghai(this.clock()));
      const days=current.config.retention?.temp_retention_days;
      if(days){
        const pruned=await pruneExpired({runtimeDir:this.runtime,runsDir:path.join(this.runtime,'runs'),retentionDays:days,clock:this.clock});
        if(pruned.runs||pruned.files)this.lastPrune=pruned;
      }
    }catch{/* cleanup must never block a run */}const date=input.date??dateInShanghai(this.clock());if(!validDate(date))throw new Error('INVALID_DATE');const occurrences=await readJson(path.join(this.runtime,'occurrences.json'),{});const occurrence=input.schedule_occurrence;if(occurrence&&occurrences[occurrence])return this.status(occurrences[occurrence]);
    if(input.project_dir&&path.resolve(input.project_dir)!==this.projectDir)throw new Error('PROJECT_DIRECTORY_MISMATCH');
    // Validate the override here too: a resumed run reaches this path without passing through the tool schema.
    if(input.lookback_days!==undefined&&(!Number.isInteger(input.lookback_days)||input.lookback_days<1||input.lookback_days>7))throw new Error('INVALID_LOOKBACK');
    let config=await loadProject(this.projectDir,date);
    // A caller may override the window for this run only: the scheduled task keeps the project's
    // 24h default, while an ad-hoc run can ask for 48h or 72h without editing configuration.
    if(Number.isInteger(input.lookback_days)&&input.lookback_days>=1&&input.lookback_days<=7&&input.lookback_days!==config.config.lookback_days){
      const override=input.lookback_days;
      config={...config,config:{...config.config,lookback_days:override},queries:config.queries.map((q)=>({...q,lookback_days:q.cadence==='rotate'?7:override})),hash:sha256({...config,lookback_days:override,override})};
    }
    const id=randomUUID();const all=await this.list();const version=1+Math.max(0,...all.runs.filter(s=>s.date===date).map(s=>s.version));const ref=new Date(this.clock()).toISOString();
    const state={schema_version:1,run_id:id,date,version,status:'running',phase:'collecting',reference_time:ref,cutoff_time:new Date(Date.parse(ref)-config.config.lookback_days*86400000).toISOString(),config_hash:config.hash,started_at:ref,updated_at:ref,trigger:input.trigger??'manual',schedule_occurrence:occurrence??null,stages:{collection:'pending',analysis:'pending',archive:'pending',site:'pending',publication:'pending',notification:'pending'},queries:[],sources:[],article_count:0,errors:[],report_url:null,mode:input.mode??'full',lookback_days:config.config.lookback_days,owner_pid:process.pid};
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
    active.done=this.execute(state,snapshot,signal).then(async()=>{
      // execute() swallows a budget/cancel abort inside softStage, so it can return normally even
      // though we were cancelled. Without this, a cancelled run kept status=running on disk and had
      // to be cleaned by hand every time.
      if(controller.signal.aborted&&!['cancelled','interrupted','failed'].includes(state.status)){
        state.status=String(controller.signal.reason?.message)==='PLUGIN_UNLOADED'?'interrupted':'cancelled';
        state.stop_reason=state.stop_reason??safeError(controller.signal.reason);
        state.phase='finished';state.updated_at=new Date().toISOString();
        await writeJson(path.join(this.runDir(state.run_id),'state.json'),state);
        return;
      }
    }).catch(async e=>{
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
  async pruneRuns({keep=10}={}){
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
      const collectorSettings={timeout_minutes:snapshot.tuning?.per_query_timeout_minutes,delay_ms:snapshot.tuning?.delay_ms,max_retries:1,boundary_slack_hours:snapshot.tuning?.boundary_slack_hours};
      const analysisSlots=Math.max(1,Number(cfg.analysis.concurrency??8));
      let analysisRunning=0;const analysisJobs=[];
      // Timeline evidence for the pipeline claim: it records when each analysis batch starts and ends
      // relative to collection, so "opened while analysing" can be shown instead of asserted.
      // Bounded (last 60 events) and timestamps only, so it cannot grow the state file.
      const nowMs=()=>Date.now();
      const timelineStart=nowMs();
      const markEvent=(entry)=>{state.timeline=Array.isArray(state.timeline)?state.timeline:[];state.timeline.push({t:nowMs()-timelineStart,...entry});if(state.timeline.length>60)state.timeline=state.timeline.slice(-60);};
      const analyzeBatch=async(batch)=>{
        analysisRunning+=1;
        const evStart=markEvent({kind:'analysis_start',articles:batch?.length??0,slotsBusy:analysisRunning});
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
          markEvent({kind:'analysis_end',articles:batch.length,slotsBusy:analysisRunning,ok:true});
        }catch(e){
          markEvent({kind:'analysis_end',articles:batch?.length??0,slotsBusy:analysisRunning,ok:false,error:safeError(e)});
          throw e;
        }finally{analysisRunning-=1;}
      };
      // Hand newly collected articles to the model without blocking the next query; apply back
      // pressure only when every analysis slot is busy.
      const enqueueAnalysis=async(batch)=>{
        if(!batch||!batch.length)return;
        markEvent({kind:'enqueue',articles:batch.length,slotsBusy:analysisRunning});
        const job=analyzeBatch(batch);
        analysisJobs.push(job);
        if(analysisRunning>=analysisSlots){await Promise.race(analysisJobs).catch(()=>{});}
      };
      if(cfg.collection.wechat){const pool=[];let poolFile=null;let consecutiveFailures=0;for(const query of snapshot.queries){checkAbort(signal);let q=state.queries.find(x=>x.id===query.id);if(q?.status==='complete')continue;q={id:query.id,keyword:query.keyword,language:query.language,topic:query.topic,status:'running'};state.queries=state.queries.filter(x=>x.id!==q.id);state.queries.push(q);await save();try{
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
        // Step 1-2: search the keyword and take its result list, newest first. The collector already
        // returns rows with age_seconds, so ordering and window tests need no article to be opened.
        const listReceipt=await this.startWechatWithHandoff({keyword:query.keyword,lookback_days:query.lookback_days},{reference_time:state.reference_time,include_body:false,list_only:true,signal,settings:collectorSettings});
        const listTerminal=await this.wechat.wait(listReceipt.job_id,{signal});
        const listResult=await this.wechat.getResult(listReceipt.job_id);
        const listed=(listResult.records??[]).slice().sort((a,b)=>(a.age_seconds??Infinity)-(b.age_seconds??Infinity));
        q.listed=listed.length;
        q.trace=[{pass:'list',job_id:listReceipt.job_id,records:listed.length,stop:listTerminal.stop_reason??null}];
        // Step 3: window pre-check. A row whose age exceeds the window can never be published, so
        // filtering it here saves both a model call and an article open. The test is arithmetic, not
        // a judgement about content, so the code owns it.
        const windowSeconds=Math.max(1,Number(query.lookback_days??cfg.lookback_days??1))*86400;
        const inWindow=listed.filter((r)=>Number.isFinite(r.age_seconds)&&r.age_seconds<=windowSeconds);
        q.in_window=inWindow.length;
        if(!inWindow.length){
          // Nothing recent for this keyword: skip screening and opening entirely.
          q.trace.push({pass:'window',total:listed.length,in_window:0,skipped:true});
          q.status='complete';q.count=0;await save();
          consecutiveFailures=0;
          continue;
        }
        q.trace.push({pass:'window',total:listed.length,in_window:inWindow.length});
        await writeJson(path.join(dir,`window-${query.id}.json`),{keyword:query.keyword,updated_at:new Date().toISOString(),candidates:inWindow});
        pool.push({query,records:inWindow});
        q.status='complete';q.count=0;await save();
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
      }
      // Steps 3-5: for each keyword in turn, screen the in-window list and then open only what the
      // model kept. This is the human workflow: search, look at the recent ones, screen them, read
      // them, move to the next keyword. A keyword with no recent rows never reaches this loop.
      if(cfg.collection.prescreen!==false) state.phase='prescreening';
      for(const entry of pool){
        checkAbort(signal);
        const query=entry.query;
        const q=state.queries.find(x=>x.id===query.id);
        if(!q)continue;
        const policy=cfg.analysis.prescreen_policy_file?await loadPrescreen(path.join(this.projectDir,cfg.analysis.prescreen_policy_file)):'';
        let keepKeys=[];
        try{
          const verdicts=await prescreenCandidates({
            llm:this.llm,selection:this.selection(),policy,categories:snapshot.categories,
            items:entry.records.map((record)=>({key:candidateKey(record.title,record.account),title:record.title,account:record.account,relative_date:record.relative_date,snippet:record.snippet,keyword:query.keyword})),
            signal,onUsage:(u,c)=>{state.prescreen_calls=c;},maxCalls:snapshot.tuning?.prescreen_max_calls,
          });
          keepKeys=entry.records.map((r)=>candidateKey(r.title,r.account)).filter((k)=>verdicts.get(k)?.keep);
          state.prescreen={total:entry.records.length,kept:keepKeys.length,calls:state.prescreen_calls??0,error:null};
          q.prescreened=keepKeys.length;
          q.trace=q.trace??[];q.trace.push({pass:'prescreen',total:entry.records.length,kept:keepKeys.length,calls:state.prescreen_calls??0,error:null});
          await writeJson(path.join(dir,`prescreen-${query.id}.json`),Object.fromEntries(verdicts));
        }catch(e){
          checkAbort(signal);
          state.prescreen={total:entry.records.length,kept:null,calls:state.prescreen_calls??0,error:safeError(e)};
          q.trace=q.trace??[];q.trace.push({pass:'prescreen',total:entry.records.length,kept:null,error:safeError(e)});
          keepKeys=entry.records.map((r)=>candidateKey(r.title,r.account));
        }
        await save();
        if(!keepKeys.length){
          q.trace.push({pass:'open',skipped:true,reason:'no_kept_candidates'});
          await save();
          continue;
        }
        // Step 4 lives inside the Phase B loop below; record the keep-list for it.
        entry.keepKeys=keepKeys;
      }

      // Phase B: open each query's survivors. Opening needs the search window again, so this is one
      // pass per query with a keep-list; each opened article goes straight to the model.
      for(const entry of pool){
        checkAbort(signal);
        const query=entry.query;
        const keepKeys=entry.keepKeys??[];
        const q=state.queries.find(x=>x.id===query.id);
        if(!q)continue;
        if(!keepKeys.length){
          // Nothing survived for this query: record it and skip the expensive open pass entirely.
          q.trace=q.trace??[];q.trace.push({pass:'open',skipped:true,reason:'no_kept_candidates'});
          q.count=0;await save();continue;
        }
        try{
          const beforeTwo=merged.size;
          const receipt=await this.startWechatWithHandoff({keyword:query.keyword,lookback_days:query.lookback_days},{reference_time:state.reference_time,include_body:true,list_only:false,open_keys:keepKeys??undefined,signal,settings:collectorSettings});
          q.job_id=receipt.job_id;await save();
          let checkpointFile=null;
          try{checkpointFile=this.wechat.checkpointPath?.(receipt.job_id)??null;}catch{checkpointFile=null;}
          const handled=new Set();
          let openedCount=0;
          const harvest=async()=>{
            if(!checkpointFile)return;
            let cp=null;
            try{cp=await readJson(checkpointFile,null);}catch{cp=null;}
            const recs=Array.isArray(cp?.records)?cp.records:[];
            const freshRecs=[];
            for(const rec of recs){
              const id=rec?.identity??(rec?.url?('url:'+sha256(rec.url)):null);
              if(!id||handled.has(id))continue;
              // Outside-window rows carry no body; reviewing them scored nothing.
              if(rec.within_window!==true||rec.body_complete!==true)continue;
              handled.add(id);freshRecs.push(rec);
            }
            if(!freshRecs.length)return;
            for(const rec of freshRecs)add(rec,query);
            openedCount+=freshRecs.length;
            await enqueueAnalysis([...merged.values()].slice(beforeTwo).filter(a=>!a.analysis));
            await writeJson(articlesFile,[...merged.values()]);
          };
          const poll=setInterval(()=>{void harvest().catch(()=>{});},3000);
          let terminal=null;
          try{ terminal=await this.wechat.wait(q.job_id,{signal}); await harvest(); }finally{ clearInterval(poll); }
          const result=await this.wechat.getResult(q.job_id);
          const leftovers=[];
          for(const rec of result.records??[]){
            const id=rec?.identity??(rec?.url?('url:'+sha256(rec.url)):null);
            if(!id||handled.has(id))continue;
            if(rec.within_window!==true||rec.body_complete!==true)continue;
            handled.add(id);leftovers.push(rec);
          }
          if(leftovers.length){
            for(const rec of leftovers)add(rec,query);
            openedCount+=leftovers.length;
            await enqueueAnalysis([...merged.values()].slice(beforeTwo).filter(a=>!a.analysis));
          }
          // Attach this query's pre-screen verdict so selection can gate and dedupe by information
          // point. The verdict file is per query now, so the old shared filename would attach nothing
          // and every article would fail the keep-gate.
          const verdicts=await readJson(path.join(dir,`prescreen-${query.id}.json`),{});
          for(const a of merged.values()){const v=verdicts[candidateKey(a.original_title??a.title,a.account)];if(v)a.prescreen=v;}
          q.trace=q.trace??[];
          q.trace.push({pass:'open',job_id:receipt.job_id,records:result.records?.length??openedCount,streamed:openedCount,stop:terminal?.stop_reason??null});
          markEvent({kind:'opened',records:result.records?.length??openedCount,slotsBusy:analysisRunning});
          q.count=result.records?.length??0;q.stop_reason=terminal?.stop_reason??null;
          if(q.status==='complete'&&q.stop_reason&&q.status!=='complete')q.status='partial';
          state.article_count=merged.size;await writeJson(articlesFile,[...merged.values()]);await save();
        }catch(e){ checkAbort(signal); q.status='failed';q.error=safeError(e);await save(); }
      }
      if(cfg.collection.first_party){for(const source of snapshot.sources){checkAbort(signal);if(state.sources.find(x=>x.id===source.id)?.status==='complete')continue;const beforeSource=merged.size;const result=await collectSource(source,state.cutoff_time,state.reference_time,{fetchText:this.fetchText,signal});for(const a of result.records??[])add(a,null,source);state.sources=state.sources.filter(x=>x.id!==source.id);state.sources.push({id:source.id,status:result.status,count:result.records.length,error:result.error??null,scope:source.scope});await writeJson(articlesFile,[...merged.values()]);await save();await enqueueAnalysis([...merged.values()].slice(beforeSource));}}
      // Collection is done; let every review started during collection finish before moving on.
      await Promise.all(analysisJobs).catch(()=>{});
      articles=[...merged.values()];state.article_count=articles.length;state.stages.collection=state.queries.some(q=>q.status!=='complete')||state.sources.some(s=>s.status!=='complete')?'partial':'complete';await writeJson(articlesFile,articles);await save();
    }
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
    // A body hash only catches byte-identical reposts. Lightly edited reposts get a different hash
    // and were published twice, so the model decides whether today's piece repeats an earlier story.
    try{
      // Both judges spend real model calls, so they draw on the same budget the analyzer uses and
      // report into the same counter; otherwise actual usage was invisible in the run state.
      const remaining=Math.max(0,Number(cfg.analysis.max_calls??300)-(state.model_calls??0));
      const repeatCalls=await judgeRepeats({llm:this.llm,selection:this.selection(),articles,known,signal:tailSignal,maxCalls:remaining,onUsage:(c)=>{state.repeat_calls=(state.repeat_calls??0)+c;state.model_calls=(state.model_calls??0)+c;}});
      state.repeat_judged=articles.filter(a=>a.repeated!==undefined).length;
      state.repeat_calls=repeatCalls;
      await save();
    }catch(e){checkAbort(signal);state.repeat_judge_error=safeError(e);}
    const fresh=articles.filter(a=>!a.repeated);
    // Stage L6: one judgement over the whole pool. The agent sees every candidate's category, score
    // and summary and decides which to publish; the code only states the goal, the seat counts and
    // the one-article-per-story rule. Splitting this per category or per tie band would lose the
    // global view that makes the comparisons sound.
    const targetCount=Math.max(1,Number(cfg.selection?.target??30));
    const ratio=cfg.selection?.ratio??{application:0.7,model:0.2,hardware:0.1};
    const poolRows=toRows(fresh.filter(a=>a.analysis?.status!=='promotional'),snapshot.categoryKeys);
    let chosen;
    try{
      const verdict=await chooseEdition({ctx:this.ctx,llm:this.llm,selection:this.selection(),rows:poolRows,target:targetCount,ratio,categories:snapshot.categories,minScore:snapshot.tuning?.min_score,signal:tailSignal});
      const counts=Object.fromEntries(Object.keys(ratio).map((k)=>[k,0]));
      for(const row of verdict.rows) if(row.category!=='none') counts[row.category]+=1;
      chosen={articles:verdict.rows.map((r)=>r.article),stats:{candidates:verdict.candidateCount,selected:verdict.rows.length,counts,target:targetCount,ratio,via:verdict.via,reason:verdict.reason,shortPool:verdict.via==='none',emptyVerdict:verdict.emptyVerdict===true}};
      state.selection_judge={via:verdict.via,reason:verdict.reason,empty_verdict:verdict.emptyVerdict===true};
      state.model_calls=(state.model_calls??0)+1;
    }catch(e){
      checkAbort(signal);
      // A failed judgement must not cost the run: fall back to the deterministic ranking so the
      // edition still ships, and record why.
      state.selection_judge_error=safeError(e);
      chosen=selectEdition(poolRows.map((r)=>r.article),{target:targetCount,minScore:snapshot.tuning?.min_score});
    }
    state.selection=chosen.stats;
    const publicArticles=chosen.articles.map(a=>({id:a.id,title:a.title,url:a.url,author:a.author??'',account:a.account??'',date:a.date,language:a.language,categories:a.analysis?.topics?.length?a.analysis.topics:a.topics,status:a.analysis?.status??'uncertain',summary:a.analysis?.summary_zh??'',readStatus:a.body_status??'unavailable',reason:a.analysis?.reason??'',point:a.prescreen?.point??'',category:a.prescreen?.category??'none'}));
    const publicCoverage={...coverage,complete:!coverage.partial,status:coverage.partial?'partial':'complete',plannedQueries:coverage.queries_planned,completedQueries:coverage.queries_complete,partialQueries:coverage.queries_partial,failedQueries:coverage.queries_failed,candidates:coverage.articles_total,processedArticles:articles.filter(a=>a.analysis).length,unreadArticles:coverage.body_unread,note:`英文一手来源${coverage.sources_complete}/${coverage.sources_planned}完成；中文查询${coverage.zh_complete}，英文查询${coverage.en_complete}。${coverage.source_failures.length?'未成功来源：'+coverage.source_failures.join('、')+'。':''}所有候选私有留存，公开页不包含全文。`,byLanguage:{zh:{planned:snapshot.queries.filter(q=>q.language==='zh').length,completed:coverage.zh_complete,failed:state.queries.filter(q=>q.language==='zh'&&q.status==='failed').length},en:{planned:snapshot.queries.filter(q=>q.language==='en').length,completed:coverage.en_complete,failed:state.queries.filter(q=>q.language==='en'&&q.status==='failed').length}}};
    const windowDays=Number(state.lookback_days??cfg.lookback_days??1);const windowLabel=windowDays===1?'近24小时':`近${windowDays*24}小时`;
    const edition={date:state.date,version:state.version,title:windowDays===1?cfg.title:`${cfg.title} · ${windowLabel}`,window_label:windowLabel,window_days:windowDays,overview:`候选${chosen.stats.candidates}篇，去重后${chosen.stats.uniquePoints}个信息点，精选${chosen.stats.selected}篇（应用${chosen.stats.counts.application}／模型${chosen.stats.counts.model}／硬件${chosen.stats.counts.hardware}）。`,events:groupEvents(chosen.articles).map(e=>({...e,categories:e.topics})),articles:publicArticles,coverage:publicCoverage};
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
    if(state.stages.site!=='complete'){state.phase='rendering';const rendered=await renderSite({siteDir:path.join(this.projectDir,'site'),edition,publicBaseUrl:cfg.publishing.public_base_url});state.report_url=rendered.reportUrl;state.report_path=rendered.reportPath;state.stages.site='complete';await save();}
    // When the site is not published anywhere, the only honest link is the local viewer. Pointing at
    // the public base URL produced a 404 that was then sent over IM as if it worked.
    if(!cfg.publishing.enabled&&state.report_path){
      const localPort=cfg.notification?.local_viewer_port??8731;
      state.local_url=`http://127.0.0.1:${localPort}/${String(state.report_path).replace(/^\/+/,'')}`;
      state.report_url=state.local_url;
      await save();
    }
    if(cfg.publishing.enabled&&state.stages.publication!=='complete'){
      state.phase='publishing';try{const publisher=new PublishGithub({siteDir:path.join(this.projectDir,'site'),repository:cfg.publishing.repository,branch:cfg.publishing.branch,publicBaseUrl:cfg.publishing.public_base_url,gitExecutable:cfg.git.executable,runProcess:this.runProcess});const result=await publisher.publish({date:state.date,version:state.version,signal:tailSignal});state.publication=result;state.report_url=result.publishedUrl??result.reportUrl??state.report_url;state.stages.publication=result.status==='published'&&result.verified===true?'complete':'blocked';}catch(e){checkAbort(signal);state.stages.publication='failed';state.errors.push({stage:'publication',reason:safeError(e)});}await save();
    }else if(!cfg.publishing.enabled)state.stages.publication='skipped';
    // Notification must not depend on publishing: the daily link can be delivered while the site is
    // never pushed anywhere. Gating on publication made it impossible to ever send when publishing
    // was off, which is the normal configuration here. Archive completion is the real precondition.
    if(cfg.notification.enabled&&state.stages.archive==='complete'&&state.stages.notification!=='complete'){
      state.phase='notifying';const deliveryKey=sha256({project:cfg.id,date:state.date,version:state.version,target:cfg.notification});const deliveries=await readJson(path.join(this.runtime,'deliveries.json'),{});if(deliveries[deliveryKey]?.status==='sent'){state.stages.notification='complete';}else if(deliveries[deliveryKey]?.status==='unknown'){state.stages.notification='blocked';state.errors.push({stage:'notification',reason:'PREVIOUS_DELIVERY_OUTCOME_UNKNOWN'});}else{
        const adapter=this.imAdapter??createImAdapter(this.ctx);const target=await resolveDelivery(this.ctx,{...cfg.notification,botId:cfg.notification.bot_id,targetId:cfg.notification.target_id,adapter});if(!target.ready){state.stages.notification='blocked';state.notification=target;}else{deliveries[deliveryKey]={status:'unknown',at:new Date().toISOString(),run_id:state.run_id};await writeJson(path.join(this.runtime,'deliveries.json'),deliveries);try{
          // Short message: date, how many were selected, and the link. The link may be a loopback
          // address that only opens on this machine - delivery is the goal, reachability is not promised.
          const nc=chosen.stats.counts;
          const msgLines=[`${state.date} AI技术日报 v${state.version}`,`精选 ${chosen.stats.selected} 篇（应用 ${nc.application} / 模型 ${nc.model} / 硬件 ${nc.hardware}）`];
          if(coverage.partial)msgLines.push('本期有检索或正文处理缺口，请见覆盖说明。');
          if(state.report_url)msgLines.push(state.report_url);
          const notifyText=msgLines.join('\n');
          const result=await adapter.sendNotification({botId:target.botId,targetId:target.targetId,text:notifyText,signal:tailSignal});if(result.sent===true){deliveries[deliveryKey].status='sent';state.stages.notification='complete';state.notification={sent:true,botId:target.botId,targetId:target.targetId,text:notifyText};}else{deliveries[deliveryKey].status=result.uncertain?'unknown':'failed';state.stages.notification='blocked';state.notification=result;} }catch(e){checkAbort(signal);state.stages.notification='failed';state.errors.push({stage:'notification',reason:safeError(e)});}await writeJson(path.join(this.runtime,'deliveries.json'),deliveries);}}
      await save();
    }else if(!cfg.notification.enabled)state.stages.notification='disabled';
    state.phase='finished';state.coverage=coverage;state.status=Object.values(state.stages).some(s=>['failed','blocked','pending'].includes(s))?'blocked':coverage.partial?'partial':'complete';
    if(budgetExceeded()&&state.status==='complete')state.status='partial';
    await save();
    // Diagnostics are bounded: after the run is safely finished, drop the oldest run directories.
    // Never fatal - a cleanup failure must not turn a good run into a failed one.
    try{const pruned=await this.pruneRuns({keep:10});if(pruned.removed)state.runs_pruned=pruned.removed;}catch{/* ignore */}
    await save();
  }
}

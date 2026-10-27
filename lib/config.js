import path from 'node:path';
import fs from 'node:fs/promises';
import {inside,readJson,sha256,validDate} from './io.js';

export async function loadProject(projectDir,date){
  const dir=path.resolve(projectDir);const config=await readJson(path.join(dir,'config','project.json'));
  if(!config||config.schema_version!==1||config.id!=='ai-tech-daily')throw new Error('PROJECT_CONFIG_INVALID');
  if(!validDate(date))throw new Error('INVALID_EDITION_DATE');
  if(!Number.isInteger(config.lookback_days)||config.lookback_days<1||config.lookback_days>7)throw new Error('INVALID_LOOKBACK');
  for(const [key,min,max] of [['concurrency',1,8],['batch_chars',1000,100000],['max_retries',0,5],['max_calls',1,100000],['max_output_tokens',500,64000]]){if(!Number.isInteger(config.analysis?.[key])||config.analysis[key]<min||config.analysis[key]>max)throw new Error('ANALYSIS_CONFIG_INVALID_'+key);}
  for(const [key,min,max] of [['batch_size',1,20],['batch_article_chars',2000,200000]]){if(config.analysis?.[key]!==undefined&&(!Number.isInteger(config.analysis[key])||config.analysis[key]<min||config.analysis[key]>max))throw new Error('ANALYSIS_CONFIG_INVALID_'+key);}
  if(!Number.isInteger(config.collection?.runtime_minutes??480)||(config.collection.runtime_minutes??480)<1||(config.collection.runtime_minutes??480)>1440)throw new Error('RUNTIME_BUDGET_INVALID');
  // Optional tuning knobs: validated when present, otherwise defaulted below. Keeping them optional
  // means an existing project.json keeps working without edits.
  const opt=(obj,key,min,max,dflt)=>{const v=obj?.[key];if(v===undefined||v===null)return dflt;if(!Number.isInteger(v)||v<min||v>max)throw new Error('INVALID_OPTION_'+key);return v;};
  config.analysis=config.analysis??{};
  config.collection=config.collection??{};
  const tuning={
    // Pre-screen (model decides which listed candidates are worth opening at all).
    prescreen_max_calls: opt(config.analysis,'prescreen_max_calls',1,2000,120),
    // Selection floor: judged quality below this never enters the edition, however thin a topic is.
    min_score: opt(config.selection,'min_score',0,10,6),
    // Collector pacing: pause between opening articles, and how long one keyword may take.
    delay_ms: opt(config.collection,'delay_ms',120,10000,180),
    per_query_timeout_minutes: opt(config.collection,'per_query_timeout_minutes',1,120,10),
  };
  const queryDoc=await readJson(inside(dir,config.collection.query_file));
  const sourceDoc=await readJson(inside(dir,config.collection.sources_file));
  const policy=await fs.readFile(inside(dir,config.analysis.policy_file),'utf8');
  if(!Array.isArray(queryDoc?.queries)||!queryDoc.queries.length)throw new Error('EMPTY_QUERY_PLAN');
  const ids=new Set();
  // Language is optional and no longer forces a bilingual plan: this digest reads a Chinese platform,
  // so keywords follow how the Chinese tech community actually writes them (术语保留英文原词).
  for(const q of queryDoc.queries){if(!q.id||ids.has(q.id)||typeof q.keyword!=='string'||!q.keyword.trim()||q.keyword.length>200||/[\x00-\x1f]/.test(q.keyword)||(q.language!==undefined&&!['zh','en'].includes(q.language))||!['daily','rotate'].includes(q.cadence)||(q.cadence==='rotate'&&![0,1,2].includes(q.slot)))throw new Error('QUERY_PLAN_INVALID');ids.add(q.id);}
  const epoch=Math.floor(Date.parse(date+'T00:00:00Z')/86400000);const slot=((epoch%3)+3)%3;
  const queries=queryDoc.queries.filter(q=>q.cadence==='daily'||q.slot===slot).map(q=>({...q,lookback_days:q.cadence==='rotate'?7:config.lookback_days}));
  if(!queries.some(q=>q.topic==='AgenticOS'))throw new Error('AGENTICOS_COVERAGE_REQUIRED');
  if(!Array.isArray(sourceDoc?.sources))throw new Error('SOURCE_PLAN_INVALID');
  const sourceIds=new Set();for(const s of sourceDoc.sources){if(!s.id||sourceIds.has(s.id))throw new Error('SOURCE_ID_INVALID');sourceIds.add(s.id);const u=new URL(s.url);if(u.protocol!=='https:'||u.username||u.password||u.hostname==='localhost'||/^127\./.test(u.hostname)||!['rss','github-atom'].includes(s.type))throw new Error('SOURCE_PLAN_INVALID');}
  const snapshot={config,queries,sources:sourceDoc.sources,policy,all_queries:queryDoc.queries,query_version:queryDoc.version,source_version:sourceDoc.version,tuning};
  return {...snapshot,projectDir:dir,hash:sha256(snapshot)};
}

export const TOPICS=['模型与训练','推理与学习','推理部署与效率','Agent','AgenticOS','Harness与上下文工程','多模态与世界模型','具身智能','评测、安全与可靠性','技术应用与新探索'];

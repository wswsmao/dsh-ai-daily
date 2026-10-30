import path from 'node:path';
import fs from 'node:fs/promises';
import {inside,readJson,sha256,validDate} from './io.js';

export async function loadProject(projectDir,date){
  const dir=path.resolve(projectDir);const config=await readJson(path.join(dir,'config','project.json'));
  if(!config||config.schema_version!==1||config.id!=='ai-tech-daily')throw new Error('PROJECT_CONFIG_INVALID');
  if(!validDate(date))throw new Error('INVALID_EDITION_DATE');
  if(!Number.isInteger(config.lookback_days)||config.lookback_days<1||config.lookback_days>7)throw new Error('INVALID_LOOKBACK');
  for(const [key,min,max] of [['concurrency',1,8],['max_retries',0,5],['max_calls',1,100000]]){if(!Number.isInteger(config.analysis?.[key])||config.analysis[key]<min||config.analysis[key]>max)throw new Error('ANALYSIS_CONFIG_INVALID_'+key);}
  if(!Number.isInteger(config.collection?.runtime_minutes??480)||(config.collection.runtime_minutes??480)<1||(config.collection.runtime_minutes??480)>1440)throw new Error('RUNTIME_BUDGET_INVALID');
  // Optional tuning knobs: validated when present, otherwise defaulted below. Keeping them optional
  // means an existing project.json keeps working without edits.
  const opt=(obj,key,min,max,dflt)=>{const v=obj?.[key];if(v===undefined||v===null)return dflt;if(!Number.isInteger(v)||v<min||v>max)throw new Error('INVALID_OPTION_'+key);return v;};
  config.analysis=config.analysis??{};
  config.collection=config.collection??{};
  // Categories are configuration, not code constants: a project may add or remove a category without
  // touching the plugin. Both halves must agree, because the model needs a description to classify a
  // piece at all, and the ratio needs a weight to spend seats on it. Half a definition is a mistake
  // that would silently mis-rank the edition, so it fails at load.
  const DEFAULT_CATEGORIES = { application: 'Agent/应用架构/工具链', model: '训练/原理/架构', hardware: '推理加速/芯片/算力' };
  const DEFAULT_RATIO = { application: 0.7, model: 0.2, hardware: 0.1 };
  const categories = config.selection?.categories ?? DEFAULT_CATEGORIES;
  const ratio = config.selection?.ratio ?? DEFAULT_RATIO;
  if (!categories || typeof categories !== 'object' || Array.isArray(categories)) throw new Error('CONFIG_CATEGORIES_INVALID');
  const catKeys = Object.keys(categories);
  if (!catKeys.length) throw new Error('CONFIG_CATEGORIES_EMPTY');
  for (const key of catKeys) {
    const desc = categories[key];
    if (typeof desc !== 'string' || !desc.trim()) {
      throw new Error(`CONFIG_CATEGORY_DESCRIPTION_MISSING: categories.${key} 缺少说明。模型需要说明才能判断文章归类，不能留空。`);
    }
  }
  if (!ratio || typeof ratio !== 'object' || Array.isArray(ratio)) throw new Error('CONFIG_RATIO_INVALID');
  const ratioKeys = Object.keys(ratio);
  for (const key of ratioKeys) {
    if (!catKeys.includes(key)) throw new Error(`CONFIG_CATEGORY_RATIO_MISMATCH: ratio 有 ${key}，但 categories 里没有这个分类（模型无法判断一篇属于什么）。`);
    const w = ratio[key];
    if (!Number.isFinite(w) || w <= 0) throw new Error(`CONFIG_RATIO_INVALID: ratio.${key} 必须为正数。`);
  }
  for (const key of catKeys) {
    if (!ratioKeys.includes(key)) throw new Error(`CONFIG_CATEGORY_RATIO_MISMATCH: categories 有 ${key}，但 ratio 里没有；ratio 必须为每个分类给出权重。`);
  }
  // Weights need not sum to 1; they are normalised so any comparable scale works.
  const ratioTotal = ratioKeys.reduce((a, k) => a + ratio[k], 0);
  const ratioNormalized = Object.fromEntries(ratioKeys.map((k) => [k, ratio[k] / ratioTotal]));
  config.selection = { ...(config.selection ?? {}), categories, ratio: ratioNormalized, ratio_raw: { ...ratio } };
  const categoriesAllowed = new Set(catKeys);

  const tuning={
    // Selection floor: judged quality below this never enters the edition, however thin a topic is.
    min_score: opt(config.selection,'min_score',0,10,6),
    // Collector pacing: pause between opening articles, and how long one keyword may take.
    delay_ms: opt(config.collection,'delay_ms',120,10000,180),
    per_query_timeout_minutes: opt(config.collection,'per_query_timeout_minutes',1,120,10),
    // How far past the window the collector may scroll before it stops loading older results. Left
    // unset by default: the collector derives it from the window, so a daily run does not wait for
    // rows a day past their cutoff. A project may still pin a value here.
    boundary_slack_hours: opt(config.collection,'boundary_slack_hours',0,240,undefined),
    // How long run diagnostics are kept. Recent runs stay inspectable; older ones are pruned.
    temp_retention_days: opt(config.retention??{},'temp_retention_days',1,3650,30),
    // Screening works on the whole pool at once. A pool larger than one chunk is split by candidate
    // count and the pieces run concurrently, since none of them touches the WeChat window.
    prescreen_chunk_size: opt(config.analysis,'prescreen_chunk_size',20,2000,150),
    prescreen_concurrency: opt(config.analysis,'prescreen_concurrency',1,4,3),
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
  // Expose the resolved category set so every consumer (pre-screen, selection, prompts, counts) reads
  // one definition instead of each carrying its own hardcoded list.
  snapshot.categories=Object.freeze({...categories});
  snapshot.categoryKeys=Object.freeze([...catKeys]);
  snapshot.categoryAllowed=categoriesAllowed;
  return {...snapshot,projectDir:dir,hash:sha256(snapshot)};
}

export const TOPICS=['模型与训练','推理与学习','推理部署与效率','Agent','AgenticOS','Harness与上下文工程','多模态与世界模型','具身智能','评测、安全与可靠性','技术应用与新探索'];

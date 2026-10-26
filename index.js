import path from 'node:path';
import {DailyPipeline} from './lib/pipeline.js';
import {makePublicFetch} from './lib/sources.js';
import {createProcessRunner} from './lib/process.js';
import {loadProject} from './lib/config.js';
import {dateInShanghai} from './lib/io.js';
import {createImAdapter,resolveDelivery} from './lib/im-delivery.js';

export const inject=['tools','subprocess','llm','agentDefaultModel','wechatSearch','scheduleCenter'];
export function apply(ctx,config={}){
  const projectDir=path.resolve(config.projectDir??'D:\\Program Files (x86)\\dsh-deploy\\archive\\daily\\ai-tech-daily');
  const runProcess=createProcessRunner(ctx.subprocess);
  const pipeline=new DailyPipeline({projectDir,ctx,wechat:ctx.wechatSearch,fetchText:makePublicFetch(),llm:ctx.llm,selection:()=>ctx.agentDefaultModel.currentSelection(),runProcess});
  const service={start:(input)=>pipeline.start(input),status:(id)=>pipeline.status(id),list:()=>pipeline.list(),cancel:(id)=>pipeline.cancel(id),resume:(id,stage)=>pipeline.resume(id,stage),ready:pipeline.ready};
  ctx.provide('aiDaily',service);
  const output={schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v,null,2)}]};
  ctx.effect(()=>{
    const dispose=[ctx.tools.register({name:'ai_daily_run',description:'按固定版本化双语检索与来源清单生成AI技术日报，读取正文、逐篇判断、去重、归档并发布手机网页和IM链接；返回后台运行ID。查询不会由模型自行减少。可能操作已登录微信桌面、调用配置模型并公开发布允许的摘要。',parameters:{type:'object',properties:{date:{type:'string',description:'日报归档日期YYYY-MM-DD；省略用北京时间今天，不改变检索原始时间窗。'},mode:{type:'string',enum:['full','collect-only'],description:'full执行全部配置阶段；collect-only仅采集（用于检查，仍执行完整查询清单）。'}},additionalProperties:false},output,timeoutMs:30000,execute:async a=>{if(Object.keys(a??{}).some(k=>!['date','mode'].includes(k)))throw new Error('INVALID_ARGUMENT');return pipeline.start(a??{});},presentCall:()=>({card:'generic',title:'生成AI技术日报',kind:'execute'})}),
      ctx.tools.register({name:'ai_daily_job',description:'查看AI日报阶段与覆盖状态、取消、续跑或仅重试发布/通知；setup只读检查已配置机器人目标与发布设置，不读取凭据，不发送测试消息。',parameters:{type:'object',properties:{action:{type:'string',enum:['status','list','cancel','resume','retry-publication','retry-notification','setup']},run_id:{type:'string',description:'status/cancel/resume/retry必填的运行UUID；list/setup不填写。'}},required:['action'],additionalProperties:false},output,timeoutMs:30000,isConcurrencySafe:a=>['status','list','setup'].includes(a?.action),execute:async a=>{if(a.action==='setup'){const p=await loadProject(projectDir,dateInShanghai());return {project_dir:projectDir,queries_daily:p.queries.length,queries_total:p.all_queries.length,sources:p.sources.length,publishing:p.config.publishing,notification:await resolveDelivery(ctx,{...p.config.notification,botId:p.config.notification.bot_id,targetId:p.config.notification.target_id})};}if(a.action==='list')return pipeline.list();if(a.action==='status')return pipeline.status(a.run_id);if(a.action==='cancel')return pipeline.cancel(a.run_id);if(a.action==='resume')return pipeline.resume(a.run_id);if(a.action==='retry-publication')return pipeline.resume(a.run_id,'publication');if(a.action==='retry-notification')return pipeline.resume(a.run_id,'notification');throw new Error('INVALID_ACTION');},presentCall:()=>({card:'generic',title:'AI日报任务',kind:'read'})})];
    const unregisterAction=ctx.scheduleCenter.registerAction({id:'ai-tech-daily',title:'AI技术日报',description:'固定双语技术检索、归档、公开手机阅读站和微信链接通知',start:input=>pipeline.start(input),status:id=>pipeline.status(id),cancel:id=>pipeline.cancel(id)});
    return async()=>{unregisterAction();for(const d of dispose.reverse())d();await pipeline.dispose();};
  });
}

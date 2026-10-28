import path from 'node:path';
import {DailyPipeline} from './lib/pipeline.js';
import {makePublicFetch} from './lib/sources.js';
import {createProcessRunner} from './lib/process.js';
import {loadProject} from './lib/config.js';
import {dateInShanghai} from './lib/io.js';
import {createImAdapter,resolveDelivery} from './lib/im-delivery.js';

export const inject=['tools','subprocess','llm','agentDefaultModel','wechatSearch','scheduleCenter','dshIm'];
export function apply(ctx,config={}){
  const projectDir=path.resolve(config.projectDir??'D:\\Program Files (x86)\\dsh-deploy\\archive\\daily\\ai-tech-daily');
  const runProcess=createProcessRunner(ctx.subprocess);
  const pipeline=new DailyPipeline({projectDir,ctx,wechat:ctx.wechatSearch,fetchText:makePublicFetch(),llm:ctx.llm,selection:()=>ctx.agentDefaultModel.currentSelection(),runProcess});
  const service={start:(input)=>pipeline.start(input),status:(id)=>pipeline.status(id),list:()=>pipeline.list(),cancel:(id)=>pipeline.cancel(id),resume:(id,stage)=>pipeline.resume(id,stage),ready:pipeline.ready};
  ctx.provide('aiDaily',service);
  const output={schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v,null,2)}]};
  ctx.effect(()=>{
    const dispose=[ctx.tools.register({name:'ai_daily_run',description:'生成AI技术日报：检索微信、读正文、逐篇判断、去重、归档并给出本地网页链接。流程：逐关键词搜索→窗口内候选交模型初筛→只打开通过的文章→全部关键词完成后由模型一次性从候选池选出当期篇数。默认只取近24小时；要更长时间窗（48/72小时）传 lookback_days=2 或 3，不必改配置。目标篇数、分类与比例在项目配置的 selection 里（可增删分类），需要现状就调 ai_daily_job(action=setup)。跑完用 ai_daily_job(action=status) 取 local_url。耗时约15-40分钟，期间会操作已登录微信桌面且必须保持微信窗口在前台（被其他程序抢焦点会导致采集失败），请勿操作电脑。查询不会由模型自行减少。',parameters:{type:'object',properties:{date:{type:'string',description:'日报归档日期YYYY-MM-DD；省略用北京时间今天，不改变检索原始时间窗。'},mode:{type:'string',enum:['full','collect-only'],description:'full执行全部配置阶段；collect-only仅采集（用于检查，仍执行完整查询清单）。'},lookback_days:{type:'integer',minimum:1,maximum:7,description:'本次检索的时间窗（天）。1=24小时，2=48小时，3=72小时。省略则用项目配置值（默认1）。'}},additionalProperties:false},output,timeoutMs:30000,execute:async a=>{if(Object.keys(a??{}).some(k=>!['date','mode','lookback_days'].includes(k)))throw new Error('INVALID_ARGUMENT');if(a.lookback_days!==undefined&&(!Number.isInteger(a.lookback_days)||a.lookback_days<1||a.lookback_days>7))throw new Error('INVALID_ARGUMENT');return pipeline.start(a??{});},presentCall:()=>({card:'generic',title:'生成AI技术日报',kind:'execute'})}),
      ctx.tools.register({name:'ai_daily_job',description:'查看AI日报阶段与覆盖状态、取消、续跑或仅重试发布/通知。action=setup 返回该插件的用法说明（怎么传时间窗、跑完去哪取链接、当前目标篇数与分类比例）以及已配置的机器人目标与发布设置；只读，不读取凭据。action=test-notification 会向已配置目标真实发送一条测试消息并返回结果，用于验证投递通道。',parameters:{type:'object',properties:{action:{type:'string',enum:['status','list','cancel','resume','retry-publication','retry-notification','test-notification','setup']},run_id:{type:'string',description:'status/cancel/resume/retry必填的运行UUID；list/setup不填写。'}},required:['action'],additionalProperties:false},output,timeoutMs:30000,isConcurrencySafe:a=>['status','list','setup'].includes(a?.action),execute:async a=>{if(a.action==='setup'){const p=await loadProject(projectDir,dateInShanghai());return {
          project_dir: projectDir,
          usage: {
            run: 'ai_daily_run() 默认近24小时；ai_daily_run(lookback_days=2) 取48小时，=3 取72小时',
            result: '跑完调 ai_daily_job(action="status", run_id=...) 取 local_url 与精选篇数',
            window: `当前默认时间窗 ${p.config.lookback_days} 天（${p.config.lookback_days * 24} 小时），可用 lookback_days 参数临时覆盖`,
            seats: `目标 ${p.config.selection.target} 篇；候选不足时全保留，超过时由模型按分类名额一次选出`,
            categories: '分类与比例在 config/project.json 的 selection.categories / selection.ratio，可自由增删，两者必须一一对应且每个分类要给说明',
            cautions: '运行期间必须保持微信窗口在前台；被其他程序抢焦点会导致采集失败。耗时约15-40分钟',
          },
          queries_daily: p.queries.length,
          queries_total: p.all_queries.length,
          sources: p.sources.length,
          default_lookback_days: p.config.lookback_days,
          selection: p.config.selection,
          publishing: p.config.publishing,
          notification: await resolveDelivery(ctx,{...p.config.notification,botId:p.config.notification.bot_id,targetId:p.config.notification.target_id}),
        };}
        if(a.action==='test-notification'){
          // A real send to the configured target: the only honest way to prove the channel works,
          // since discovery can report configured while the platform still rejects the address.
          const p=await loadProject(projectDir,dateInShanghai());
          const cfgN=p.config.notification??{};
          if(!cfgN.enabled)return {ok:false,reason:'notification-disabled',hint:'把 config/project.json 的 notification.enabled 设为 true'};
          if(!cfgN.bot_id||!cfgN.target_id)return {ok:false,reason:'target-not-configured',hint:'需要同时配置 notification.bot_id 与 notification.target_id'};
          const adapter=createImAdapter(ctx);
          if(!adapter.available)return {ok:false,reason:'im-unavailable',hint:'当前宿主没有提供 dshIm 服务'};
          const text=`AI日报投递测试 ${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}\n这是一个测试消息，收到说明通道可用。`;
          const result=await adapter.sendNotification({botId:cfgN.bot_id,targetId:cfgN.target_id,text});
          return {ok:result.sent===true,botId:cfgN.bot_id,targetId:cfgN.target_id,result,text};
        }
        if(a.action==='list')return pipeline.list();if(a.action==='status')return pipeline.status(a.run_id);if(a.action==='cancel')return pipeline.cancel(a.run_id);if(a.action==='resume')return pipeline.resume(a.run_id);if(a.action==='retry-publication')return pipeline.resume(a.run_id,'publication');if(a.action==='retry-notification')return pipeline.resume(a.run_id,'notification');throw new Error('INVALID_ACTION');},presentCall:()=>({card:'generic',title:'AI日报任务',kind:'read'})})];
    const unregisterAction=ctx.scheduleCenter.registerAction({id:'ai-tech-daily',title:'AI技术日报',description:'固定双语技术检索、归档、公开手机阅读站和微信链接通知',start:input=>pipeline.start(input),status:id=>pipeline.status(id),cancel:id=>pipeline.cancel(id)});
    return async()=>{unregisterAction();for(const d of dispose.reverse())d();await pipeline.dispose();};
  });
}

// Offline probe: can we discover emerging technical terms from what we already collected?
// Reads the corpus only; no network, no collection, no writes.
import fs from 'node:fs/promises';

const file = process.argv[2];
const arts = JSON.parse(await fs.readFile(file, 'utf8'));
console.log('articles =', arts.length);

const docs = arts.map((a) => {
  const parts = [a.title ?? ''];
  if (a.analysis?.summary_zh) parts.push(a.analysis.summary_zh);
  else if (a.body_text) parts.push(String(a.body_text).slice(0, 800));
  return parts.join(' ');
});

const enStop = new Set(['the','and','for','with','this','that','from','into','more','most','new','how','why','what','can','are','was','will','has','have','not','all','its','our','their','you','your','about','when','which','than','then','them','they','been','also','only','over','such','some','any','one','two','use','used','using','based','via','per','may','might','should','would','could','like','just','very','much','many','other','each','both','between','during','while','after','before','these','those','there','here','where','does','did','get','got','make','made','take','show','shows','see','seen','say','says','said']);
const enCount = new Map();
for (const d of docs) {
  const seen = new Set();
  for (const m of d.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[.\-_][A-Za-z0-9]+)*/gu)) {
    const t = m[0];
    if (t.length < 3 || enStop.has(t.toLowerCase())) continue;
    seen.add(t);
  }
  for (const t of seen) enCount.set(t, (enCount.get(t) ?? 0) + 1);
}

const zhStop = new Set(['我们','你们','他们','这个','那个','什么','怎么','如何','为什么','可以','不能','没有','已经','正在','将要','可能','应该','需要','必须','不是','是的','这样','那样','一些','很多','更多','非常','特别','尤其','甚至','还有','只有','因此','所以','但是','然而','而且','并且','或者','以及','例如','比如','包括','主要','基本','几乎','大概','也许','或许','一定','当然','显然','明显','现在','目前','未来','今天','昨天','最新','刚刚','首先','然后','最后','另外','此外','同时','其实','就是','还是','作为','通过','对于','关于','由于','使得','进行','提供','实现','使用','基于','具有','拥有','成为','存在','出现','提出','介绍','描述','说明','解释','讨论','分享','总结','分析','研究','探索','发现','认为','表示','指出','显示','表明','带来','产生','形成','包含','涉及','相关','不同','各种','多个','大量','整体','部分','方面','情况','问题','方法','方式','内容','形式','结果','过程','阶段','步骤','水平','程度','数量','比例','时间','空间','目标','任务','工作','项目','计划','方案','策略','管理','组织','支持','帮助','服务','获取','处理','存储','计算','展示','理解','识别','判断','预测','搜索','查询','排序','分类','匹配','转换','部署','运行','执行','调用','更新','升级','维护','优化','解决','应对','避免','减少','降低','提升','提高','改善','改进','创新','突破','进展','成果','价值','意义','影响','作用','功能','性能','效果','效率','质量','成本','风险','挑战','机会','优势','特点','特征','属性','参数','指标','数据','信息','技术','能力','系统','平台','工具','框架','产品','服务','企业','公司','团队','开发者','用户','场景','应用','落地','行业','产业','市场','报告','榜单','排行','盘点','汇总','指南','教程','入门','详解','解析','实践','全面','最全','深度','思考','观察','观点','评论','独家','首发','重磅','官宣','推出','上线','开源','发布','融资']);
const zhCount = new Map();
for (const d of docs) {
  const seen = new Set();
  for (const run of d.match(/[\u4e00-\u9fa5]{2,}/gu) ?? []) {
    for (let n = 2; n <= 6; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const g = run.slice(i, i + n);
        if (zhStop.has(g)) continue;
        seen.add(g);
      }
    }
  }
  for (const g of seen) zhCount.set(g, (zhCount.get(g) ?? 0) + 1);
}

const top = (m, k, min) => [...m.entries()]
  .filter(([, c]) => c >= min)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, k);

console.log('\n=== English / technical tokens (df>=3) ===');
for (const [t, c] of top(enCount, 30, 3)) console.log(`  ${String(c).padStart(3)}  ${t}`);

console.log('\n=== Chinese n-grams (df>=8) ===');
for (const [t, c] of top(zhCount, 40, 8)) console.log(`  ${String(c).padStart(3)}  ${t}`);

// Offline probe: which candidate keyword would actually hit most of yesterday's corpus?
// Approach: treat each candidate as a literal substring match against title+summary (and body when
// no summary exists). Case-insensitive for English. This estimates recall of a WeChat keyword search.
import fs from 'node:fs/promises';

const file = process.argv[2];
const arts = JSON.parse(await fs.readFile(file, 'utf8'));

const text = (a) => {
  const parts = [a.title ?? ''];
  if (a.analysis?.summary_zh) parts.push(a.analysis.summary_zh);
  else if (a.body_text) parts.push(String(a.body_text).slice(0, 1200));
  return parts.join(' ');
};

const docs = arts.map(text);

function count(term) {
  const needles = term.split('|').map((s) => s.trim().toLowerCase()).filter(Boolean);
  let n = 0;
  for (const d of docs) {
    const low = d.toLowerCase();
    if (needles.some((x) => low.includes(x))) n++;
  }
  return n;
}

const groups = {
  '工具/知识接入 (MCP+RAG)': [
    'MCP',
    'RAG',
    '工具调用|function calling|tool use',
    'Skills',
    '插件|plugin',
  ],
  '硬件/基础设施': [
    'AI 芯片|AI芯片|芯片',
    '算力',
    'AI Infra|AI基础设施|AI 基础设施',
    '模型部署|推理部署|部署',
    '推理优化|推理加速|推理框架',
    'GPU|显卡|显存',
  ],
  'Agent 方向': [
    'agent harness|harness',
    '上下文工程',
    'Agent|智能体',
    'AgenticOS|AIOS|智能体操作系统',
    '智能体记忆|agent memory|记忆系统',
    '多智能体|multi-agent|多Agent',
    '编程智能体|coding agent|代码智能体',
  ],
  '模型层': ['大模型训练|训练', '多模态大模型|多模态', '后训练|post-training', '蒸馏', '微调|fine-tuning'],
  '具身': ['具身智能|具身', 'VLA|机器人'],
};

console.log(`corpus = ${arts.length} articles\n`);
for (const [group, terms] of Object.entries(groups)) {
  console.log(`=== ${group} ===`);
  const rows = terms.map((t) => [t, count(t)]).sort((a, b) => b[1] - a[1]);
  for (const [t, c] of rows) {
    const pct = ((c / arts.length) * 100).toFixed(1);
    console.log(`  ${String(c).padStart(4)}  (${pct.padStart(4)}%)  ${t}`);
  }
  console.log('');
}

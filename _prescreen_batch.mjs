// EXPERIMENT ONLY. Splits yesterday's wechat articles into batches for model-based prescreening.
import fs from 'node:fs/promises';
import path from 'node:path';

const runFile = process.argv[2];
const outDir = 'D:\\Program Files (x86)\\dsh-deploy\\plugins\\dsh-ai-daily\\_prescreen_batches';
await fs.mkdir(outDir, { recursive: true });

const arts = JSON.parse(await fs.readFile(runFile, 'utf8'));
const wx = arts.filter((a) => !a.id?.startsWith('web:'));

const items = wx.map((a, i) => ({
  i,
  title: (a.title ?? '').slice(0, 200),
  account: (a.account ?? '').slice(0, 60),
  summary: (a.analysis?.summary_zh ?? '').slice(0, 500),
}));

const size = 15;
let n = 0;
for (let start = 0; start < items.length; start += size) {
  const chunk = items.slice(start, start + size);
  await fs.writeFile(path.join(outDir, `batch_${String(n).padStart(2, '0')}.json`), JSON.stringify(chunk, null, 1), 'utf8');
  n++;
}
console.log(`wechat=${wx.length} batches=${n} size=${size}`);

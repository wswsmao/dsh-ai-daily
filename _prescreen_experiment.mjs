// EXPERIMENT ONLY - not part of the pipeline.
// Replays yesterday's wechat articles through the new prescreen policy to see what survives.
import fs from 'node:fs/promises';
import path from 'node:path';

const root = 'D:\\Program Files (x86)\\dsh-deploy\\plugins\\dsh-ai-daily';
const runFile = process.argv[2];
const policy = await fs.readFile(path.join(root, 'config', 'prescreen-policy.md'), 'utf8');

const arts = JSON.parse(await fs.readFile(runFile, 'utf8'));
const wx = arts.filter((a) => !a.id?.startsWith('web:'));
console.log(`wechat candidates: ${wx.length}`);

// Build compact items using only list-page signals (title/account) plus the already-generated summary
// as a stand-in for the snippet, so the judgement reflects the policy rather than a live model call.
const items = wx.map((a, i) => ({
  i,
  title: (a.title ?? '').slice(0, 200),
  account: (a.account ?? '').slice(0, 80),
  summary: (a.analysis?.summary_zh ?? '').slice(0, 400),
}));

await fs.writeFile(
  path.join(root, '_prescreen_input.json'),
  JSON.stringify({ policy, items }, null, 1),
  [System.Text.Encoding] ? 'utf8' : 'utf8'
);
console.log(`wrote _prescreen_input.json with ${items.length} items`);

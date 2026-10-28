import test from 'node:test';
import assert from 'node:assert/strict';
import { selectEdition, compareRows, findTieGroups, toRows } from '../lib/selection.js';
import { judgeTies } from '../lib/tie-judge.js';

const art = (over = {}) => ({
  id: over.id ?? `a${Math.random()}`,
  title: over.title ?? 'Agent 记忆系统 MemCurrent 发布',
  url: 'https://mp.weixin.qq.com/s/x',
  body_text: over.body_text ?? 'MemCurrent 用只追加情景记忆，内部基准 22.3% 提升到 68.4%。',
  analysis: {
    status: 'technical',
    summary_zh: '摘要',
    quality: over.quality ?? { novelty: 2, specificity: 2, depth: 2, firstHand: 1, honesty: 2, total: 9 },
  },
  prescreen: { category: over.category ?? 'application', keep: over.keep !== false, point: over.point ?? `点 ${Math.random()}` },
  ...over,
});

test('equal scores are ordered by the model tie verdict, never by array position', () => {
  const a = { quality: { total: 8, tie_rank: 1 } };
  const b = { quality: { total: 8, tie_rank: 0 } };
  assert.equal(compareRows(b, a) < 0, true, 'rank 0 comes first');
  // Without a verdict the comparison is neutral: the code expresses no preference.
  assert.equal(compareRows({ quality: { total: 8 } }, { quality: { total: 8 } }), 0);
});

test('a judged article outranks an unjudged one at the same score', () => {
  const judged = { quality: { total: 8, tie_rank: 0 } };
  const unjudged = { quality: { total: 8 } };
  assert.equal(compareRows(judged, unjudged) < 0, true);
  assert.equal(compareRows(unjudged, judged) > 0, true);
});

test('tie groups only contain rows sharing a score', () => {
  const rows = [
    { quality: { total: 8 }, article: {} },
    { quality: { total: 8 }, article: {} },
    { quality: { total: 9 }, article: {} },
    { quality: { total: 7 }, article: {} },
  ];
  const groups = findTieGroups(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test('tie verdict reorders the edition and keeps full texts in the payload', async () => {
  const first = art({ id: 'first', title: '第一篇', body_text: '正文一', point: '点一' });
  const second = art({ id: 'second', title: '第二篇', body_text: '正文二', point: '点二' });
  const rows = toRows([first, second]);
  const groups = findTieGroups(rows);

  const seen = [];
  const llm = {
    async *stream(o) {
      const payload = JSON.parse(o.messages[0].content[0].text);
      seen.push(payload);
      // Prefer index 1 (第二篇)
      yield { type: 'text-delta', text: JSON.stringify({ keep: [1, 0], reason: '第二篇更具体' }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const calls = await judgeTies({ llm, selection: { provider: 'mock', model: 'mock' }, groups });
  assert.equal(calls, 1);
  assert.equal(seen[0].articles.length, 2);
  assert.equal(seen[0].articles[0].body, '正文一', 'the full text is supplied, not just a summary');

  const r = selectEdition([first, second], { target: 30, minScore: 6 });
  assert.equal(r.articles[0].id, 'second', 'the model verdict decides the order');
});

test('a failed tie verdict never drops articles', async () => {
  const first = art({ id: 'x', point: '点x' });
  const second = art({ id: 'y', point: '点y' });
  const llm = { async *stream() { throw new Error('model down'); } };
  const rows = toRows([first, second]);
  // A throwing model must not propagate: the run keeps going and both articles stay publishable.
  await judgeTies({ llm, selection: { provider: 'mock', model: 'mock' }, groups: findTieGroups(rows) });
  const r = selectEdition([first, second], { target: 30, minScore: 6 });
  assert.equal(r.stats.selected, 2, 'both survive when the judge fails');
});

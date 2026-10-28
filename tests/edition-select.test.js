import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseEdition } from '../lib/edition-select.js';
import { toRows } from '../lib/selection.js';

const art = (over = {}) => ({
  id: over.id ?? `a${Math.random()}`,
  title: over.title ?? 'Agent 记忆系统发布',
  account: '某号',
  body_text: '正文',
  analysis: {
    status: 'technical',
    summary_zh: over.summary ?? '讲了记忆系统的架构与实测',
    quality: over.quality ?? { novelty: 2, specificity: 2, depth: 2, firstHand: 1, honesty: 2, total: 9 },
  },
  prescreen: { category: over.category ?? 'application', keep: true, point: over.point ?? `点${Math.random()}` },
  ...over,
});

const mkRows = (n, category = 'application') =>
  Array.from({ length: n }, (_, i) => toRows([art({ id: `r${i}`, category, point: `p${category}${i}` })])[0]);

test('a pool that cannot fill the edition is published whole, without calling the model', async () => {
  const rows = mkRows(12);
  let called = false;
  const llm = { async *stream() { called = true; yield { type: 'text-delta', text: '{}' }; } };
  const r = await chooseEdition({ llm, selection: { provider: 'm', model: 'm' }, rows, target: 30, ratio: { application: 1 }, signal: undefined });
  assert.equal(r.via, 'none');
  assert.equal(r.rows.length, 12);
  assert.equal(called, false, 'no model call when everything fits');
});

test('the agent sees the whole pool with category, score and summary', async () => {
  const rows = mkRows(40);
  let seen = null;
  const llm = {
    async *stream(o) {
      seen = JSON.parse(o.messages[0].content[0].text);
      yield { type: 'text-delta', text: JSON.stringify({ keep: [0, 1, 2], reason: '只留最好的三篇' }) };
    },
  };
  const r = await chooseEdition({ llm, selection: { provider: 'm', model: 'm' }, rows, target: 30, ratio: { application: 1 }, signal: undefined });
  assert.equal(seen.length, 40, 'every candidate is supplied in one judgement');
  assert.equal(seen[0].category, 'application');
  assert.equal(seen[0].score, 9);
  assert.ok(seen[0].summary.length > 0);
  assert.equal(r.rows.length, 3, 'exactly what the agent kept');
  assert.equal(r.via, 'direct');
});

test('the instruction carries the goal, the seat counts and the one-per-story rule', async () => {
  const rows = mkRows(40);
  let system = '';
  const llm = {
    async *stream(o) {
      system = o.system;
      yield { type: 'text-delta', text: JSON.stringify({ keep: [0], reason: 'x' }) };
    },
  };
  await chooseEdition({ llm, selection: { provider: 'm', model: 'm' }, rows, target: 30, ratio: { application: 0.7, model: 0.2, hardware: 0.1 }, signal: undefined });
  assert.match(system, /30 篇/);
  assert.match(system, /application 21/);
  assert.match(system, /同一件事/);
  // No method is dictated: ordering and tie handling are the agent's call.
  assert.doesNotMatch(system, /同分|并列|按分数排序/);
});

test('an unusable verdict keeps the pool instead of publishing nothing', async () => {
  const rows = mkRows(40);
  const llm = { async *stream() { yield { type: 'text-delta', text: JSON.stringify({ keep: [], reason: '都不好' }) }; } };
  const r = await chooseEdition({ llm, selection: { provider: 'm', model: 'm' }, rows, target: 30, ratio: { application: 1 }, signal: undefined });
  assert.equal(r.emptyVerdict, true);
  assert.equal(r.rows.length, 40, 'a blank edition is worse than a full one');
});

test('out-of-range and duplicate indices are ignored', async () => {
  const rows = mkRows(40);
  const llm = { async *stream() { yield { type: 'text-delta', text: JSON.stringify({ keep: [1, 1, 99, -3, 2], reason: 'x' }) }; } };
  const r = await chooseEdition({ llm, selection: { provider: 'm', model: 'm' }, rows, target: 30, ratio: { application: 1 }, signal: undefined });
  assert.equal(r.rows.length, 2);
});

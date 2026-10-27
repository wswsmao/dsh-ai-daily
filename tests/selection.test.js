import test from 'node:test';
import assert from 'node:assert/strict';
import { selectEdition, buildVoteGroups, applyVotes } from '../lib/selection.js';
import { validateQuality } from '../lib/analysis.js';

// Quality always comes from the model; these tests attach a judgement the way the analyst would.
const art = (quality, over = {}) => ({
  id: `a${Math.random()}`,
  title: 'Agent 记忆系统 MemCurrent 发布',
  url: 'https://mp.weixin.qq.com/s/x',
  analysis: { status: 'technical', summary_zh: 'MemCurrent 架构与内部基准数据。', quality, topics: ['Agent'] },
  prescreen: { category: 'application', keep: true, point: 'MemCurrent 记忆架构发布' },
  ...over,
});

const goodQuality = { novelty: 2, specificity: 2, depth: 2, firstHand: 1, honesty: 2, total: 9 };
const weakQuality = { novelty: 0, specificity: 0, depth: 0, firstHand: 0, honesty: 0, total: 0 };

test('quality judgement round-trips through the model schema', () => {
  assert.deepEqual(validateQuality({ novelty: 2, specificity: 1, depth: 2, firstHand: 1, honesty: 2 }), { novelty: 2, specificity: 1, depth: 2, firstHand: 1, honesty: 2, total: 8 });
  assert.equal(validateQuality(null), null);
  assert.equal(validateQuality({ novelty: 5, specificity: 0, depth: 0, firstHand: 0, honesty: 0 }), null, 'out-of-range dimensions are rejected');
});

test('an article judged below the floor is dropped, never padded', () => {
  const r = selectEdition([art(weakQuality)], { target: 30, minScore: 6 });
  assert.equal(r.stats.selected, 0);
  assert.equal(r.stats.belowThreshold, 1);
});

test('an unjudged article is kept rather than silently discarded', () => {
  const r = selectEdition([art(null)], { target: 30, minScore: 6 });
  assert.equal(r.stats.unscored, 1);
  assert.equal(r.stats.selected, 1, 'missing model score must not mean "bad"');
});

test('compressed topic yields only what qualifies', () => {
  const rows = [
    art(goodQuality, { id: 'x' }),
    art(goodQuality, { id: 'y', prescreen: { category: 'hardware', keep: true, point: '推理引擎新版本' } }),
  ];
  const r = selectEdition(rows, { target: 30, minScore: 6 });
  assert.equal(r.stats.selected, 2);
  assert.equal(r.stats.counts.hardware, 1);
});

test('unused quota moves to the best remaining article', () => {
  const many = Array.from({ length: 25 }, (_, i) => art(goodQuality, { id: `app${i}`, prescreen: { category: 'application', keep: true, point: `点 ${i}` } }));
  const one = art(goodQuality, { id: 'hw', prescreen: { category: 'hardware', keep: true, point: 'vLLM 新版本' } });
  const r = selectEdition([...many, one], { target: 30, minScore: 6 });
  assert.equal(r.stats.selected, 26, 'ratio is not a cap when articles qualify');
});

test('vote groups only cover a duplicated information point', () => {
  const rows = [
    { article: art(goodQuality, { id: 'x1' }), quality: goodQuality, point: 'MemCurrent 记忆架构发布' },
    { article: art(goodQuality, { id: 'x2' }), quality: goodQuality, point: 'MemCurrent 记忆架构发布' },
    { article: art(goodQuality, { id: 'y1' }), quality: goodQuality, point: '另一个信息点' },
  ];
  const groups = buildVoteGroups(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].candidates.length, 2);
});

test('a vote keeps only the winner of each voted point', () => {
  const rows = [
    { article: art(goodQuality, { id: 'x1' }), quality: goodQuality, point: 'MemCurrent 记忆架构发布' },
    { article: art(goodQuality, { id: 'x2' }), quality: goodQuality, point: 'MemCurrent 记忆架构发布' },
  ];
  const kept = applyVotes(rows, { 'MemCurrent 记忆架构发布': [1] });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].article.id, 'x2');
});

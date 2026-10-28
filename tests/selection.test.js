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

test('an article with no pre-screen verdict never enters the edition', () => {
  // This is the shape produced when pass 2 opened articles without a keep-list: high score, but the
  // gate never ran on them. Industry reports reached the edition exactly this way.
  const ungated = art(goodQuality, { prescreen: undefined, id: 'bad' });
  const gated = art(goodQuality, { id: 'ok' });
  const r = selectEdition([ungated, gated], { target: 30, minScore: 6 });
  assert.equal(r.stats.selected, 1, 'only the pre-screened article is eligible');
  assert.equal(r.articles[0].id, 'ok');
});

test('an article the model explicitly rejected is never selected', () => {
  const rejected = art(goodQuality, { prescreen: { category: 'application', keep: false, point: 'x' }, id: 'rej' });
  const r = selectEdition([rejected], { target: 30, minScore: 6 });
  assert.equal(r.stats.selected, 0);
});

test('a high score cannot rescue an ungated article', () => {
  const perfect = art({ novelty: 2, specificity: 2, depth: 2, firstHand: 2, honesty: 2, total: 10 }, { prescreen: undefined });
  const r = selectEdition([perfect], { target: 30, minScore: 6 });
  assert.equal(r.stats.selected, 0, 'gating happens before quality ranking');
});

test('quality judgement round-trips through the model schema', () => {
  assert.deepEqual(validateQuality({ novelty: 2, specificity: 1, depth: 2, firstHand: 1, honesty: 2 }), { novelty: 2, specificity: 1, depth: 2, firstHand: 1, honesty: 2, total: 8 });
  assert.equal(validateQuality(null), null);
  assert.equal(validateQuality({ novelty: 5, specificity: 0, depth: 0, firstHand: 0, honesty: 0 }), null, 'out-of-range dimensions are rejected');
});

test('a pool smaller than the target keeps every article, even weak ones', () => {
  // Seats are empty, so a below-floor article is better than a gap. The floor only earns its keep
  // once there is competition for seats.
  const r = selectEdition([art(weakQuality)], { target: 30, minScore: 6 });
  assert.equal(r.stats.selected, 1);
  assert.equal(r.stats.shortPool, true);
  assert.equal(r.stats.belowThreshold, 0);
});

test('with more candidates than seats, the floor drops weak articles', () => {
  const strong = Array.from({ length: 29 }, (_, i) => art(goodQuality, { id: `s${i}`, prescreen: { category: 'application', keep: true, point: `strong point ${i}` } }));
  const weak = Array.from({ length: 5 }, (_, i) => art(weakQuality, { id: `w${i}`, prescreen: { category: 'application', keep: true, point: `weak point ${i}` } }));
  const r = selectEdition([...strong, ...weak], { target: 30, minScore: 6 });
  assert.equal(r.stats.selected, 29, 'weak articles are not used to pad the edition');
  assert.equal(r.stats.belowThreshold, 5);
  assert.ok(!r.stats.shortPool);
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

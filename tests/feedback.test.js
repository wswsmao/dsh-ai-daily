import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadFeedback, feedbackForAccount, feedbackSummary } from '../lib/feedback.js';

async function tmpFile(t, lines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'feedback.jsonl');
  await fs.writeFile(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf8');
  return file;
}

const now = new Date('2026-10-30T04:00:00Z');
const clock = () => now;
const vote = (over = {}) => ({
  at: '2026-10-29T10:00:00Z',
  verdict: 'bad',
  reason: '开源仓库功能介绍，不是架构层进展',
  articleId: 'a3',
  title: '某项目发布',
  account: '某号',
  category: 'application',
  ...over,
});

test('votes are aggregated per account and per category', async (t) => {
  const file = await tmpFile(t, [
    vote(),
    vote({ verdict: 'good', reason: '', title: '另一篇' }),
    vote({ account: '另一个号', reason: '商业通稿' }),
  ]);
  const f = await loadFeedback({ file, clock });
  assert.equal(f.total, 3);
  assert.equal(f.byAccount['某号'].bad, 1);
  assert.equal(f.byAccount['某号'].good, 1);
  assert.equal(f.byAccount['另一个号'].bad, 1);
  assert.equal(f.byCategory.application.bad, 2);
});

test('only reasons from down-votes are kept, newest last', async (t) => {
  const file = await tmpFile(t, [
    vote({ reason: '第一条理由' }),
    vote({ verdict: 'good', reason: '点赞不需要理由' }),
    vote({ reason: '第二条理由' }),
  ]);
  const f = await loadFeedback({ file, clock });
  const reasons = f.byAccount['某号'].reasons.map((r) => r.reason);
  assert.deepEqual(reasons, ['第一条理由', '第二条理由'], 'good votes carry no reason');
});

test('votes older than the window are ignored', async (t) => {
  const file = await tmpFile(t, [vote(), vote({ at: '2025-01-01T00:00:00Z', account: '很久以前' })]);
  const f = await loadFeedback({ file, sinceDays: 120, clock });
  assert.equal(f.total, 1);
  assert.equal(f.byAccount['很久以前'], undefined);
});

test('a missing file means no votes, not a failure', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-none-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = await loadFeedback({ file: path.join(dir, 'absent.jsonl'), clock });
  assert.equal(f.total, 0);
  assert.deepEqual(f.byAccount, {});
});

test('a malformed line fails the run instead of being skipped', async (t) => {
  const file = await tmpFile(t, [vote(), '{ not json']);
  await assert.rejects(() => loadFeedback({ file, clock }), /FEEDBACK_LINE_INVALID/u);
});

test('the per-candidate lookup returns facts only for a known account', async (t) => {
  const file = await tmpFile(t, [vote(), vote({ reason: '第二次被踩' })]);
  const f = await loadFeedback({ file, clock });
  const known = feedbackForAccount(f, '某号');
  assert.equal(known.bad, 2);
  assert.equal(known.reasons.length, 2);
  assert.equal(feedbackForAccount(f, '没投过票的号'), null, 'unknown source carries no facts');
  assert.equal(feedbackForAccount(f, ''), null);
});

test('the summary carries counts but no derived score or verdict', async (t) => {
  const file = await tmpFile(t, [vote(), vote({ verdict: 'good', reason: '' })]);
  const summary = feedbackSummary(await loadFeedback({ file, clock }));
  assert.equal(summary.votes, 2);
  assert.deepEqual(summary.accounts[0], { account: '某号', good: 1, bad: 1 });
  // Nothing that reads as a decision: no rate, no threshold, no exclude flag.
  assert.equal(Object.keys(summary).sort().join(','), 'accounts,categories,since_days,votes');
});

test('an empty log yields no summary at all', () => {
  assert.equal(feedbackSummary({ total: 0, byAccount: {}, byCategory: {}, sinceDays: 120 }), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeRepeats } from '../lib/repeat-judge.js';

const article = (over = {}) => ({
  id: over.id ?? 'today-1',
  title: over.title ?? 'Agent 记忆系统新发布',
  account: '某号',
  body_text: over.body_text ?? '正文内容：MemCurrent 发布，22.3% 提升到 68.4%。',
  analysis: { status: 'technical', summary_zh: '摘要', topics: over.topics ?? ['Agent'] },
});

const known = {
  'old-1': { reported_on: ['2026-10-26'], analysis: { summary_zh: '昨天推过的记忆系统文章', topics: ['Agent'] } },
  'old-2': { reported_on: [], analysis: { summary_zh: '没推过的不算', topics: ['Agent'] } },
};

test('the model decides a repost, and the verdict marks the article', async () => {
  const a = article();
  const llm = {
    async *stream(o) {
      const payload = JSON.parse(o.messages[0].content[0].text);
      assert.equal(payload.publishedBefore.length, 1, 'only previously published entries are offered');
      assert.equal(payload.publishedBefore[0].id, 'old-1');
      assert(payload.article.body.includes('MemCurrent'), 'the body is supplied, not just the title');
      yield { type: 'text-delta', text: JSON.stringify({ match: true, of: 'old-1', reason: '同一发布' }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const calls = await judgeRepeats({ llm, selection: { provider: 'mock', model: 'mock' }, articles: [a], known });
  assert.equal(calls, 1);
  assert.equal(a.repeated, true);
  assert.equal(a.repeat_of, 'old-1');
});

test('a genuine new article is kept', async () => {
  const a = article({ id: 'today-2', title: '完全不同的新系统' });
  const llm = { async *stream() { yield { type: 'text-delta', text: JSON.stringify({ match: false, of: '', reason: '不同系统' }) }; } };
  await judgeRepeats({ llm, selection: { provider: 'mock', model: 'mock' }, articles: [a], known });
  assert.equal(a.repeated, false);
});

test('a failed verdict leaves the article publishable', async () => {
  const a = article({ id: 'today-3' });
  const llm = { async *stream() { throw new Error('model down'); } };
  const calls = await judgeRepeats({ llm, selection: { provider: 'mock', model: 'mock' }, articles: [a], known });
  assert.equal(calls, 0);
  assert.notEqual(a.repeated, true, 'a judge failure must not mark the article as a repost');
});

test('articles with no prior history need no judgement', async () => {
  const a = article({ id: 'today-4', topics: ['没有历史'] });
  let called = false;
  const llm = { async *stream() { called = true; yield { type: 'text-delta', text: '{}' }; } };
  const calls = await judgeRepeats({ llm, selection: { provider: 'mock', model: 'mock' }, articles: [a], known });
  assert.equal(called, false, 'no prior pool means no model call');
  assert.equal(calls, 0);
});

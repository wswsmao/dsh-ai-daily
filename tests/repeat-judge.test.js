import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { judgeRepeats } from '../lib/repeat-judge.js';
import { fakeAgentContext, brokenAgentContext } from './helpers/fake-agent.js';

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

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repeat-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the agent decides a repost and the verdict marks the article', async (t) => {
  const dir = await tmpDir(t);
  const a = article();
  let seen = null;
  const { ctx } = fakeAgentContext(async (input) => {
    seen = input;
    return { repeats: { 'today-1': { match: true, of: 'old-1', reason: '同一发布' } } };
  });
  const calls = await judgeRepeats({ ctx, cwd: dir, dir, articles: [a], known });
  assert.equal(calls, 1);
  assert.equal(seen.published.length, 1, 'only previously published entries are offered');
  assert.equal(seen.published[0].id, 'old-1');
  assert.ok(seen.repeats[0].summary.length > 0, 'the article summary is supplied');
  assert.equal(a.repeated, true);
  assert.equal(a.repeat_of, 'old-1');
});

test('the comparison set is written to a file the agent reads', async (t) => {
  const dir = await tmpDir(t);
  const a = article({ id: 'today-2' });
  const { ctx } = fakeAgentContext(async () => ({ repeats: {} }));
  await judgeRepeats({ ctx, cwd: dir, dir, articles: [a], known });
  const file = JSON.parse(await fs.readFile(path.join(dir, 'repeats-input.json'), 'utf8'));
  assert.equal(file.repeats.length, 1);
  assert.equal(file.published.length, 1);
  const progress = JSON.parse(await fs.readFile(path.join(dir, 'repeats-progress.json'), 'utf8'));
  assert.equal(progress.state, 'done');
});

test('an article the agent did not list stays publishable', async (t) => {
  const dir = await tmpDir(t);
  const a = article({ id: 'today-3', title: '完全不同的新系统' });
  const { ctx } = fakeAgentContext(async () => ({ repeats: {} }));
  await judgeRepeats({ ctx, cwd: dir, dir, articles: [a], known });
  assert.notEqual(a.repeated, true);
});

test('a failed comparison must not hide articles', async (t) => {
  const dir = await tmpDir(t);
  const a = article({ id: 'today-4' });
  const calls = await judgeRepeats({ ctx: brokenAgentContext(), cwd: dir, dir, articles: [a], known });
  assert.equal(calls, 0);
  assert.notEqual(a.repeated, true, 'an unjudged article is not a repost');
});

test('articles with no prior history need no judgement', async (t) => {
  const dir = await tmpDir(t);
  const a = article({ id: 'today-5', topics: ['没有历史'] });
  let called = false;
  const { ctx } = fakeAgentContext(async () => {
    called = true;
    return { repeats: {} };
  });
  const calls = await judgeRepeats({ ctx, cwd: dir, dir, articles: [a], known: {} });
  assert.equal(called, false, 'no prior pool means no agent call');
  assert.equal(calls, 0);
});

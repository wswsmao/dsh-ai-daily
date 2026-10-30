import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { judgeRepeats } from '../lib/repeat-judge.js';
import { fakeAgentContext, brokenAgentContext } from './helpers/fake-agent.js';

/** Rows are addressed by position, never by id.
 *
 *  An id here is a 45-character string (`article:<base64>:<msgId>:<n>`). Asking a child to re-type a
 *  hundred of those produced a fabricated one carrying `reason: "placeholder"`, and because one unknown
 *  id failed the whole stage, a completed analysis of 113 articles was discarded. Integers cannot drift,
 *  which is why the screening and edition stages already work this way.
 */

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
    return { repeats: [{ index: 0, match: true, of: 0, reason: '同一发布' }] };
  });
  const calls = await judgeRepeats({ ctx, cwd: dir, dir, articles: [a], known });
  assert.equal(calls, 1);
  assert.equal(seen.published.length, 1, 'only previously published entries are offered');
  assert.equal(seen.repeats[0].index, 0, 'the row carries its position');
  assert.ok(seen.repeats[0].summary.length > 0, 'the article summary is supplied');
  assert.equal(a.repeated, true);
  assert.equal(a.repeat_of, 'old-1', 'the position maps back to the published id');
});

test('ids are not handed to the child at all', async (t) => {
  const dir = await tmpDir(t);
  const a = article({ id: 'today-2' });
  let seen = null;
  const { ctx } = fakeAgentContext(async (input) => {
    seen = input;
    return { repeats: [] };
  });
  await judgeRepeats({ ctx, cwd: dir, dir, articles: [a], known });
  // Nothing the child could copy: showing ids is what invited the fabricated one.
  assert.equal(seen.published[0].id, undefined, 'published rows carry no id');
  assert.equal(seen.repeats[0].id, undefined, 'today rows carry no id');
  assert.equal(typeof seen.published[0].index, 'number');
  assert.equal(typeof seen.repeats[0].index, 'number');
});

test('the comparison set is written to a file the agent reads', async (t) => {
  const dir = await tmpDir(t);
  const a = article({ id: 'today-3' });
  const { ctx } = fakeAgentContext(async () => ({ repeats: [] }));
  await judgeRepeats({ ctx, cwd: dir, dir, articles: [a], known });
  const file = JSON.parse(await fs.readFile(path.join(dir, 'repeats-input.json'), 'utf8'));
  assert.equal(file.repeats.length, 1);
  assert.equal(file.published.length, 1);
  const progress = JSON.parse(await fs.readFile(path.join(dir, 'repeats-progress.json'), 'utf8'));
  assert.equal(progress.state, 'done');
});

test('an article the agent did not list stays publishable', async (t) => {
  const dir = await tmpDir(t);
  const a = article({ id: 'today-4', title: '完全不同的新系统' });
  const { ctx } = fakeAgentContext(async () => ({ repeats: [] }));
  await judgeRepeats({ ctx, cwd: dir, dir, articles: [a], known });
  assert.notEqual(a.repeated, true);
});

test('a failed comparison stops the run instead of guessing', async (t) => {
  const dir = await tmpDir(t);
  const a = article({ id: 'today-5' });
  await assert.rejects(
    () => judgeRepeats({ ctx: brokenAgentContext(), cwd: dir, dir, articles: [a], known }),
    /REPEAT_JUDGE_FAILED/u,
  );
});

test('articles with no prior history need no judgement', async (t) => {
  const dir = await tmpDir(t);
  const a = article({ id: 'today-6', topics: ['没有历史'] });
  let called = false;
  const { ctx } = fakeAgentContext(async () => {
    called = true;
    return { repeats: [] };
  });
  const calls = await judgeRepeats({ ctx, cwd: dir, dir, articles: [a], known: {} });
  assert.equal(called, false, 'no prior pool means no agent call');
  assert.equal(calls, 0);
});

test('an out-of-range index is rejected and the offending value is named', async (t) => {
  const dir = await tmpDir(t);
  const a = article({ id: 'today-7' });
  const { ctx } = fakeAgentContext(async () => ({
    repeats: [
      { index: 0, match: true, of: 0, reason: '正常一条' },
      { index: 99, match: true, of: 0, reason: '越界一条' },
    ],
  }));
  await assert.rejects(
    () => judgeRepeats({ ctx, cwd: dir, dir, articles: [a], known }),
    /REPEAT_JUDGE_FAILED[\s\S]*index=99/u,
  );
});

test('an unsaturated of is rejected rather than silently dropped', async (t) => {
  const dir = await tmpDir(t);
  const a = article({ id: 'today-8' });
  const { ctx } = fakeAgentContext(async () => ({
    repeats: [{ index: 0, match: true, of: 42, reason: '指向不存在的历史条' }],
  }));
  await assert.rejects(
    () => judgeRepeats({ ctx, cwd: dir, dir, articles: [a], known }),
    /REPEAT_JUDGE_FAILED[\s\S]*of=42/u,
  );
});

test('a duplicated index is rejected', async (t) => {
  const dir = await tmpDir(t);
  const a = article({ id: 'today-9' });
  const { ctx } = fakeAgentContext(async () => ({
    repeats: [
      { index: 0, match: true, of: 0, reason: 'a' },
      { index: 0, match: false, reason: 'b' },
    ],
  }));
  await assert.rejects(
    () => judgeRepeats({ ctx, cwd: dir, dir, articles: [a], known }),
    /REPEAT_JUDGE_FAILED[\s\S]*出现两次/u,
  );
});

test('rows the analysis skipped are not addressable', async (t) => {
  const dir = await tmpDir(t);
  // The first article has no analysis, so it never reaches the child; position 0 is the second one.
  const skipped = { id: 'skip-1', title: '没有分析', account: '某号', analysis: { processing_error: 'boom' } };
  const judged = article({ id: 'today-10' });
  let seen = null;
  const { ctx } = fakeAgentContext(async (input) => {
    seen = input;
    return { repeats: [{ index: 0, match: true, of: 0, reason: 'ok' }] };
  });
  await judgeRepeats({ ctx, cwd: dir, dir, articles: [skipped, judged], known });
  assert.equal(seen.repeats.length, 1, 'only the analysed article is sent');
  assert.equal(judged.repeated, true, 'position 0 maps to the article that was actually sent');
  assert.notEqual(skipped.repeated, true);
});

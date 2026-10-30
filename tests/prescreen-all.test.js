import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prescreenAll } from '../lib/prescreen.js';
import { fakeAgentContext } from './helpers/fake-agent.js';

/** The whole pool is judged in one pass so a child can spot the same story arriving under several
 *  keywords. Three defects showed up while building it and are pinned here:
 *
 *  1. the same article under two keywords was judged twice, which the answer validator read as a
 *     duplicate-answer error;
 *  2. an empty pool returned a partial object, and the caller failed on `undefined` instead of simply
 *     judging nothing;
 *  3. a large pool has to be split by candidate count, with every piece still judged in full.
 */

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prescreen-all-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const verdictsFor = (input) => ({
  verdicts: (input.candidates ?? []).map((c) => ({
    index: c.index,
    keep: true,
    reason: '类型符合',
    category: 'application',
    point: `信息点 ${c.title}`,
  })),
});

const record = (title, account = '号') => ({ title, account, relative_date: '1小时前', snippet: '片段' });

test('an article appearing under two keywords is judged once and kept for both', async (t) => {
  const dir = await tmpDir(t);
  const seen = [];
  const { ctx } = fakeAgentContext(async (input) => {
    seen.push(input.candidates.length);
    return verdictsFor(input);
  });
  const shared = record('同一条');
  const result = await prescreenAll({
    ctx,
    cwd: dir,
    dir,
    entries: [
      { query: { id: 'q1', keyword: '关键词一' }, records: [shared, record('只有一的')] },
      { query: { id: 'q2', keyword: '关键词二' }, records: [shared] },
    ],
    policy: '策略',
    categories: { application: 'Agent' },
  });
  assert.deepEqual(seen, [2], 'the shared article is sent once, not twice');
  assert.equal(result.verdicts.size, 2);
  assert.deepEqual(result.keepByKeyword.get('q1').slice().sort((a, b) => a.localeCompare(b, 'zh')), ['同一条|号', '只有一的|号'].sort((a, b) => a.localeCompare(b, 'zh')));
  assert.deepEqual(result.keepByKeyword.get('q2'), ['同一条|号'], 'both keywords see their survivor');
});

test('an empty pool returns the same shape as a judged one', async (t) => {
  const dir = await tmpDir(t);
  const { ctx } = fakeAgentContext(async (input) => verdictsFor(input));
  const result = await prescreenAll({
    ctx,
    cwd: dir,
    dir,
    entries: [{ query: { id: 'q1', keyword: '空' }, records: [] }],
    policy: '策略',
    categories: { application: 'Agent' },
  });
  assert.equal(result.chunks, 0);
  assert.equal(result.calls, 0);
  assert.ok(result.verdicts instanceof Map, 'the caller reads verdicts unconditionally');
  assert.deepEqual(result.keepByKeyword.get('q1'), []);
});

test('a pool above one chunk is split by candidate count and every piece is judged', async (t) => {
  const dir = await tmpDir(t);
  const sizes = [];
  const { ctx } = fakeAgentContext(async (input) => {
    sizes.push(input.candidates.length);
    return verdictsFor(input);
  });
  const records = Array.from({ length: 55 }, (_, i) => record(`文章${i}`));
  const result = await prescreenAll({
    ctx,
    cwd: dir,
    dir,
    entries: [{ query: { id: 'q1', keyword: '大池' }, records }],
    policy: '策略',
    categories: { application: 'Agent' },
    chunkSize: 20,
    concurrency: 2,
  });
  assert.equal(result.chunks, 3);
  assert.deepEqual(sizes.slice().sort((a, b) => b - a), [20, 20, 15], 'chunks are sized by candidates, not keywords');
  assert.equal(result.verdicts.size, 55, 'every candidate still has a verdict');
  assert.equal(result.keepByKeyword.get('q1').length, 55);
});

test('a dropped verdict is rejected rather than silently accepted', async (t) => {
  const dir = await tmpDir(t);
  const { ctx } = fakeAgentContext(async (input) => {
    const all = verdictsFor(input);
    return { verdicts: all.verdicts.slice(0, -1) };
  });
  await assert.rejects(
    () =>
      prescreenAll({
        ctx,
        cwd: dir,
        dir,
        entries: [{ query: { id: 'q1', keyword: '缺条' }, records: [record('A'), record('B')] }],
        policy: '策略',
        categories: { application: 'Agent' },
      }),
    /ANSWER_INCOMPLETE/u,
  );
});

test('an unknown category fails with the title that carried it', async (t) => {
  const dir = await tmpDir(t);
  const { ctx } = fakeAgentContext(async (input) => ({
    verdicts: (input.candidates ?? []).map((c) => ({
      index: c.index,
      keep: true,
      reason: 'x',
      category: '不存在',
      point: 'p',
    })),
  }));
  await assert.rejects(
    () =>
      prescreenAll({
        ctx,
        cwd: dir,
        dir,
        entries: [{ query: { id: 'q1', keyword: 'k' }, records: [record('某篇标题')] }],
        policy: '策略',
        categories: { application: 'Agent' },
      }),
    /MODEL_CATEGORY_INVALID[\s\S]*某篇标题/u,
  );
});

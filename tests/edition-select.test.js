import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chooseEdition } from '../lib/edition-select.js';
import { toRows } from '../lib/selection.js';
import { fakeAgentContext, brokenAgentContext } from './helpers/fake-agent.js';

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
  Array.from({ length: n }, (_, i) =>
    toRows([art({ id: `r${i}`, category, point: `p${category}${i}` })]),
  ).flat();

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edition-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const baseArgs = (dir, rows, extra = {}) => ({
  cwd: dir,
  dir,
  rows,
  target: 30,
  ratio: { application: 1 },
  categories: { application: 'Agent' },
  ...extra,
});

test('a pool that cannot fill the edition is published whole, without an agent', async (t) => {
  const dir = await tmpDir(t);
  const rows = mkRows(12);
  let called = false;
  const { ctx } = fakeAgentContext(async () => {
    called = true;
    return { keep: [] };
  });
  const r = await chooseEdition({ ...baseArgs(dir, rows), ctx });
  assert.equal(r.via, 'none');
  assert.equal(r.rows.length, 12);
  assert.equal(called, false, 'no agent when everything fits');
});

test('the pool reaches the agent as a file', async (t) => {
  const dir = await tmpDir(t);
  const rows = mkRows(40);
  let seen = null;
  const { ctx } = fakeAgentContext(async (input) => {
    seen = input;
    return { keep: [0, 1, 2], reason: '只留最好的三篇' };
  });
  const r = await chooseEdition({ ...baseArgs(dir, rows), ctx });
  assert.equal(seen.candidates.length, 40, 'the whole pool arrives as file content');
  assert.equal(seen.candidates[0].category, 'application');
  assert.equal(seen.candidates[0].score, 9);
  assert.ok(seen.candidates[0].summary.length > 0);
  assert.equal(r.rows.length, 3, 'exactly what the agent kept');
  assert.equal(r.via, 'agent');
});

test('the instruction states the goal, seat counts and one-per-story rule', async (t) => {
  const dir = await tmpDir(t);
  const rows = mkRows(40);
  const { ctx } = fakeAgentContext(async () => ({ keep: [0], reason: 'x' }));
  await chooseEdition({
    ...baseArgs(dir, rows),
    ctx,
    ratio: { application: 0.7, model: 0.2, hardware: 0.1 },
    categories: { application: 'Agent', model: '训练', hardware: '芯片' },
  });
  const progress = JSON.parse(await fs.readFile(path.join(dir, 'edition-progress.json'), 'utf8'));
  assert.equal(progress.state, 'done');
  const input = JSON.parse(await fs.readFile(path.join(dir, 'edition-input.json'), 'utf8'));
  assert.equal(input.candidates.length, 40);
});

test('an unusable verdict keeps the pool instead of publishing nothing', async (t) => {
  const dir = await tmpDir(t);
  const rows = mkRows(40);
  const { ctx } = fakeAgentContext(async () => ({ keep: [], reason: '都不好' }));
  const r = await chooseEdition({ ...baseArgs(dir, rows), ctx });
  assert.equal(r.emptyVerdict, true);
  assert.equal(r.rows.length, 40, 'a blank edition is worse than a full one');
});

test('out-of-range and duplicate indices are ignored', async (t) => {
  const dir = await tmpDir(t);
  const rows = mkRows(40);
  const { ctx } = fakeAgentContext(async () => ({ keep: [1, 1, 99, -3, 2], reason: 'x' }));
  const r = await chooseEdition({ ...baseArgs(dir, rows), ctx });
  assert.equal(r.rows.length, 2);
});

test('no reachable agent is an error, never a silent fallback', async (t) => {
  const dir = await tmpDir(t);
  const rows = mkRows(40);
  await assert.rejects(() => chooseEdition({ ...baseArgs(dir, rows), ctx: brokenAgentContext() }), /SUBAGENT_UNAVAILABLE/);
  const progress = JSON.parse(await fs.readFile(path.join(dir, 'edition-progress.json'), 'utf8'));
  assert.equal(progress.state, 'failed');
});

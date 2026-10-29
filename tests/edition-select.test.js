import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  Array.from({ length: n }, (_, i) =>
    toRows([art({ id: `r${i}`, category, point: `p${category}${i}` })])[0],
  );

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edition-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a pool that cannot fill the edition is published whole, without calling the model', async (t) => {
  const dir = await tmpDir(t);
  const rows = mkRows(12);
  let called = false;
  const llm = {
    async *stream() {
      called = true;
      yield { type: 'text-delta', text: '{}' };
    },
  };
  const r = await chooseEdition({
    ctx: {},
    cwd: dir,
    dir,
    llm,
    selection: { provider: 'm', model: 'm' },
    rows,
    target: 30,
    ratio: { application: 1 },
    categories: { application: 'Agent' },
  });
  assert.equal(r.via, 'none');
  assert.equal(r.rows.length, 12);
  assert.equal(called, false, 'no model call when everything fits');
});

test('the pool reaches the model as a file, not as prompt text', async (t) => {
  const dir = await tmpDir(t);
  const rows = mkRows(40);
  let seenPayload = null;
  const llm = {
    async *stream(o) {
      seenPayload = JSON.parse(o.messages[0].content[0].text);
      yield { type: 'text-delta', text: JSON.stringify({ keep: [0, 1, 2], reason: '只留最好的三篇' }) };
    },
  };
  const r = await chooseEdition({
    ctx: {},
    cwd: dir,
    dir,
    llm,
    selection: { provider: 'm', model: 'm' },
    rows,
    target: 30,
    ratio: { application: 1 },
    categories: { application: 'Agent' },
  });
  // The same pool must exist as a file for an agent to read; the direct fallback reuses it.
  const inputFile = path.join(dir, 'edition-input.json');
  const file = JSON.parse(await fs.readFile(inputFile, 'utf8'));
  assert.equal(file.candidates.length, 40, 'the pool is written to a file');
  assert.equal(file.candidates[0].category, 'application');
  assert.equal(file.candidates[0].score, 9);
  assert.equal(seenPayload.candidates.length, 40, 'the fallback carries the same data');
  assert.equal(r.rows.length, 3, 'exactly what the model kept');
});

test('the instruction states the goal, seat counts and one-per-story rule', async (t) => {
  const dir = await tmpDir(t);
  const rows = mkRows(40);
  let system = '';
  const llm = {
    async *stream(o) {
      system = o.system;
      yield { type: 'text-delta', text: JSON.stringify({ keep: [0], reason: 'x' }) };
    },
  };
  await chooseEdition({
    ctx: {},
    cwd: dir,
    dir,
    llm,
    selection: { provider: 'm', model: 'm' },
    rows,
    target: 30,
    ratio: { application: 0.7, model: 0.2, hardware: 0.1 },
    categories: { application: 'Agent', model: '训练', hardware: '芯片' },
  });
  assert.match(system, /30 篇/);
  assert.match(system, /application 21/);
  assert.match(system, /同一件事/);
  assert.doesNotMatch(system, /同分|并列|按分数排序/);
});

test('an unusable verdict keeps the pool instead of publishing nothing', async (t) => {
  const dir = await tmpDir(t);
  const rows = mkRows(40);
  const llm = {
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ keep: [], reason: '都不好' }) };
    },
  };
  const r = await chooseEdition({
    ctx: {},
    cwd: dir,
    dir,
    llm,
    selection: { provider: 'm', model: 'm' },
    rows,
    target: 30,
    ratio: { application: 1 },
    categories: { application: 'Agent' },
  });
  assert.equal(r.emptyVerdict, true);
  assert.equal(r.rows.length, 40, 'a blank edition is worse than a full one');
});

test('out-of-range and duplicate indices are ignored', async (t) => {
  const dir = await tmpDir(t);
  const rows = mkRows(40);
  const llm = {
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ keep: [1, 1, 99, -3, 2], reason: 'x' }) };
    },
  };
  const r = await chooseEdition({
    ctx: {},
    cwd: dir,
    dir,
    llm,
    selection: { provider: 'm', model: 'm' },
    rows,
    target: 30,
    ratio: { application: 1 },
    categories: { application: 'Agent' },
  });
  assert.equal(r.rows.length, 2);
});

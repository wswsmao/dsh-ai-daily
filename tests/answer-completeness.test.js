import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFileJob } from '../lib/file-job.js';

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } } } } },
};

/** A child whose first attempt answers incompletely and whose second attempt is complete. One real run
 *  dropped a single candidate out of 21; failing the boundary check made that end the whole run. */
function partialThenComplete(firstItems, secondItems) {
  let calls = 0;
  return {
    calls: () => calls,
    ctx: {
      subagents: {
        list: () => ['fork'],
        async startActivation() {
          calls += 1;
          const items = calls === 1 ? firstItems : secondItems;
          return {
            childId: 'c',
            result: Promise.resolve({ stopReason: 'completed', structured: { items } }),
            dispose: async () => {},
          };
        },
      },
      agents: {
        currentInitiator: () => ({ id: 'p' }),
        withInitiator: (_a, op) => op(),
        async create() {
          return { agent: { id: 'o' }, dispose: async () => {} };
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'm', model: 'm' }) },
      get(n) {
        return this[n];
      },
    },
  };
}

const base = (dir) => ({
  cwd: dir,
  dir,
  name: 'job',
  input: { rows: [0, 1, 2] },
  instruction: '判断',
  schema: SCHEMA,
  label: 'job',
});

test('an incomplete answer reruns the job instead of ending the run', async (t) => {
  const dir = await tmpDir(t);
  const { ctx, calls } = partialThenComplete([{ n: 0 }, { n: 1 }], [{ n: 0 }, { n: 1 }, { n: 2 }]);
  let attempt = 0;
  const answer = await runFileJob({
    ...base(dir),
    ctx,
    validate: (structured) => {
      attempt += 1;
      const got = new Set((structured.items ?? []).map((i) => i.n));
      const missing = [0, 1, 2].filter((n) => !got.has(n));
      if (missing.length) throw new Error(`ANSWER_INCOMPLETE: 缺 ${missing.join(',')}`);
    },
  });
  assert.equal(calls(), 2, 'the job ran a second time');
  assert.equal(attempt, 2, 'each attempt was validated');
  assert.equal(answer.items.length, 3, 'the complete answer is accepted');
});

test('two incomplete answers still fail the job', async (t) => {
  const dir = await tmpDir(t);
  const { ctx, calls } = partialThenComplete([{ n: 0 }], [{ n: 1 }]);
  await assert.rejects(
    () =>
      runFileJob({
        ...base(dir),
        ctx,
        validate: (structured) => {
          const got = new Set((structured.items ?? []).map((i) => i.n));
          if (!got.has(0) || !got.has(1) || !got.has(2)) throw new Error('ANSWER_INCOMPLETE: 缺条目');
        },
      }),
    /ANSWER_INCOMPLETE/u,
  );
  assert.equal(calls(), 2, 'exactly two attempts, then the failure stands');
});

test('a complete first answer is not retried', async (t) => {
  const dir = await tmpDir(t);
  const { ctx, calls } = partialThenComplete([{ n: 0 }, { n: 1 }, { n: 2 }], []);
  const answer = await runFileJob({ ...base(dir), ctx, validate: () => {} });
  assert.equal(calls(), 1);
  assert.equal(answer.items.length, 3);
});

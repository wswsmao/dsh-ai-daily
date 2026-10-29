import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFileJob } from '../lib/file-job.js';
import { fakeAgentContext, brokenAgentContext, silentAgentContext } from './helpers/fake-agent.js';

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filejob-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: { type: 'string' } },
};

test('the answer comes back as a structured result, and the caller writes the file', async (t) => {
  const dir = await tmpDir(t);
  const { ctx, seen } = fakeAgentContext(async () => ({ value: 'judged' }));
  const answer = await runFileJob({
    ctx,
    cwd: dir,
    dir,
    name: 'job',
    input: { candidates: [{ index: 0 }] },
    instruction: '判断',
    schema: SCHEMA,
    label: 'job',
  });
  assert.deepEqual(answer, { value: 'judged' });
  // The child is asked for no write at all: that dependency is what broke a real run.
  assert.doesNotMatch(seen.prompts[0], /输出文件/u);
  assert.match(seen.prompts[0], /输入文件/u);
  assert.deepEqual(seen.schema, SCHEMA, 'the schema is passed to the child');
  // The caller persisted the answer itself.
  const written = JSON.parse(await fs.readFile(path.join(dir, 'job-output.json'), 'utf8'));
  assert.deepEqual(written, { value: 'judged' });
});

test('the input is still handed over as a file to read', async (t) => {
  const dir = await tmpDir(t);
  const { ctx } = fakeAgentContext(async (input) => ({ value: String(input.rows.length) }));
  await runFileJob({
    ctx,
    cwd: dir,
    dir,
    name: 'job',
    input: { rows: [1, 2, 3] },
    instruction: '判断',
    schema: SCHEMA,
    label: 'job',
  });
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'job-input.json'), 'utf8'));
  assert.equal(onDisk.rows.length, 3, 'the whole input is on disk for the child to read');
});

test('a child that completes without a structured answer fails loudly', async (t) => {
  const dir = await tmpDir(t);
  const err = await runFileJob({
    ctx: silentAgentContext(),
    cwd: dir,
    dir,
    name: 'job',
    input: {},
    instruction: '判断',
    schema: SCHEMA,
    label: 'job',
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, 'the job does not succeed');
  assert.match(err.message, /SUBAGENT_RESULT_MISSING/u);
  const progress = JSON.parse(await fs.readFile(path.join(dir, 'job-progress.json'), 'utf8'));
  assert.equal(progress.state, 'failed');
  assert.match(progress.error, /SUBAGENT_RESULT_MISSING/u);
});

test('no reachable agent is an error, never a silent fallback', async (t) => {
  const dir = await tmpDir(t);
  await assert.rejects(
    () =>
      runFileJob({
        ctx: brokenAgentContext(),
        cwd: dir,
        dir,
        name: 'job',
        input: {},
        instruction: '判断',
        schema: SCHEMA,
        label: 'job',
      }),
    /SUBAGENT_UNAVAILABLE/u,
  );
});

test('a child that stops early is reported with its stop reason', async (t) => {
  const dir = await tmpDir(t);
  const ctx = {
    subagents: {
      list: () => ['fork'],
      async startActivation() {
        return { childId: 'c', result: Promise.resolve({ stopReason: 'error', output: [] }), dispose: async () => {} };
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
  };
  await assert.rejects(
    () =>
      runFileJob({
        ctx,
        cwd: dir,
        dir,
        name: 'job',
        input: {},
        instruction: '判断',
        schema: SCHEMA,
        label: 'job',
      }),
    /SUBAGENT_STOPPED:error/u,
  );
});

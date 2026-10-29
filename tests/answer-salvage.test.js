import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFileJob } from '../lib/file-job.js';

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'salvage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' } } } } },
};

/** A child that answers with the JSON inside a fenced block instead of using the structured channel.
 *  The platform reports the turn as an error, yet the answer is complete; discarding it threw away a
 *  finished weekly screening. */
function fencedAgentContext(text, stopReason = 'error') {
  return {
    subagents: {
      list: () => ['fork'],
      async startActivation() {
        return {
          childId: 'c',
          result: Promise.resolve({ stopReason, output: [{ type: 'text', text }] }),
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
  };
}

const args = (dir) => ({
  cwd: dir,
  dir,
  name: 'job',
  input: { candidates: [] },
  instruction: '判断',
  schema: SCHEMA,
  label: 'job',
});

test('a fenced answer is salvaged instead of discarding a finished judgement', async (t) => {
  const dir = await tmpDir(t);
  const text = '```json\n{ "verdicts": [ { "index": 0 }, { "index": 1 } ] }\n```';
  const answer = await runFileJob({ ...args(dir), ctx: fencedAgentContext(text) });
  assert.equal(answer.verdicts.length, 2);
  const written = JSON.parse(await fs.readFile(path.join(dir, 'job-output.json'), 'utf8'));
  assert.equal(written.verdicts.length, 2);
});

test('prose with no JSON object still fails', async (t) => {
  const dir = await tmpDir(t);
  await assert.rejects(
    () => runFileJob({ ...args(dir), ctx: fencedAgentContext('我判断这三篇都不错，建议都保留。') }),
    /SUBAGENT_STOPPED:error/u,
  );
});

test('a truncated object is not accepted as a partial answer', async (t) => {
  const dir = await tmpDir(t);
  await assert.rejects(
    () => runFileJob({ ...args(dir), ctx: fencedAgentContext('```json\n{ "verdicts": [ { "index": 0') }),
    /SUBAGENT_STOPPED:error/u,
  );
});

test('a completed turn with a structured answer ignores stray prose', async (t) => {
  const dir = await tmpDir(t);
  const ctx = {
    subagents: {
      list: () => ['fork'],
      async startActivation() {
        return {
          childId: 'c',
          result: Promise.resolve({ stopReason: 'completed', structured: { verdicts: [] }, output: [] }),
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
  };
  const answer = await runFileJob({ ...args(dir), ctx });
  assert.deepEqual(answer, { verdicts: [] });
});

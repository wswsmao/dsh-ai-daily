import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFileJob } from '../lib/file-job.js';
import { scheduledAgentContext } from './helpers/fake-agent.js';

/** The judge must be a fresh child, never a fork of the parent's conversation.
 *
 *  `fork` seeds the child with the parent's session log; `spawn` starts it with none. A scheduled run
 *  of this plugin inherited a session whose log was a long conversation about maintaining this plugin,
 *  and all three screening children continued that thread instead of judging: 355 tool calls between
 *  them, roughly fifty reading the input file and the rest editing source, reloading plugins and
 *  starting further runs. Nothing was judged in forty minutes.
 *
 *  The provider choice is what keeps the child's world equal to its prompt.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'tmp-prescreen-provider');

async function tmpDir(t) {
  await fs.mkdir(dir, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: { type: 'string' } },
};

/** Record which provider a job actually activated. */
function providerRecording(providers) {
  const made = scheduledAgentContext(async () => ({ value: 'ok' }), { preset: { id: 'cordis' } });
  const seen = { provider: null };
  made.ctx.subagents.list = () => providers;
  const original = made.ctx.subagents.startActivation;
  made.ctx.subagents.startActivation = async (spec) => {
    seen.provider = spec.provider;
    return original(spec);
  };
  return { ctx: made.ctx, seen };
}

async function run(ctx, name) {
  return runFileJob({
    ctx,
    cwd: dir,
    dir,
    name,
    input: {},
    instruction: '判断',
    schema: SCHEMA,
    label: name,
  });
}

test('a judgement job runs on spawn, not on a fork of the parent', async (t) => {
  const d = await tmpDir(t);
  const { ctx, seen } = providerRecording(['fork', 'spawn']);
  await run(ctx, `job-${path.basename(d)}-a`);
  assert.equal(seen.provider, 'spawn', 'a fork would hand the child the parent conversation');
});

test('spawn is chosen even when fork is listed first', async (t) => {
  const d = await tmpDir(t);
  const { ctx, seen } = providerRecording(['fork', 'spawn', 'other']);
  await run(ctx, `job-${path.basename(d)}-b`);
  assert.equal(seen.provider, 'spawn');
});

test('a composition that only offers fork still runs', async (t) => {
  const d = await tmpDir(t);
  const { ctx, seen } = providerRecording(['fork']);
  // Not a silent downgrade: the job still reads the same file and returns the same answer, it simply
  // arrives with context it does not need. Failing here would break a deployment that cannot offer spawn.
  const answer = await run(ctx, `job-${path.basename(d)}-c`);
  assert.deepEqual(answer, { value: 'ok' });
  assert.equal(seen.provider, 'fork');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFileJob } from '../lib/file-job.js';
import { fakeAgentContext, scheduledAgentContext } from './helpers/fake-agent.js';

/** A scheduled run has no live conversation to own a child agent, so this module creates one. That
 *  owner is the only place a preset can enter the chain: a `fork` child cannot select one itself, it
 *  inherits whatever its parent joined.
 *
 *  The failure this pins: an owner created without a preset falls back to the host realm, and the child
 *  inherits a tool set nobody chose. One real run lost `read` that way and spent 89 minutes trying to
 *  open its input file through remote-shell tools that refuse a local session, then answered nothing.
 */

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: { type: 'string' } },
};

const base = (dir, ctx) => ({
  ctx,
  cwd: dir,
  dir,
  name: 'job',
  input: { candidates: [{ index: 0 }] },
  instruction: '判断',
  schema: SCHEMA,
  label: 'job',
});

test('a scheduled owner joins the deployment default preset', async (t) => {
  const dir = await tmpDir(t);
  const { ctx, seen } = scheduledAgentContext(async () => ({ value: 'ok' }), { preset: { id: 'cordis' } });
  await runFileJob(base(dir, ctx));
  assert.equal(seen.created.length, 1, 'the run had no live initiator, so it created an owner');
  assert.equal(seen.mounted.length, 1, 'the owner joined a preset during setup');
  assert.equal(seen.mounted[0].id, 'cordis');
  // The header must record the same preset: a resumed run reconstructs its composition from it.
  assert.equal(seen.created[0].meta.agentPreset, 'cordis');
});

test('a live initiator is reused and no preset work happens', async (t) => {
  const dir = await tmpDir(t);
  const { ctx, seen } = fakeAgentContext(async () => ({ value: 'ok' }), { preset: { id: 'cordis' } });
  await runFileJob(base(dir, ctx));
  assert.equal(seen.created.length, 0, 'the caller already owns an agent');
  assert.equal(seen.mounted.length, 0);
});

test('a composition without presets still runs: the host realm is the only realm', async (t) => {
  const dir = await tmpDir(t);
  const { ctx, seen } = scheduledAgentContext(async () => ({ value: 'ok' }));
  const answer = await runFileJob(base(dir, ctx));
  assert.deepEqual(answer, { value: 'ok' });
  assert.equal(seen.created.length, 1);
  assert.equal(seen.mounted.length, 0, 'nothing to join is not a degradation here');
  assert.equal(seen.created[0].meta.agentPreset, undefined);
});

test('a declared but broken preset fails loudly instead of leaving the child tool-less', async (t) => {
  const dir = await tmpDir(t);
  const { ctx } = scheduledAgentContext(async () => ({ value: 'ok' }), {
    preset: { id: 'cordis', broken: 'tool-fs failed to activate' },
  });
  await assert.rejects(() => runFileJob(base(dir, ctx)), /AGENT_PRESET_INVALID[\s\S]*tool-fs failed to activate/u);
});

test('an unusable preset service answer fails rather than silently degrading', async (t) => {
  const dir = await tmpDir(t);
  const { ctx } = scheduledAgentContext(async () => ({ value: 'ok' }), { preset: { resolveError: new Error('boom') } });
  await assert.rejects(() => runFileJob(base(dir, ctx)), /boom/u);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { recordTolerated, safeError } from '../lib/io.js';

test('a tolerated failure is recorded with where and reason', () => {
  const state = {};
  recordTolerated(state, 'pruneRuns', new Error('EBUSY: file locked'));
  assert.equal(state.tolerated.length, 1);
  assert.equal(state.tolerated[0].where, 'pruneRuns');
  assert.match(state.tolerated[0].error, /EBUSY/u);
  assert.ok(state.tolerated[0].at);
});

test('the tolerated log stays bounded', () => {
  const state = {};
  for (let i = 0; i < 260; i += 1) recordTolerated(state, 'loop', new Error('e' + i));
  assert.equal(state.tolerated.length, 200, 'the log is capped so state cannot grow without limit');
  assert.match(state.tolerated.at(-1).error, /e259/u, 'the newest entry survives');
});

test('secrets never reach the log', () => {
  const state = {};
  recordTolerated(state, 'x', new Error('failed token=abc123 at https://example.org/y'));
  const entry = state.tolerated[0];
  assert.doesNotMatch(entry.error, /abc123/u, 'token values are redacted');
  assert.doesNotMatch(entry.error, /example\.org/u, 'urls are redacted');
});

test('recording without a state is a no-op', () => {
  assert.doesNotThrow(() => recordTolerated(undefined, 'x', new Error('e')));
});

test('safeError keeps the message and caps its length', () => {
  assert.equal(safeError(new Error('boom')), 'boom');
  assert.equal(safeError(new Error('x'.repeat(900))).length, 500);
});

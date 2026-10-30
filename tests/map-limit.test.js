import test from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../lib/io.js';

/** A failing item fails the stage that owns the batch, so waiting for its siblings cannot change the
 *  outcome. That wait was real: one screening piece failed at 18:36 and the run only learned about it
 *  when the slowest piece gave up at 19:29, with a 45-minute per-piece ceiling above that.
 *
 *  Failing fast only shortens the WAIT. It does not cancel work already handed out.
 */

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('failFast surfaces the first failure without waiting for slow siblings', async () => {
  const started = Date.now();
  await assert.rejects(
    () =>
      mapLimit(
        ['fast-fail', 'slow-ok', 'slow-ok-2'],
        3,
        async (item) => {
          if (item === 'fast-fail') {
            await settle(5);
            throw new Error('PIECE_FAILED');
          }
          await settle(300);
          return item;
        },
        undefined,
        true,
      ),
    /PIECE_FAILED/u,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `returned in ${elapsed}ms instead of waiting out the slow siblings`);
});

test('the default still waits for every item before reporting a failure', async () => {
  const started = Date.now();
  await assert.rejects(
    () =>
      mapLimit(
        ['fast-fail', 'slow-ok'],
        2,
        async (item) => {
          if (item === 'fast-fail') {
            await settle(5);
            throw new Error('PIECE_FAILED');
          }
          await settle(200);
          return item;
        },
        undefined,
      ),
    /PIECE_FAILED/u,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 180, `joined all work (${elapsed}ms) when failFast was not requested`);
});

test('failFast still returns every result when nothing fails', async () => {
  const out = await mapLimit([1, 2, 3], 2, async (n) => n * 2, undefined, true);
  assert.deepEqual(out, [2, 4, 6]);
});

test('an empty list never waits on the failure signal', async () => {
  assert.deepEqual(await mapLimit([], 3, async () => 1, undefined, true), []);
});

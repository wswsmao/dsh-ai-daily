import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Two ways the publishing tail could ship an edition nobody asked for.
 *
 *  1. A cancellation cleared the abort signal so the tail would still write, commit and announce — that
 *     grace belongs to a budget timeout, which spent its allowance and should not lose the work it did.
 *     A cancelled run shipped a page reading "精选 0 篇" to WeChat this way.
 *  2. A run whose pool produced nothing still archived and notified, because "0 articles" was not
 *     treated as a failure. An empty edition is a broken run that finished, not a small edition.
 *
 *  Source-level because both are control flow inside one long stage; the alternative is driving a whole
 *  run to observe a branch.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await fs.readFile(path.join(here, '..', 'lib', 'pipeline.js'), 'utf8');

test('the tail is entered only when the run was not cancelled', () => {
  const guard = source.indexOf('if(!budgetExceeded())checkAbort(signal);');
  assert.ok(guard > 0, 'the cancellation guard exists');
  // The guard must come before the tail work that archives and notifies.
  const archive = source.indexOf("state.phase='archiving'");
  assert.ok(archive > 0, 'the archive step exists');
  assert.ok(guard < archive, 'the guard runs before archiving');
  // And it must not fire for a budget stop: that is the case the tail is for.
  assert.match(source, /if\(!budgetExceeded\(\)\)checkAbort\(signal\);/u);
});

test('a budget timeout still reaches the tail: the guard cancels only real cancellation', () => {
  // The distinction lives in checkAbort plus the budget predicate, not in the tail clearing the signal.
  assert.match(source, /const tailSignal=signal\.aborted\?undefined:signal;/u);
  assert.match(source, /budgetExceeded/u);
});

test('an empty selection fails the run instead of archiving a zero-article edition', () => {
  assert.match(source, /EMPTY_EDITION/u);
  // A pool that yielded nothing after a successful judgement fails; an upstream empty collection and a
  // budget stop both archive what they have, and neither is ever announced.
  assert.match(source, /poolRows\.length/u);
  assert.match(source, /const silentEmpty=/u);
  const emptyCheck = source.indexOf('EMPTY_EDITION');
  const archive = source.indexOf("state.phase='archiving'");
  assert.ok(emptyCheck > 0 && emptyCheck < archive, 'the empty check precedes archiving');
});

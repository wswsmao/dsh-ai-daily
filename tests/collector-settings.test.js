import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStartOptions } from '../../dsh-wechat-search/lib/validation.js';

/** The collector validator walks `Object.entries(settings)`, so an optional setting left as undefined
 *  is present as a key with a non-integer value and fails the whole query. A daily run failed every
 *  query with "boundary_slack_hours must be a non-negative integer" after the pipeline began spreading
 *  an undefined default into the settings it hands over.
 */

test('settings that simply omit an optional field are accepted', () => {
  const options = { settings: { timeout_minutes: 10, delay_ms: 180, max_retries: 1 } };
  assert.doesNotThrow(() => validateStartOptions(options));
});

test('an explicit slack value is accepted', () => {
  const options = { settings: { timeout_minutes: 10, delay_ms: 180, max_retries: 1, boundary_slack_hours: 6 } };
  assert.doesNotThrow(() => validateStartOptions(options));
});

test('an undefined slack value is rejected, which is why the caller must omit the key', () => {
  const options = { settings: { timeout_minutes: 10, delay_ms: 180, max_retries: 1, boundary_slack_hours: undefined } };
  assert.throws(() => validateStartOptions(options), /boundary_slack_hours/u);
});

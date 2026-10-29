import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTPUT_SCHEMA as PRESCREEN } from '../lib/prescreen.js';
import { OUTPUT_SCHEMA as EDITION } from '../lib/edition-select.js';
import { OUTPUT_SCHEMA as REPEAT } from '../lib/repeat-judge.js';

/** The platform accepts a narrow JSON Schema subset. In particular `additionalProperties` must be a
 *  boolean: declaring a per-key object shape under it fails the entire run with
 *  "unsupported JSON schema: ... additionalProperties must be a boolean". A real weekly run died that
 *  way, so the schemas this plugin hands over are checked here rather than discovered at run time.
 */
const ALLOWED_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'oneOf',
  'description',
  'minimum',
  'maximum',
]);

/** Walk a schema, checking keyword support. Values of `properties` are themselves schemas, so they are
 *  walked by name rather than treated as unknown keywords; `required`/`enum` hold plain data. */
function inspect(node, where, problems) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (!ALLOWED_KEYS.has(k)) problems.push(`${where}.${k}: 平台不支持的 schema 关键字`);
    if (k === 'additionalProperties' && typeof v !== 'boolean') {
      problems.push(`${where}.additionalProperties: 必须是 boolean，收到 ${typeof v}`);
    }
    if (k === 'properties') {
      for (const [prop, sub] of Object.entries(v)) inspect(sub, `${where}.properties.${prop}`, problems);
    } else if (k === 'items') {
      inspect(v, `${where}.items`, problems);
    } else if (k === 'oneOf') {
      (Array.isArray(v) ? v : []).forEach((sub, i) => inspect(sub, `${where}.oneOf[${i}]`, problems));
    }
  }
}

const CASES = [
  ['prescreen', PRESCREEN],
  ['edition-select', EDITION],
  ['repeat-judge', REPEAT],
];

for (const [name, schema] of CASES) {
  test(`${name} hands over a schema the platform accepts`, () => {
    const problems = [];
    inspect(schema, 'schema', problems);
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.equal(schema.type, 'object', 'root must be an object');
  });
}

test('a keyed map is expressed as a list, because additionalProperties cannot carry a shape', () => {
  // Both schemas used to describe their answer as an object keyed by candidate id, which the platform
  // rejects. The list form is the portable one, and the caller builds the map from it.
  assert.equal(PRESCREEN.properties.verdicts.type, 'array');
  assert.equal(REPEAT.properties.repeats.type, 'array');
  assert.ok(PRESCREEN.properties.verdicts.items.required.includes('index'));
  assert.ok(REPEAT.properties.repeats.items.required.includes('id'));
});

test('every schema requires its answer field so an empty reply is rejected', () => {
  for (const [name, schema] of CASES) {
    assert.ok(Array.isArray(schema.required) && schema.required.length > 0, `${name} 应声明 required`);
    assert.equal(schema.additionalProperties, false, `${name} 应禁止多余字段`);
  }
});

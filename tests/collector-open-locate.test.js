import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The collector locates an article row by index, with a title fallback. The title is what decides
 *  identity: when the list shifts (a newer article inserted, or one removed) the index points at a
 *  different row, and opening it would attach the wrong source to the record. These assertions pin the
 *  contract so a future edit cannot quietly reintroduce index-only matching.
 */
const collector = fileURLToPath(new URL('../../dsh-wechat-search/collector/main.ps1', import.meta.url));

let source;

test('collector source loads', async () => {
  source = await fs.readFile(collector, 'utf8');
  assert.ok(source.length > 1000);
});

test('the index path is guarded by an exact title comparison', async () => {
  const src = source ?? (await fs.readFile(collector, 'utf8'));
  const line = src.split('\n').find((l) => l.includes('$items[$candidate.index]'));
  assert.ok(line, 'the index lookup exists');
  assert.match(line, /-ceq/u, 'the index hit is only accepted when the title matches exactly');
  assert.match(line, /Normalize-Text/u, 'comparison normalises both sides');
});

test('a shifted list falls back to a unique title match', async () => {
  const src = source ?? (await fs.readFile(collector, 'utf8'));
  assert.match(src, /SEARCH_TITLE_AMBIGUOUS/u, 'several rows sharing a title is reported, not guessed');
  assert.match(src, /titleMatches/u, 'the fallback collects title matches');
  // The fallback must only accept a single match.
  assert.match(src, /\$titleMatches\.Count -eq 1\)\{\$e=\$titleMatches\[0\]\}/u);
});

test('both paths failing still raises the index-changed error', async () => {
  const src = source ?? (await fs.readFile(collector, 'utf8'));
  const idx = src.indexOf('SEARCH_TITLE_AMBIGUOUS');
  const tail = src.slice(idx);
  assert.match(tail, /if\(!\$e\)\{throw 'SEARCH_INDEX_CHANGED'\}/u, 'no silent success without a row');
});

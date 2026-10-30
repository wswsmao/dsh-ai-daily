import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Two contracts in the open pass, both learned from a run that lost 17 of the 261 kept candidates.
 *
 *  1. The open pass scrolls only until every requested row has been rendered. It used to stop at the
 *     time boundary, which left requested rows below the fold unrendered - and
 *     ElementFromPoint cannot click a row that was never drawn.
 *  2. The collector's per-article failures reach the run state. They used to live only in the job
 *     directory, which retention later deletes, so "ARTICLE_EXTRACTION_ERRORS" arrived with no reason.
 */
const collector = fileURLToPath(new URL('../../dsh-wechat-search/collector/main.ps1', import.meta.url));
const pipeline = fileURLToPath(new URL('../lib/pipeline.js', import.meta.url));

test('the open pass stops once every requested row has been seen', async () => {
  const src = await fs.readFile(collector, 'utf8');
  assert.match(src, /\$openSeen\.Count -ge \$openKeys\.Count/u, 'stops as soon as all targets are rendered');
  assert.match(src, /\$openSeen\[\$k\]=\$true/u, 'records which requested rows are on screen');
});

test('the open pass still respects a genuine boundary', async () => {
  const src = await fs.readFile(collector, 'utf8');
  const idx = src.indexOf('$openSeen.Count -ge $openKeys.Count');
  const tail = src.slice(idx, idx + 400);
  assert.match(tail, /if\(\$script:Boundary\)\{break\}/u, 'the boundary stop remains as a fallback');
});

test('an empty open_keys list still means open nothing', async () => {
  const src = await fs.readFile(collector, 'utf8');
  assert.match(src, /\$null -ne \$request\.open_keys/u, 'null, not truthiness, distinguishes "no filter"');
});

test('collector failures are persisted onto the run state', async () => {
  const src = await fs.readFile(pipeline, 'utf8');
  assert.match(src, /q\.open_errors=collectorErrors/u, 'per-article reasons are kept');
  assert.match(src, /collectorErrors=Array\.isArray\(terminal\?\.errors\)/u, 'read from the collector summary');
  assert.match(src, /failed:collectorErrors\.length/u, 'the trace counts them');
});

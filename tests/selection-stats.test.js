import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The overview line quotes three numbers from the selection stats and every reader sees it.
 *
 *  The agent selection path built its stats without `uniquePoints` while the line read it bare, so a
 *  shipped edition read "去重后undefined个信息点". This checks the two facts that prevent it: every stats
 *  construction carries the field, and the line tolerates an older archived stats object that predates
 *  it. Source-level because the alternative is standing up a whole run to observe one string.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await fs.readFile(path.join(here, '..', 'lib', 'pipeline.js'), 'utf8');

test('the agent selection stats carry uniquePoints', () => {
  // The construction that previously omitted it.
  const agentStats = source.match(/chosen=\{articles:verdict\.rows\.map[\s\S]*?\}\};/u);
  assert.ok(agentStats, 'the agent selection stats construction is still recognisable');
  assert.match(agentStats[0], /uniquePoints:/u, 'the overview quotes it, so this path must supply it');
});

test('the overview line guards the descriptive fields and quotes the content one', () => {
  const line = source.match(/overview:`[^`]*`/u);
  assert.ok(line, 'the overview template is still recognisable');
  const bare = [...line[0].matchAll(/\$\{chosen\.stats\.([A-Za-z_]+)\}/gu)].map((m) => m[1]);
  // "精选 N 篇" states what the edition contains. Defaulting it would invent content, so it is bare on
  // purpose: a stats object without it is a defect that must surface. Every other field only describes
  // the run and falls back to a count that is actually known.
  assert.deepEqual(bare, ['selected'], `unexpected unguarded stats fields: ${bare.join(', ')}`);
  assert.match(line[0], /精选\$\{chosen\.stats\.selected\}/u, 'the selected count is quoted as-is');
});

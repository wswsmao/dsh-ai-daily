import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The screening policy and the plugin must not state the same fact twice.
 *
 *  Two conflicts reached a real child and cost a weekly run: the policy said "keep when unsure" while
 *  the code said "drop when unsure", and the policy listed three categories while the configured set
 *  had four. A child that notices spends its turn reporting instead of judging, so the policy owns the
 *  prose and the config owns the category list, spliced in at {{CATEGORIES}}.
 */
const root = fileURLToPath(new URL('../../../archive/daily/ai-tech-daily/config/', import.meta.url));
const policyPath = path.join(root, 'prescreen-policy.md');
const lib = fileURLToPath(new URL('../lib/', import.meta.url));

test('the policy leaves the category list to configuration', async () => {
  const policy = await fs.readFile(policyPath, 'utf8');
  assert.match(policy, /\{\{CATEGORIES\}\}/u, '策略文件应留分类占位符');
  assert.doesNotMatch(
    policy,
    /application（Agent/u,
    '策略文件不应硬写分类清单，否则会与项目配置漂移',
  );
});

test('the policy names index, never a field the input does not carry', async () => {
  const policy = await fs.readFile(policyPath, 'utf8');
  // Inputs carry `index`; an older draft told the child to cite an `n` value that never existed.
  assert.doesNotMatch(policy, /`n` 值/u);
  assert.match(policy, /`index` 值/u);
});

test('the code does not restate a keep tie-break that contradicts the policy', async () => {
  const src = await fs.readFile(path.join(lib, 'prescreen.js'), 'utf8');
  assert.doesNotMatch(src, /拿不准时 keep=false/u, '代码不得与策略文件的 keep 立场相反');
});

test('the placeholder is replaced before the child sees it', async () => {
  const src = await fs.readFile(path.join(lib, 'prescreen.js'), 'utf8');
  assert.match(src, /\.replace\('\{\{CATEGORIES\}\}', categoryLine\)/u, '占位符必须在构造指令时替换');
});

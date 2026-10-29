import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../lib/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));

async function project(t, selection) {
  const base = path.join(root, '.runtime', 'tests');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'quad-'));
  const doc = {
    schema_version: 1, id: 'ai-tech-daily', title: 'AI日报', lookback_days: 1,
    collection: { wechat: true, first_party: false, query_file: 'config/queries.json', sources_file: 'config/sources.json' },
    analysis: { use_host_default_model: true, policy_file: 'config/policy.md', concurrency: 1, batch_chars: 1000, max_retries: 0, max_calls: 20, max_output_tokens: 1000 },
    publishing: { enabled: false, public_base_url: 'https://x/' }, notification: { enabled: false }, git: { commit_reports: false },
    selection,
  };
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(path.join(dir, 'config/project.json'), JSON.stringify(doc));
  await fs.writeFile(path.join(dir, 'config/queries.json'), JSON.stringify({ version: 1, queries: [{ id: 'q', keyword: '智能体', topic: 'AgenticOS', cadence: 'daily' }] }));
  await fs.writeFile(path.join(dir, 'config/sources.json'), JSON.stringify({ version: 1, sources: [] }));
  await fs.writeFile(path.join(dir, 'config/policy.md'), 'x');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('four categories normalise to the configured weights', async (t) => {
  const dir = await project(t, {
    target: 30,
    min_score: 6,
    categories: {
      application: 'Agent/应用架构/工具链',
      model: '训练/原理/架构',
      hardware: '推理加速/芯片/算力',
      embodied: '具身智能/多模态/世界模型',
    },
    ratio: { application: 6, model: 2, hardware: 1, embodied: 1 },
  });
  const p = await loadProject(dir, '2026-10-29');
  assert.deepEqual([...p.categoryKeys].sort(), ['application', 'embodied', 'hardware', 'model']);
  // 6:2:1:1 sums to 10, so each weight divides by ten.
  assert.ok(Math.abs(p.config.selection.ratio.application - 0.6) < 1e-9);
  assert.ok(Math.abs(p.config.selection.ratio.embodied - 0.1) < 1e-9);
  assert.equal(p.config.selection.ratio_raw.embodied, 1);
});

test('the embodied category must also carry a description and a weight', async (t) => {
  const dir = await project(t, {
    target: 30,
    categories: { application: 'A', model: 'M', hardware: 'H', embodied: '' },
    ratio: { application: 6, model: 2, hardware: 1, embodied: 1 },
  });
  await assert.rejects(() => loadProject(dir, '2026-10-29'), /CONFIG_CATEGORY_DESCRIPTION_MISSING/);
});

test('a four-way ratio missing one weight still fails at load', async (t) => {
  const dir = await project(t, {
    target: 30,
    categories: { application: 'A', model: 'M', hardware: 'H', embodied: 'E' },
    ratio: { application: 6, model: 2, hardware: 1 },
  });
  await assert.rejects(() => loadProject(dir, '2026-10-29'), /CONFIG_CATEGORY_RATIO_MISMATCH/);
});

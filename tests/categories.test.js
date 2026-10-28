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
  const dir = await fs.mkdtemp(path.join(base, 'cats-'));
  const doc = {
    schema_version: 1, id: 'ai-tech-daily', title: 'AI日报', lookback_days: 1,
    collection: { wechat: true, first_party: false, query_file: 'config/queries.json', sources_file: 'config/sources.json' },
    analysis: { use_host_default_model: true, policy_file: 'config/policy.md', concurrency: 1, batch_chars: 1000, max_retries: 0, max_calls: 20, max_output_tokens: 1000 },
    publishing: { enabled: false, public_base_url: 'https://x/' }, notification: { enabled: false }, git: { commit_reports: false },
  };
  if (selection !== undefined) doc.selection = selection;
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(path.join(dir, 'config/project.json'), JSON.stringify(doc));
  await fs.writeFile(path.join(dir, 'config/queries.json'), JSON.stringify({ version: 1, queries: [{ id: 'q', keyword: '智能体', topic: 'AgenticOS', cadence: 'daily' }] }));
  await fs.writeFile(path.join(dir, 'config/sources.json'), JSON.stringify({ version: 1, sources: [] }));
  await fs.writeFile(path.join(dir, 'config/policy.md'), 'x');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('no categories configured keeps the built-in three', async (t) => {
  const dir = await project(t);
  const p = await loadProject(dir, '2026-10-28');
  assert.deepEqual([...p.categoryKeys].sort(), ['application', 'hardware', 'model']);
  assert.equal(p.categories.application.includes('Agent'), true);
  assert.ok(Math.abs(p.config.selection.ratio.application - 0.7) < 1e-9);
});

test('a project may add a category without touching the plugin', async (t) => {
  const dir = await project(t, {
    target: 30,
    categories: { application: 'Agent/应用架构', model: '训练/原理', hardware: '推理加速', infra: '集群调度/分布式训练' },
    ratio: { application: 3, model: 1, hardware: 1, infra: 1 },
  });
  const p = await loadProject(dir, '2026-10-28');
  assert.deepEqual([...p.categoryKeys].sort(), ['application', 'hardware', 'infra', 'model']);
  // Weights need not sum to 1: they are normalised.
  assert.ok(Math.abs(p.config.selection.ratio.infra - 1 / 6) < 1e-9);
});

test('a category without a description fails at load', async (t) => {
  const dir = await project(t, {
    categories: { application: '', model: '训练/原理' },
    ratio: { application: 1, model: 1 },
  });
  await assert.rejects(() => loadProject(dir, '2026-10-28'), /CONFIG_CATEGORY_DESCRIPTION_MISSING/);
});

test('a category without a ratio weight fails at load', async (t) => {
  const dir = await project(t, {
    categories: { application: 'A', model: 'M' },
    ratio: { application: 1 },
  });
  await assert.rejects(() => loadProject(dir, '2026-10-28'), /CONFIG_CATEGORY_RATIO_MISMATCH/);
});

test('a ratio entry with no matching category fails at load', async (t) => {
  const dir = await project(t, {
    categories: { application: 'A' },
    ratio: { application: 1, infra: 1 },
  });
  await assert.rejects(() => loadProject(dir, '2026-10-28'), /CONFIG_CATEGORY_RATIO_MISMATCH/);
});

test('a non-positive weight fails at load', async (t) => {
  const dir = await project(t, {
    categories: { application: 'A' },
    ratio: { application: 0 },
  });
  await assert.rejects(() => loadProject(dir, '2026-10-28'), /CONFIG_RATIO_INVALID/);
});

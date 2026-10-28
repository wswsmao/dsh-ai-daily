import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DailyPipeline } from '../lib/pipeline.js';
import { writeJson, writeText } from '../lib/io.js';

const root = fileURLToPath(new URL('..', import.meta.url));

async function fixture(t, projectOver = {}) {
  const base = path.join(root, '.runtime', 'tests');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'win-'));
  const project = {
    schema_version: 1, id: 'ai-tech-daily', title: 'AI日报', lookback_days: 1,
    collection: { wechat: true, first_party: false, query_file: 'config/queries.json', sources_file: 'config/sources.json' },
    analysis: { use_host_default_model: true, policy_file: 'config/policy.md', concurrency: 1, batch_chars: 1000, max_retries: 0, max_calls: 20, max_output_tokens: 1000 },
    publishing: { enabled: false, public_base_url: 'https://x/' }, notification: { enabled: false }, git: { commit_reports: false },
    ...projectOver,
  };
  await writeJson(path.join(dir, 'config/project.json'), project);
  await writeJson(path.join(dir, 'config/queries.json'), { version: 1, queries: [{ id: 'q', keyword: '智能体', topic: 'AgenticOS', cadence: 'daily' }] });
  await writeJson(path.join(dir, 'config/sources.json'), { version: 1, sources: [] });
  await writeText(path.join(dir, 'config/policy.md'), 'x');

  const calls = [];
  let next = 0;
  const REC = { identity: 'a', title: 'T', url: 'https://example.org/a', account: 'acc', relative_date: '1小时前', age_seconds: 3600, snippet: 's', list_only: true };
  const OPEN = { identity: 'a', title: 'T', url: 'https://example.org/a', account: 'acc', date: '2026-10-28', body_text: 'body', body_complete: true, within_window: true };
  const wechat = {
    async start(args, opts) { const id = 'j' + next; next += 1; calls.push({ id, args, opts }); return { job_id: id }; },
    async wait() { return { status: 'complete', coverage: { scope_complete: true }, stop_reason: 'b' }; },
    async getResult(id) { const c = calls.find((x) => x.id === id); return { records: c?.opts?.list_only ? [REC] : [OPEN] }; },
  };
  const llm = { async *stream(o) {
    const p = JSON.parse(o.messages[0].content[0].text);
    if (Array.isArray(p)) { yield { type: 'text-delta', text: JSON.stringify({ items: p.map((it, n) => ({ n, keep: true, reason: 'ok', category: 'application', point: 'p' + n })) }) }; }
    else { const ids = (p.articles ?? [p]).map((a) => a.article_id); yield { type: 'text-delta', text: JSON.stringify({ articles: ids.map((id) => ({ article_id: id, status: 'technical', summary_zh: '摘要内容足够长用于测试验证', reason: 'r', evidence_quotes: ['body'], topics: ['AgenticOS'], quality: { novelty: 2, specificity: 2, depth: 2, firstHand: 1, honesty: 2 } })) }) }; }
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const pipeline = new DailyPipeline({ projectDir: dir, ctx: {}, wechat, fetchText: async () => '', llm, selection: () => ({ provider: 'mock', model: 'mock' }), runProcess: async () => ({ exitCode: 0 }), clock: () => new Date('2026-10-28T04:00:00Z') });
  await pipeline.ready;
  t.after(async () => { await pipeline.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, pipeline, calls };
}

test('the scheduled default stays at the project window', async (t) => {
  const f = await fixture(t);
  const r = await f.pipeline.start();
  const s = await f.pipeline.status(r.run_id);
  assert.equal(s.lookback_days, 1);
  const cutoffHours = (Date.parse(s.reference_time) - Date.parse(s.cutoff_time)) / 3600000;
  assert.equal(Math.round(cutoffHours), 24, 'cutoff is 24h back when no override is given');
  await f.pipeline.active?.done;
});

test('an ad-hoc run can ask for a longer window without touching configuration', async (t) => {
  const f = await fixture(t);
  const r = await f.pipeline.start({ lookback_days: 3 });
  const s = await f.pipeline.status(r.run_id);
  assert.equal(s.lookback_days, 3);
  const cutoffHours = (Date.parse(s.reference_time) - Date.parse(s.cutoff_time)) / 3600000;
  assert.equal(Math.round(cutoffHours), 72, 'cutoff reflects the requested 72h window');
  await f.pipeline.active?.done;
});

test('the override reaches the collector, not just the run state', async (t) => {
  const f = await fixture(t);
  const r = await f.pipeline.start({ lookback_days: 2 });
  await f.pipeline.active?.done;
  assert.ok(f.calls.length > 0, 'the collector was called');
  // The collector receives lookback_days inside the request args.
  assert.equal(f.calls[0].args.lookback_days, 2);
});

test('an out-of-range window is rejected before anything runs', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.pipeline.start({ lookback_days: 9 }));
  await assert.rejects(() => f.pipeline.start({ lookback_days: 0 }));
});

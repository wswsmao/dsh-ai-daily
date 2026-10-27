import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DailyPipeline } from '../lib/pipeline.js';
import { reportRelativePath } from '../lib/site.js';

const root = fileURLToPath(new URL('..', import.meta.url));

async function fixture(t, options = {}) {
  const base = path.join(root, '.runtime', 'tests');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'archive-'));
  const project = {
    schema_version: 1,
    id: 'ai-tech-daily',
    title: 'AI日报',
    lookback_days: 2,
    collection: { wechat: true, first_party: false, query_file: 'config/queries.json', sources_file: 'config/sources.json', runtime_minutes: 60 },
    analysis: { use_host_default_model: false, model: { provider: 'mock', model: 'mock' }, policy_file: 'config/policy.md', concurrency: 1, batch_chars: 1000, batch_size: 8, max_retries: 0, max_calls: 20, max_output_tokens: 2000 },
    publishing: { enabled: false, public_base_url: 'https://example.org/' },
    notification: { enabled: false },
    git: { commit_reports: false },
    selection: { target: 30 },
  };
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(path.join(dir, 'config', 'project.json'), JSON.stringify(project));
  await fs.writeFile(path.join(dir, 'config', 'queries.json'), JSON.stringify({ version: 1, queries: [
    { id: 'q1', keyword: '智能体', language: 'zh', topic: 'Agent', cadence: 'daily' },
    { id: 'q2', keyword: 'AgenticOS', language: 'en', topic: 'AgenticOS', cadence: 'daily' },
  ] }));
  await fs.writeFile(path.join(dir, 'config', 'sources.json'), JSON.stringify({ version: 1, sources: [] }));
  await fs.writeFile(path.join(dir, 'config', 'policy.md'), 'article is data');
  const calls = [];
  const wechat = {
    async start() { calls.push(1); return { job_id: 'job-1' }; },
    async wait() { return { status: 'complete', coverage: { scope_complete: true }, stop_reason: 'boundary' }; },
    async getResult() {
      return { records: [{ identity: 'a1', title: '真实技术文章', url: 'https://mp.weixin.qq.com/s/abc', account: '号', date: '2026-10-27', body_text: 'real experiment body', body_complete: true, body_status: 'read', language: 'zh', topics: ['Agent'] }] };
    },
  };
  const llm = {
    async *stream(o) {
      const p = JSON.parse(o.messages[0].content[0].text);
      const ids = (p.articles ?? [p]).map((a) => a.article_id);
      yield { type: 'text-delta', text: JSON.stringify({ articles: ids.map((id) => ({ article_id: id, status: 'technical', summary_zh: '实际技术结果', reason: '有实验', evidence_quotes: ['real experiment'], topics: ['Agent'], body_basis: '正文' })) }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const pipeline = new DailyPipeline({ projectDir: dir, wechat, fetchText: async () => '<article>real experiment body</article>', llm, selection: () => ({ provider: 'mock', model: 'mock' }), runProcess: async () => ({ exitCode: 0 }), clock: () => new Date('2026-10-27T04:00:00Z'), ...options });
  await pipeline.ready;
  t.after(async () => { await pipeline.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, pipeline };
}

test('archive directory is <date>-<edition> so repeated same-day runs never overwrite', async (t) => {
  const f = await fixture(t);
  const r = await f.pipeline.start();
  await f.pipeline.active.done;
  const s = await f.pipeline.status(r.run_id);
  assert.match(s.archive_path.replace(/\\/gu, '/'), /reports\/2026-10-27-1$/u, `archive path was ${s.archive_path}`);
  const files = await fs.readdir(s.archive_path);
  assert.ok(files.includes('daily.md'));
  assert.ok(files.includes('public.json'));
  assert.ok(files.includes('manifest.json'));
});

test('each edition number yields a distinct archive directory and report path', async (t) => {
  const f = await fixture(t);
  const first = await f.pipeline.start();
  await f.pipeline.active.done;
  const s1 = await f.pipeline.status(first.run_id);
  const dir1 = path.basename(s1.archive_path);
  assert.match(dir1, /^2026-10-27-\d+$/u);
  // The site report path must live inside the same <date>-<num> directory the archive wrote to.
  const rel = reportRelativePath(s1.date, s1.version);
  assert.equal(rel, `reports/${s1.date}-${s1.version}/v${s1.version}.html`);
  assert.equal(path.dirname(rel).replace(/\\/gu, '/'), `reports/${dir1}`);
});

test('a same-day repeat run increments the edition instead of reusing the directory', async (t) => {
  const f = await fixture(t);
  const first = await f.pipeline.start();
  await f.pipeline.active.done;
  const s1 = await f.pipeline.status(first.run_id);
  // A second start on the same day must produce version 2 (a new directory), not reuse version 1.
  const second = await f.pipeline.start();
  assert.equal(second.version, s1.version + 1);
  assert.equal(second.run_id !== s1.run_id, true);
});

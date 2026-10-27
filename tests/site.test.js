import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSite, renderMarkdown, projectPublicEdition, publicSourceUrl, editionMarker, isPublicSitePath, validDate } from '../lib/site.js';
const root = fileURLToPath(new URL('..', import.meta.url));
async function temporary(t) { const base = path.join(root, '.runtime', 'tests'); await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(path.join(base, 'site-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
const edition = () => ({ date: '2026-10-26', version: 1, title: 'AI 技术日报', overview: '今天的技术发展\n\n中英文独立检索。', events: [{ title: 'AgenticOS 的执行生命周期', category: 'AgenticOS', summary: '框架给出检查点与恢复机制。', sources: [{ title: 'Original study', url: 'https://example.org/study', date: '2026-10-26' }] }], articles: [{ title: '<img src=x onerror="alert(1)"> Article', author: '研究者', account: 'Tech', date: '2026-10-26', language: 'en', categories: ['AgenticOS', 'Agent'], status: 'technical', summary: '结果 <script>alert(1)</script> 与限制。', url: 'https://example.org/article?access_token=SECRET&utm_source=test', body: 'PRIVATE FULL ARTICLE BODY', raw: 'PRIVATE_RAW', localPath: 'C:\\Users\\private\\file', settings: { token: 'SUPER_SECRET' } }], coverage: { complete: false, plannedQueries: 3, completedQueries: 2, failedQueries: 1, candidates: 6, unreadArticles: 1, note: '一个检索尚未完成。', private_path: 'D:\\private' }, credential: 'NEVER_PUBLISH' });

test('public allowlist excludes source bodies paths settings and credentials', () => {
  const e = projectPublicEdition(edition()); const text = JSON.stringify(e);
  for (const forbidden of ['PRIVATE FULL', 'PRIVATE_RAW', 'C:\\Users', 'SUPER_SECRET', 'NEVER_PUBLISH', 'access_token', 'SECRET']) assert(!text.includes(forbidden), forbidden);
  assert.equal(e.articles[0].url, undefined); assert.equal(e.articles[0].sources[0].url, 'https://example.org/article?utm_source=test');
  assert.equal(e.coverage.globalComplete, false); assert.equal(e.articles.length, 1);
});
test('render responsive static site with complete catalog version URLs and local-only script', async (t) => {
  const dir = await temporary(t); const result = await renderSite({ siteDir: dir, edition: edition(), history: [{ date: '2026-10-25', version: 1, title: 'Yesterday', articleCount: 3 }], publicBaseUrl: 'https://wswsmao.github.io/ai-tech-daily/' });
  assert.equal(result.reportUrl, 'https://wswsmao.github.io/ai-tech-daily/reports/2026-10-26-1/v1.html');
  const html = await fs.readFile(path.join(dir, result.reportPath), 'utf8');
  assert(html.includes('name="viewport"')); assert(html.includes('data-search')); assert(html.includes('data-topic')); assert(html.includes('data-article')); assert(html.includes('class="toc"')); assert(/href="#a1"/u.test(html)); assert(html.includes('aria-live="polite"'));
  assert(html.includes('Content-Security-Policy'));
  assert(!html.includes('<img src=x')); assert(!html.includes('<script>alert')); assert(html.includes('&lt;script&gt;'));
  assert(!html.includes('onerror="')); assert(!html.includes('PRIVATE FULL'));
  assert(html.includes('href="https://example.org/article?utm_source=test"')); assert(html.includes(result.marker));
  assert(!/<script[^>]+src="https?:/u.test(html));
  const js = await fs.readFile(path.join(dir, 'assets/site.js'), 'utf8'); assert(!js.includes('innerHTML')); assert(js.includes('textContent'));
  const css = await fs.readFile(path.join(dir, 'assets/site.css'), 'utf8'); assert(css.includes('@media(max-width:600px)')); assert(css.includes('focus-visible'));
  assert(result.files.every(isPublicSitePath)); assert(result.files.includes('.nojekyll')); assert(result.files.includes('site-manifest.json'));
});
test('unsafe links and private values reject public render', async (t) => {
  for (const url of ['javascript:alert(1)', 'file:///D:/private', 'https://127.0.0.1/x', 'https://user:password@example.org/x', 'https://[::1]/x', 'http://10.0.0.1/a']) assert.throws(() => publicSourceUrl(url), { name: 'SiteRenderError' });
  const raw = edition(); raw.articles[0].summary = 'C:\\Users\\admin\\secret.txt'; assert.throws(() => projectPublicEdition(raw), { code: 'PRIVATE_PUBLIC_FIELD' });
  assert.throws(() => validDate('2026-02-30')); assert(!isPublicSitePath('../secrets.json')); assert(!isPublicSitePath('reports/2026-10-26-1/../../credentials.json'));
});
test('no truncation of article catalog and empty editions are valid', async (t) => {
  const dir = await temporary(t); const raw = edition(); raw.articles = Array.from({ length: 120 }, (_, i) => ({ title: `Article ${i}`, url: `https://example.org/${i}`, category: '模型' }));
  const result = await renderSite({ siteDir: dir, edition: raw }); const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8'); assert.equal((html.match(/data-article/gu) ?? []).length >= 120, true);
  raw.date = '2026-10-27'; raw.articles = []; raw.events = []; const empty = await renderSite({ siteDir: dir, edition: raw }); assert((await fs.readFile(path.join(dir, 'index.html'), 'utf8')).includes('不以宣传文凑数'));
  assert.equal(result.publicEdition.articles.length, 120); assert.equal(empty.publicEdition.articles.length, 0);
});
test('markdown projection safe and deterministic marker tracks actual public content', () => {
  const raw = edition(); const a = editionMarker(raw); raw.body = 'different private body'; assert.equal(editionMarker(raw), a);
  raw.overview += ' new'; assert.notEqual(editionMarker(raw), a); const md = renderMarkdown(raw); assert(md.includes('\\<img')); assert(!md.includes('PRIVATE FULL')); assert(md.includes('https://example.org/article?utm_source=test'));
});
test('preexisting symlink output is rejected before write', async (t) => {
  const dir = await temporary(t); const outside = await temporary(t); await fs.mkdir(path.join(dir, 'assets')); try { await fs.symlink(path.join(outside, 'site.js'), path.join(dir, 'assets/site.js')); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not allow creating file symlinks'); return; } throw error; }
  await assert.rejects(() => renderSite({ siteDir: dir, edition: edition() }), { code: 'SITE_SYMLINK' });
});

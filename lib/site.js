import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class SiteRenderError extends Error {
  constructor(code, message) { super(message); this.name = 'SiteRenderError'; this.code = code; }
}
const own = (o, key) => o && typeof o === 'object' && !Array.isArray(o) ? o[key] : undefined;
const array = (value) => Array.isArray(value) ? value : [];
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const privateText = /(?:[A-Za-z]:[\\/](?:Users|Program Files|Windows)|(?:^|\s)\/(?:Users|home|root|tmp)\/|(?:authorization\s*:\s*bearer|api[_ -]?key|access[_ -]?token|pass_ticket|exportkey)\s*[:=]\s*\S+)/iu;
function text(value, maximum = 3000) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return '';
  const s = value.replace(/\u0000/gu, '').trim();
  if (privateText.test(s)) throw new SiteRenderError('PRIVATE_PUBLIC_FIELD', 'A public field contains a private path or credential-shaped value.');
  // An over-long metadata field (for example a huge author list from a feed) must not abort the whole
  // edition: trim it to the public budget so the rest of the daily still publishes.
  return s.length > maximum ? `${s.slice(0, maximum - 1).trimEnd()}…` : s;
}
export function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new SiteRenderError('INVALID_EDITION_DATE', 'Edition date must be YYYY-MM-DD.');
  const d = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(d.valueOf()) || d.toISOString().slice(0, 10) !== value) throw new SiteRenderError('INVALID_EDITION_DATE', 'Edition date is not a calendar date.');
  return value;
}
export function validVersion(value) {
  const n = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 1 || n > 1000000) throw new SiteRenderError('INVALID_EDITION_VERSION', 'Edition version must be a positive integer.');
  return n;
}
function privateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/gu, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1' || h === '::' || h.includes('%') || /^f[cd][a-f0-9]*:/u.test(h) || /^fe[89ab][a-f0-9]*:/u.test(h)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
  }
  return h.includes(':'); // no literal IPv6 source links; do not risk mapped loopback variants
}
export function publicSourceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let u; try { u = new URL(value); } catch { throw new SiteRenderError('INVALID_SOURCE_URL', 'A source link is not an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || privateHost(u.hostname) || !u.hostname.includes('.')) throw new SiteRenderError('UNSAFE_SOURCE_URL', 'A source link is not a public HTTP(S) URL.');
  for (const key of [...u.searchParams.keys()]) {
    if (/^(?:key|uin|pass_ticket|exportkey|sessionid|session|token|access_token|auth_token|api_key|apikey|password|secret|search_click_id|click_id)$/iu.test(key)) u.searchParams.delete(key);
  }
  return u.href;
}
export function publicBase(value = 'https://wswsmao.github.io/ai-tech-daily/') {
  const u = new URL(publicSourceUrl(value));
  if (u.protocol !== 'https:' || u.search || u.hash) throw new SiteRenderError('INVALID_PUBLIC_BASE', 'The public base must be a clean HTTPS URL.');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.href;
}
function categories(value, fallback) {
  const result = array(value).map((c) => text(c, 120)).filter(Boolean);
  if (!result.length && fallback) result.push(text(fallback, 120));
  return [...new Set(result.length ? result : ['其他技术'])];
}
function source(raw) {
  const url = publicSourceUrl(own(raw, 'url') ?? own(raw, 'sourceUrl') ?? own(raw, 'link'));
  if (!url) return null;
  return { title: text(own(raw, 'title'), 600) || '原始来源', url, author: text(own(raw, 'author'), 200), account: text(own(raw, 'account'), 200), date: text(own(raw, 'date'), 80) };
}
function article(raw, i) {
  const title = text(own(raw, 'title'), 1200) || `技术文章 ${i + 1}`;
  const sources = array(own(raw, 'sources')).map(source).filter(Boolean);
  const primary = source(raw); if (primary && !sources.some((s) => s.url === primary.url)) sources.unshift(primary);
  const status = text(own(raw, 'status') ?? own(raw, 'classification') ?? own(raw, 'technicalStatus'), 100) || '待判断';
  return {
    id: `article-${i + 1}`, title, summary: text(own(raw, 'summary'), 6000), categories: categories(own(raw, 'categories'), own(raw, 'category')),
    status, author: text(own(raw, 'author'), 200), account: text(own(raw, 'account'), 200), date: text(own(raw, 'date'), 80),
    language: text(own(raw, 'language'), 40), readStatus: text(own(raw, 'readStatus') ?? own(raw, 'body_status'), 100), sources,
  };
}
function event(raw, i) {
  return { id: `event-${i + 1}`, title: text(own(raw, 'title'), 800) || `技术条目 ${i + 1}`, summary: text(own(raw, 'summary'), 6000), categories: categories(own(raw, 'categories'), own(raw, 'category')), sources: array(own(raw, 'sources')).map(source).filter(Boolean) };
}
function coverageProjection(raw) {
  const c = own(raw, 'counts') ?? raw ?? {};
  const result = {
    complete: own(raw, 'complete') === true || own(raw, 'scope_complete') === true,
    status: text(own(raw, 'status'), 100), note: text(own(raw, 'note') ?? own(raw, 'summary'), 3000),
    plannedQueries: count(own(c, 'plannedQueries') ?? own(c, 'planned_queries') ?? own(c, 'planned')),
    completedQueries: count(own(c, 'completedQueries') ?? own(c, 'completed_queries') ?? own(c, 'completed')),
    partialQueries: count(own(c, 'partialQueries') ?? own(c, 'partial_queries') ?? own(c, 'partial')),
    failedQueries: count(own(c, 'failedQueries') ?? own(c, 'failed_queries') ?? own(c, 'failed')),
    candidates: count(own(c, 'candidates') ?? own(c, 'discovered')), processedArticles: count(own(c, 'processedArticles') ?? own(c, 'processed_articles') ?? own(c, 'processed')),
    unreadArticles: count(own(c, 'unreadArticles') ?? own(c, 'unread_articles') ?? own(c, 'unread')), globalComplete: false,
  };
  if (own(raw, 'byLanguage') && typeof raw.byLanguage === 'object') result.byLanguage = Object.fromEntries(['zh', 'en'].map((lang) => [lang, { planned: count(raw.byLanguage[lang]?.planned), completed: count(raw.byLanguage[lang]?.completed), failed: count(raw.byLanguage[lang]?.failed) }]));
  return result;
}
/** Allowlist projection: source bodies, local paths, task configuration and logs are never copied. */
export function projectPublicEdition(edition) {
  if (!edition || typeof edition !== 'object' || Array.isArray(edition)) throw new SiteRenderError('INVALID_EDITION', 'An edition object is required.');
  return { schemaVersion: 1, date: validDate(edition.date), version: validVersion(edition.version ?? 1), title: text(edition.title, 500) || 'AI 技术日报', overview: text(edition.overview, 10000), events: array(edition.events).map(event), articles: array(edition.articles).map(article), coverage: coverageProjection(edition.coverage) };
}
export function editionMarker(edition) {
  const projected = projectPublicEdition(edition);
  const digest = createHash('sha256').update(JSON.stringify(projected)).digest('hex').slice(0, 24);
  return `dsh-ai-daily:${projected.date}:v${projected.version}:${digest}`;
}
export const reportRelativePath = (date, version) => `reports/${validDate(date)}-${validVersion(version)}/v${validVersion(version)}.html`;
export function reportPublicUrl(base, date, version) { return new URL(reportRelativePath(date, version), publicBase(base)).href; }
const paragraphs = (value) => text(value, 10000).split(/\n\s*\n/u).filter(Boolean).map((s) => `<p>${escapeHtml(s).replace(/\n/gu, '<br>')}</p>`).join('');
function sourcesHtml(sources) {
  return sources.length ? `<ul class="sources">${sources.map((s) => `<li><a href="${escapeHtml(s.url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(s.title)}</a><span>${escapeHtml([s.author || s.account, s.date].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>` : '<p class="muted">暂无可核验的原文链接</p>';
}
function historyProjection(history, current) {
  const entries = new Map();
  for (const raw of array(history)) {
    try { const date = validDate(raw.date); const version = validVersion(raw.version ?? 1); entries.set(`${date}/${version}`, { date, version, title: text(raw.title, 500) || 'AI 技术日报', articleCount: count(raw.articleCount ?? raw.article_count), complete: raw.complete === true }); } catch { /* omit invalid history paths, never emit arbitrary href */ }
  }
  entries.set(`${current.date}/${current.version}`, { date: current.date, version: current.version, title: current.title, articleCount: current.articles.length, complete: current.coverage.complete });
  return [...entries.values()].sort((a, b) => b.date.localeCompare(a.date) || b.version - a.version);
}
const CSS = `:root{color-scheme:light dark;--bg:#f4f6fa;--surface:#fff;--text:#172334;--muted:#5c6879;--link:#1b58bb;--line:#dbe1eb;--accent:#eaf1ff;--warn:#8e4900}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.75 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere}a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}.shell{max-width:1240px;margin:auto;padding:20px 24px 60px}header{padding:14px 0 18px;border-bottom:1px solid var(--line)}nav{display:flex;gap:18px;font-weight:600}.pagehead h1{font-size:clamp(1.5rem,3.4vw,2.1rem);line-height:1.25;margin:26px 0 4px}.pagehead .meta{margin:0 0 18px}h2{font-size:1.2rem;margin:0}p{margin:10px 0}.muted,.meta,.sources span{color:var(--muted);font-size:.88rem}.cols{display:grid;grid-template-columns:264px minmax(0,1fr);gap:26px;align-items:start}@media(max-width:900px){.cols{grid-template-columns:1fr}}.toc{position:sticky;top:16px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 16px 12px;max-height:calc(100vh - 40px);overflow:auto}.toc h2{font-size:.95rem;margin-bottom:10px}.toc ol{list-style:none;margin:0 0 4px;padding:0;counter-reset:t;display:block}.toc li{display:block;margin:2px 0;counter-increment:t}.toc a{display:block;padding:6px 8px;border-radius:8px;font-size:.86rem;line-height:1.45;color:var(--text)}.toc a::before{content:counter(t) ". ";color:var(--muted);font-variant-numeric:tabular-nums}.toc a:hover{background:var(--accent);text-decoration:none}.cat{font-size:.78rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:14px 0 8px;scroll-margin-top:16px}.cat:first-child{margin-top:0}.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:0 0 14px;scroll-margin-top:16px}.card h3{font-size:1.05rem;line-height:1.45;margin:0 0 6px}.card h3 a{color:var(--text)}.card h3 a:hover{color:var(--link)}.card .meta{margin:0 0 10px}.card .sum{margin:0 0 10px}.card .sum br+br{display:none}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}.chip{display:inline-block;background:var(--accent);border:1px solid var(--line);border-radius:30px;padding:2px 10px;font-size:.75rem}.sources{margin:8px 0 0;padding:10px 0 0 0;border-top:1px dashed var(--line);list-style:none}.sources li{margin:6px 0;font-size:.9rem}.sources span{display:inline;margin-left:8px}.src{margin:10px 0 0;padding-top:10px;border-top:1px dashed var(--line);font-size:.9rem}.tools{display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin:0 0 14px}.tools label{display:flex;flex-direction:column;gap:4px;flex:1;min-width:180px;font-size:.85rem;color:var(--muted)}input,select{font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);width:100%}input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid var(--link);outline-offset:2px}.count{margin:0 0 16px}.panel{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px;margin:18px 0}.history{list-style:none;padding:0}.history li{display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap;border-top:1px solid var(--line);padding:12px 0}.history li:first-child{border-top:none}.backtop{display:block;text-align:right;font-size:.85rem;margin:18px 0 0}[hidden]{display:none!important}.skip{position:absolute;left:-10000px}.skip:focus{left:12px;top:12px;z-index:9;background:var(--surface);padding:12px}footer{color:var(--muted);font-size:.85rem;padding:22px 0;border-top:1px solid var(--line);margin-top:30px}.empty{padding:18px 0;color:var(--muted)}@media(max-width:600px){.shell{padding:12px 14px 40px}.card{padding:15px;border-radius:12px}.tools{gap:9px}.tools label{min-width:100%}nav{gap:12px}body{font-size:15.5px}}@media(prefers-color-scheme:dark){:root{--bg:#101722;--surface:#182232;--text:#e9eef8;--muted:#afbacb;--link:#9bbcff;--line:#354255;--accent:#213352;--warn:#ffbd77}}`;
const JS = `(()=>{const q=document.querySelector('[data-search]'),topic=document.querySelector('[data-topic]'),cards=[...document.querySelectorAll('[data-article]')],live=document.querySelector('[data-result-count]');function apply(){const needle=(q?.value||'').trim().toLocaleLowerCase(),chosen=topic?.value||'';let n=0;for(const card of cards){const match=(!needle||card.textContent.toLocaleLowerCase().includes(needle))&&(!chosen||JSON.parse(card.dataset.categories||'[]').includes(chosen));card.hidden=!match;if(match)n++;}if(live)live.textContent='显示 '+n+' / '+cards.length+' 篇';}q?.addEventListener('input',apply);topic?.addEventListener('change',apply);apply();})();`;
function layout({ title, body, assetPrefix, homeHref, archiveHref, marker }) {
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'"><meta name="daily-edition" content="${escapeHtml(marker)}"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${assetPrefix}assets/site.css"><script defer src="${assetPrefix}assets/site.js"></script></head><body><a class="skip" href="#main">跳到日报正文</a><div class="shell"><header><nav aria-label="日报导航"><a href="${homeHref}">最新日报</a><a href="${archiveHref}">历史日报</a></nav></header><main id="main">${body}</main><footer>AI 技术日报 · 摘要辅助阅读，请以原始来源为准。仅展示公开阅读内容，不发布采集全文、私人日志或执行配置。</footer></div></body></html>\n`;
}
function articleCard(a, n) {
  const id = `a${n}`;
  const meta = [a.author || '未署名', a.account, a.date, a.language, a.status].filter(Boolean).join(' · ');
  const srcUrl = a.sources?.[0]?.url ?? '';
  const head = srcUrl
    ? `<h3 id="${id}"><a href="${escapeHtml(srcUrl)}" rel="noopener noreferrer" target="_blank">${escapeHtml(a.title)}</a></h3>`
    : `<h3 id="${id}">${escapeHtml(a.title)}</h3>`;
  const cats = (a.categories ?? []).length
    ? `<div class="chips">${a.categories.map((s) => `<span class="chip">${escapeHtml(s)}</span>`).join('')}</div>`
    : '';
  const sum = a.summary
    ? `<p class="sum">${escapeHtml(String(a.summary).replace(/\s+/gu, ' ').trim())}</p>`
    : '<p class="muted">暂无正文摘要，保留目录供核查，不据标题推断全文。</p>';
  const src = srcUrl
    ? `<p class="src"><a href="${escapeHtml(srcUrl)}" rel="noopener noreferrer" target="_blank">阅读原文 →</a></p>`
    : '';
  return `<article class="card" data-article data-categories="${escapeHtml(JSON.stringify(a.categories ?? []))}">${head}<p class="meta">${escapeHtml(meta)}</p>${cats}${sum}${src}</article>`;
}
function tocHtml(articles) {
  const groups = new Map();
  articles.forEach((a, i) => {
    const key = (a.categories && a.categories[0]) || '其他';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ a, n: i + 1 });
  });
  let n = 0;
  return [...groups.entries()].sort((x, y) => x[0].localeCompare(y[0], 'zh')).map(([cat, list]) => {
    const items = list.map(({ a, n: idx }) => `<li><a href="#a${idx}">${escapeHtml(a.title)}</a></li>`).join('');
    n += list.length;
    return `<div class="cat">${escapeHtml(cat)}</div><ol>${items}</ol>`;
  }).join('');
}
function editionHtml(e, history, { prefix = '', base, marker }) {
  const cats = [...new Set(e.articles.flatMap((a) => a.categories ?? []))].sort();
  const controls = `<div class="tools"><label>搜索标题与摘要<input type="search" data-search placeholder="项目、术语或关键词" autocomplete="off"></label><label>技术领域<select data-topic><option value="">全部领域</option>${cats.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}</select></label></div><p class="muted count" data-result-count role="status" aria-live="polite">共 ${e.articles.length} 篇</p>`;
  const body = e.articles.length
    ? `<div class="cols"><nav class="toc" aria-label="文章目录"><h2>目录</h2>${tocHtml(e.articles)}</nav><div>${controls}${e.articles.map((a, i) => articleCard(a, i)).join('')}<a class="backtop" href="#main">回到顶部 ↑</a></div></div>`
    : `<p class="empty">本期没有确认的新技术文章。不以宣传文凑数。</p>`;
  const recent = `<section class="panel"><h2>历史日期</h2><ul class="history">${history.slice(0, 14).map((h) => `<li><a href="${escapeHtml(reportRelativePath(h.date, h.version))}">${escapeHtml(h.date)} · 第${h.version}版</a><span>${h.articleCount} 篇 · ${h.complete ? '完成' : '有缺口'}</span></li>`).join('')}</ul><a href="${prefix}archive.html">查看全部历史</a></section>`;
  return layout({ title: `${e.title} · ${e.date}`, body: `<div class="pagehead"><h1>${escapeHtml(e.title)}</h1><p class="meta">${escapeHtml(e.date)} · 第${e.version}版 · ${e.articles.length} 篇</p></div>${body}${recent}<p class="muted">版本标识：${escapeHtml(marker)}</p>`, assetPrefix: prefix, homeHref: `${prefix}index.html`, archiveHref: `${prefix}archive.html`, marker });
}
const markdownText = (s) => String(s ?? '').replace(/([\\`*_{}\[\]<>])/gu, '\\$1').replace(/\r/gu, '');
export function renderMarkdown(edition) {
  const e = projectPublicEdition(edition);
  const lines = [`# ${markdownText(e.title)} · ${e.date}`, '', `第${e.version}版；${e.articles.length}篇；${e.coverage.complete ? '本次可见范围完成' : '存在覆盖缺口'}。`, '', '## 今日概览', '', markdownText(e.overview), '', '## 检索覆盖', '', markdownText(e.coverage.note), '', '## 技术条目', ''];
  for (const v of e.events) { lines.push(`### ${markdownText(v.title)}`, '', markdownText(v.summary), ''); for (const s of v.sources) lines.push(`- ${markdownText(s.title)}：${s.url}`); lines.push(''); }
  lines.push('## 完整文章目录', '');
  for (const a of e.articles) { lines.push(`### ${markdownText(a.title)}`, '', `${markdownText(a.author || '未署名')} · ${markdownText(a.account)} · ${markdownText(a.date)} · ${markdownText(a.categories.join(' / '))}`, '', markdownText(a.summary) || '暂无正文摘要。', ''); for (const s of a.sources) lines.push(`- ${markdownText(s.title)}：${s.url}`); lines.push(''); }
  return `${lines.join('\n')}\n`;
}
export function isPublicSitePath(relative) {
  return typeof relative === 'string' && !relative.includes('\\') && !relative.includes('\0') && (
    ['index.html', 'archive.html', '.nojekyll', '.gitignore', 'site-manifest.json', 'assets/site.css', 'assets/site.js'].includes(relative)
    || /^reports\/\d{4}-\d{2}-\d{2}-\d+\/(?:v[1-9]\d*\.html|index\.html|metadata\.json)$/u.test(relative)
  );
}
async function atomicText(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, contents, { encoding: 'utf8', flag: 'wx' });
  try { await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
async function listPublicFiles(dir, prefix = '') {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name === '.git' || entry.name === '.gitignore' || entry.name === 'site-manifest.json') continue;
    if (entry.isSymbolicLink()) throw new SiteRenderError('SITE_SYMLINK', 'Public site files must not be symbolic links.');
    if (entry.isDirectory()) { if (relative === 'assets' || /^reports(?:\/\d{4}-\d{2}-\d{2})?$/u.test(relative)) files.push(...await listPublicFiles(path.join(dir, entry.name), relative)); }
    else if (entry.isFile() && isPublicSitePath(relative)) files.push(relative);
  }
  return files.sort();
}
/** Write a deterministic, mobile-friendly, read-only static projection; never publish source bodies. */
export async function renderSite({ siteDir, edition, history = [], publicBaseUrl }) {
  if (typeof siteDir !== 'string' || !path.isAbsolute(siteDir)) throw new SiteRenderError('INVALID_SITE_DIRECTORY', 'An absolute site directory is required.');
  const e = projectPublicEdition(edition), base = publicBase(publicBaseUrl), marker = editionMarker(e);
  const persisted = [];
  try {
    for (const dir of await fs.readdir(path.join(siteDir, 'reports'), { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^\d{4}-\d{2}-\d{2}-\d+$/u.test(dir.name)) continue;
      try { const raw = JSON.parse(await fs.readFile(path.join(siteDir, 'reports', dir.name, 'metadata.json'), 'utf8')); const p = projectPublicEdition(raw); persisted.push({ date: p.date, version: p.version, title: p.title, articleCount: p.articles.length, complete: p.coverage.complete }); } catch { /* malformed public history is never used as a path */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const hist = historyProjection([...persisted, ...history], e);
  const relative = reportRelativePath(e.date, e.version), dateDir = `reports/${e.date}-${e.version}`;
  await fs.mkdir(siteDir, { recursive: true });
  const stat = await fs.lstat(siteDir); if (stat.isSymbolicLink()) throw new SiteRenderError('SITE_SYMLINK', 'The site root cannot be a symbolic link.');
  await listPublicFiles(siteDir); // reject pre-existing symlink destinations before any writes
  await atomicText(path.join(siteDir, 'assets', 'site.css'), CSS);
  await atomicText(path.join(siteDir, 'assets', 'site.js'), JS);
  const html = editionHtml(e, hist, { prefix: '../../', base, marker });
  await atomicText(path.join(siteDir, relative), html);
  await atomicText(path.join(siteDir, dateDir, 'index.html'), html);
  await atomicText(path.join(siteDir, dateDir, 'metadata.json'), `${JSON.stringify({ ...e, marker }, null, 2)}\n`);
  let latest = e, latestMarker = marker;
  if (hist[0].date > e.date || hist[0].date === e.date && hist[0].version > e.version) {
    try { latest = projectPublicEdition(JSON.parse(await fs.readFile(path.join(siteDir, 'reports', `${hist[0].date}-${hist[0].version}`, 'metadata.json'), 'utf8'))); latestMarker = editionMarker(latest); } catch { latest = e; latestMarker = marker; }
  }
  await atomicText(path.join(siteDir, 'index.html'), editionHtml(latest, hist, { base, marker: latestMarker }));
  await atomicText(path.join(siteDir, 'archive.html'), layout({ title: 'AI 技术日报 · 历史', marker, assetPrefix: '', homeHref: 'index.html', archiveHref: 'archive.html', body: `<h1>历史日报</h1><p class="muted">按日期与版本查看，修订不覆盖已分享的版本链接。</p><section class="panel"><ul class="history">${hist.map((h) => `<li><a href="${escapeHtml(reportRelativePath(h.date, h.version))}">${escapeHtml(h.date)} · 第${h.version}版 · ${escapeHtml(h.title)}</a><span>${h.articleCount} 篇 · ${h.complete ? '完成' : '有缺口'}</span></li>`).join('')}</ul></section>` }));
  await atomicText(path.join(siteDir, '.nojekyll'), '');
  const files = await listPublicFiles(siteDir);
  const sha256 = {};
  for (const f of files) sha256[f] = createHash('sha256').update(await fs.readFile(path.join(siteDir, f))).digest('hex');
  const manifest = { schemaVersion: 1, date: e.date, version: e.version, marker, publicBaseUrl: base, reportPath: relative, files: [...files, 'site-manifest.json'], sha256 };
  await atomicText(path.join(siteDir, 'site-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { files: manifest.files, reportPath: relative, reportUrl: reportPublicUrl(base, e.date, e.version), marker, publicEdition: e, manifest };
}

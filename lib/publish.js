import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isPublicSitePath, projectPublicEdition, publicBase, reportPublicUrl, validDate, validVersion } from './site.js';

export class PublishError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'PublishError'; this.code = code; this.details = details; }
}
const reject = (code, message) => { throw new PublishError(code, message); };
const SHA = /^[a-f0-9]{40,64}$/u;
const sleep = (ms, signal) => new Promise((resolve, rejectPromise) => {
  if (signal?.aborted) { rejectPromise(signal.reason ?? new Error('Aborted')); return; }
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', aborted); resolve(); }
  function aborted() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); rejectPromise(signal.reason ?? new Error('Aborted')); }
  signal?.addEventListener('abort', aborted, { once: true });
});
function abort(signal) { signal?.throwIfAborted(); }
export function normalizeRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(value) || value.split('/')[1].startsWith('.')) reject('INVALID_REPOSITORY', 'Configure a GitHub owner/repository pair.');
  return value.replace(/\.git$/u, '');
}
function repositoryFromRemote(value) {
  const s = String(value ?? '').trim();
  let match = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+?)(?:\.git)?\/?$/u.exec(s);
  if (!match) match = /^git@github\.com:([^/?#]+\/[^/?#]+?)(?:\.git)?$/u.exec(s);
  if (!match) match = /^ssh:\/\/git@github\.com\/([^/?#]+\/[^/?#]+?)(?:\.git)?$/u.exec(s);
  return match ? normalizeRepository(match[1]) : null;
}
async function noLinks(root, relative) {
  const parts = relative.split('/');
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    const s = await fs.lstat(cur);
    if (s.isSymbolicLink()) reject('PUBLIC_SYMLINK', 'Symbolic links cannot be published.');
  }
}
function privatePayload(contents) {
  return /(?:[A-Za-z]:[\\/](?:Users|Program Files|Windows)|(?:authorization\s*:\s*bearer|api[_ -]?key|access[_ -]?token|pass_ticket|exportkey)\s*[:=]\s*[^\s<]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/iu.test(contents);
}
export async function validatePublicPayload(siteDir, expected = {}) {
  const root = path.resolve(siteDir);
  const rootStat = await fs.lstat(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) reject('INVALID_SITE_DIRECTORY', 'The site root must be a real directory.');
  const raw = await fs.readFile(path.join(root, 'site-manifest.json'), 'utf8');
  let m; try { m = JSON.parse(raw); } catch { reject('INVALID_SITE_MANIFEST', 'The public manifest is invalid.'); }
  if (m.schemaVersion !== 1 || !Array.isArray(m.files) || !m.files.length || !m.sha256 || typeof m.sha256 !== 'object') reject('INVALID_SITE_MANIFEST', 'Generate the site before publication.');
  validDate(m.date); validVersion(m.version);
  if (expected.date && m.date !== expected.date || expected.version && m.version !== expected.version) reject('OUTDATED_SITE', 'The generated site does not match this edition.');
  if (m.reportPath !== `reports/${m.date}-${m.version}/v${m.version}.html` || !/^dsh-ai-daily:\d{4}-\d{2}-\d{2}:v\d+:[a-f0-9]{24}$/u.test(m.marker)) reject('INVALID_SITE_MANIFEST', 'The edition marker or report path is invalid.');
  if (new Set(m.files).size !== m.files.length || !m.files.includes('site-manifest.json')) reject('INVALID_SITE_MANIFEST', 'The manifest lists duplicate or missing control files.');
  const files = [];
  for (const relative of m.files) {
    if (!isPublicSitePath(relative) || relative === '.gitignore') reject('PRIVATE_PUBLIC_PATH', 'Only generated public site files can be published.');
    await noLinks(root, relative);
    const stat = await fs.stat(path.join(root, relative)); if (!stat.isFile() || stat.size > 12 * 1024 * 1024) reject('INVALID_PUBLIC_FILE', 'A public file is missing, non-regular or oversized.');
    const body = await fs.readFile(path.join(root, relative));
    if (relative !== 'site-manifest.json' && createHash('sha256').update(body).digest('hex') !== m.sha256[relative]) reject('PUBLIC_FILE_CHANGED', 'A generated public file changed after rendering.');
    const content = body.toString('utf8');
    if (privatePayload(content)) reject('PRIVATE_PUBLIC_CONTENT', 'A public file contains a private path or credential-shaped value.');
    if (/^reports\/\d{4}-\d{2}-\d{2}-\d+\/metadata\.json$/u.test(relative)) {
      let record; try { record = JSON.parse(content); } catch { reject('INVALID_PUBLIC_METADATA', 'An archived public edition is invalid.'); }
      const allowed = { ...projectPublicEdition(record), marker: record.marker };
      if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(Object.keys(allowed).sort()) || JSON.stringify(record) !== JSON.stringify(allowed)) reject('PRIVATE_PUBLIC_METADATA', 'Public metadata contains fields outside the summary allowlist.');
    }
    if (relative.endsWith('.html') && (/<script(?![^>]*\bsrc=["'](?:\.\.\/)*assets\/site\.js["'])/iu.test(content) || /\son[a-z]+\s*=/iu.test(content) || /(?:href|src)\s*=\s*["']\s*(?:javascript|file|data):/iu.test(content))) reject('UNSAFE_PUBLIC_HTML', 'Only the fixed local browser script and safe links are permitted.');
    files.push(relative);
  }
  const report = await fs.readFile(path.join(root, m.reportPath), 'utf8');
  if (!report.includes(`content="${m.marker}"`)) reject('MISSING_PUBLIC_MARKER', 'The report does not contain its verification marker.');
  return { ...m, files: files.sort() };
}
/** Push a preconfigured, public-only Git checkout; never create repositories or configure credentials. */
export class PublishGithub {
  constructor({ siteDir, repository = 'wswsmao/ai-tech-daily', branch = 'main', publicBaseUrl = 'https://wswsmao.github.io/ai-tech-daily/', runProcess, fetch: fetchImpl = globalThis.fetch, verifyAttempts = 12, verifyDelayMs = 10000, delay = sleep, gitExecutable = 'git' }) {
    if (typeof siteDir !== 'string' || !path.isAbsolute(siteDir)) reject('INVALID_SITE_DIRECTORY', 'An absolute public site directory is required.');
    if (typeof runProcess !== 'function') reject('MISSING_PROCESS_RUNNER', 'A managed process runner is required.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/u.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) reject('INVALID_PUBLISH_BRANCH', 'The publishing branch is invalid.');
    this.siteDir = path.resolve(siteDir); this.repository = normalizeRepository(repository); this.branch = branch; this.publicBaseUrl = publicBase(publicBaseUrl);
    this.runProcess = runProcess; this.fetch = fetchImpl; this.verifyAttempts = Math.min(60, Math.max(1, verifyAttempts)); this.verifyDelayMs = Math.min(30000, Math.max(0, verifyDelayMs)); this.delay = delay; this.gitExecutable = gitExecutable;
  }
  async git(args, signal, accept = [0]) {
    abort(signal);
    const result = await this.runProcess({ argv: [this.gitExecutable, '-C', this.siteDir, ...args], cwd: this.siteDir, signal });
    if (!accept.includes(result?.exitCode)) reject('GIT_PUBLISH_FAILED', 'A publishing Git operation failed; inspect private run logs.');
    return { exitCode: result.exitCode, stdout: String(result.stdout ?? '').trim(), stderr: String(result.stderr ?? '') };
  }
  async publish({ date, version, signal }) {
    date = validDate(date); version = validVersion(version);
    const m = await validatePublicPayload(this.siteDir, { date, version });
    if (publicBase(m.publicBaseUrl) !== this.publicBaseUrl) reject('PUBLIC_BASE_CHANGED', 'The renderer and publisher base URL must agree.');
    await this.git(['rev-parse', '--is-inside-work-tree'], signal);
    const top = await this.git(['rev-parse', '--show-toplevel'], signal);
    if (path.resolve(top.stdout).toLowerCase() !== this.siteDir.toLowerCase()) reject('PUBLISH_REPOSITORY_BOUNDARY', 'The site must be an independent Git checkout, not its archive parent.');
    const branch = await this.git(['branch', '--show-current'], signal);
    if (branch.stdout !== this.branch) reject('PUBLISH_BRANCH_CHANGED', 'The site checkout is on a different branch.');
    const remote = await this.git(['remote', 'get-url', '--push', 'origin'], signal);
    if (repositoryFromRemote(remote.stdout) !== this.repository) reject('PUBLISH_REMOTE_CHANGED', 'The preconfigured remote does not match the approved public repository.');
    const tracked = await this.git(['ls-files', '-z'], signal);
    for (const file of tracked.stdout.split('\0').filter(Boolean)) if (file !== '.gitignore' && !m.files.includes(file)) reject('PRIVATE_TRACKED_FILE', 'The publishing checkout tracks a file outside the generated public allowlist.');
    // Previously staged data must also be entirely public; do not commit unrelated staged files.
    const staged = await this.git(['diff', '--cached', '--name-only', '-z'], signal);
    for (const file of staged.stdout.split('\0').filter(Boolean)) if (!m.files.includes(file)) reject('PRIVATE_STAGED_FILE', 'Unrelated staged files prevent publication.');
    for (let i = 0; i < m.files.length; i += 100) await this.git(['add', '--', ...m.files.slice(i, i + 100)], signal);
    const dirty = await this.git(['diff', '--cached', '--quiet', '--exit-code'], signal, [0, 1]);
    let changed = dirty.exitCode === 1;
    if (changed) await this.git(['commit', '-m', `Publish AI technical daily ${date} v${version}`], signal);
    const head = await this.git(['rev-parse', 'HEAD'], signal); if (!SHA.test(head.stdout)) reject('INVALID_PUBLISH_COMMIT', 'Git returned an invalid commit id.');
    // Never force push. Uncertain network outcome is reported, not retried automatically.
    try { await this.git(['push', 'origin', `HEAD:refs/heads/${this.branch}`], signal); }
    catch (error) { return { status: 'publish_uncertain', date, version, commit: head.stdout, changed, publishedUrl: reportPublicUrl(this.publicBaseUrl, date, version), marker: m.marker, reason: error.code ?? 'GIT_PUSH_UNKNOWN', automaticRetry: false }; }
    const url = reportPublicUrl(this.publicBaseUrl, date, version);
    const verified = await this.verify(url, m.marker, signal);
    return { status: verified ? 'published' : 'verification_pending', date, version, commit: head.stdout, changed, publishedUrl: url, marker: m.marker, verified, verificationAttempts: this.verifyAttempts, automaticRetry: false };
  }
  async verify(url, marker, signal) {
    if (typeof this.fetch !== 'function') return false;
    for (let attempt = 0; attempt < this.verifyAttempts; attempt++) {
      abort(signal);
      const u = new URL(url); u.searchParams.set('edition', marker);
      try {
        const controller = AbortSignal.timeout(15000); const requestSignal = signal ? AbortSignal.any([controller, signal]) : controller;
        const response = await this.fetch(u.href, { signal: requestSignal, redirect: 'error', cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
        if (response.ok) { const body = await response.text(); if (body.length < 12 * 1024 * 1024 && body.includes(`content="${marker}"`)) return true; }
      } catch { abort(signal); }
      if (attempt + 1 < this.verifyAttempts) await this.delay(this.verifyDelayMs, signal);
    }
    return false;
  }
}

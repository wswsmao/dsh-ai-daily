import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSite } from '../lib/site.js';
import { PublishGithub, validatePublicPayload, normalizeRepository } from '../lib/publish.js';
const root = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t, options = {}) {
  const base = path.join(root, '.runtime', 'tests'); await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(path.join(base, 'publish-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, '.gitignore'), '*.tmp\n', 'utf8');
  const render = await renderSite({ siteDir: dir, edition: { date: '2026-10-26', version: 2, title: 'AI日报', overview: 'Summary', articles: [{ title: 'Study', url: 'https://example.org/study', summary: 'Result' }], coverage: { complete: true } } });
  const calls = []; const hash = 'a'.repeat(40); let verifications = 0;
  const runProcess = async ({ argv, cwd, signal }) => {
    calls.push(argv); assert.equal(cwd, dir); const args = argv.slice(3);
    if (args.join(' ') === 'rev-parse --is-inside-work-tree') return { exitCode: 0, stdout: 'true' };
    if (args.join(' ') === 'rev-parse --show-toplevel') return { exitCode: 0, stdout: options.parentRepository ? path.dirname(dir) : dir };
    if (args.join(' ') === 'branch --show-current') return { exitCode: 0, stdout: options.branch ?? 'main' };
    if (args[0] === 'remote') return { exitCode: 0, stdout: options.remote ?? 'https://github.com/wswsmao/ai-tech-daily.git' };
    if (args[0] === 'ls-files') return { exitCode: 0, stdout: options.privateTracked ? 'raw-body.json\0' : '.gitignore\0index.html\0' };
    if (args.slice(0, 3).join(' ') === 'diff --cached --name-only') return { exitCode: 0, stdout: options.privateStaged ? 'credentials.json\0' : '' };
    if (args.slice(0, 3).join(' ') === 'diff --cached --quiet') return { exitCode: options.unchanged ? 0 : 1 };
    if (args.join(' ') === 'rev-parse HEAD') return { exitCode: 0, stdout: hash };
    if (args[0] === 'push' && options.pushFailure) return { exitCode: 1, stderr: 'SECRET TOKEN network failure' };
    return { exitCode: 0, stdout: '' };
  };
  const fetch = async (url) => { verifications++; assert(url.startsWith('https://wswsmao.github.io/ai-tech-daily/reports/2026-10-26-2/v2.html?edition=')); return { ok: !options.notFound, text: async () => options.outdated ? '<meta name="daily-edition" content="old">' : `<meta name="daily-edition" content="${render.marker}">` }; };
  const publisher = new PublishGithub({ siteDir: dir, runProcess, fetch, verifyAttempts: 3, verifyDelayMs: 0, delay: async () => {} });
  return { dir, render, publisher, calls, verifications: () => verifications };
}

test('publisher limits commit payload to hash-verified generated site and verifies edition marker', async (t) => {
  const f = await fixture(t); const m = await validatePublicPayload(f.dir, { date: '2026-10-26', version: 2 }); assert(m.files.includes('index.html'));
  const receipt = await f.publisher.publish({ date: '2026-10-26', version: 2 }); assert.equal(receipt.status, 'published'); assert.equal(receipt.verified, true); assert.equal(receipt.commit, 'a'.repeat(40));
  assert(f.calls.some((a) => a.includes('commit'))); assert(f.calls.some((a) => a.includes('push') && a.includes('HEAD:refs/heads/main')));
  const adds = f.calls.filter((a) => a[3] === 'add'); assert(adds.every((a) => !a.includes('.') && !a.includes('-A'))); assert.equal(f.verifications(), 1);
});
test('unchanged site does not create duplicate commits', async (t) => { const f = await fixture(t, { unchanged: true }); const r = await f.publisher.publish({ date: '2026-10-26', version: 2 }); assert.equal(r.changed, false); assert(!f.calls.some((a) => a.includes('commit'))); });
test('private tracked or staged data, wrong repository root, branch or remote block public push', async (t) => {
  for (const options of [{ privateTracked: true }, { privateStaged: true }, { parentRepository: true }, { branch: 'private' }, { remote: 'https://user:secret@github.com/wswsmao/ai-tech-daily.git' }, { remote: 'https://github.com/attacker/ai-tech-daily.git' }]) {
    const f = await fixture(t, options); await assert.rejects(() => f.publisher.publish({ date: '2026-10-26', version: 2 }), { name: 'PublishError' }); assert(!f.calls.some((a) => a.includes('push')));
  }
});
test('tampered public file or outdated edition rejected before Git operations', async (t) => {
  const f = await fixture(t); await fs.appendFile(path.join(f.dir, 'index.html'), 'tampered'); await assert.rejects(() => f.publisher.publish({ date: '2026-10-26', version: 2 }), { code: 'PUBLIC_FILE_CHANGED' }); assert.equal(f.calls.length, 0);
  const g = await fixture(t); await assert.rejects(() => g.publisher.publish({ date: '2026-10-25', version: 2 }), { code: 'OUTDATED_SITE' });
});
test('Git push uncertainty and stale Pages result do not trigger duplicate automatic pushes', async (t) => {
  const f = await fixture(t, { pushFailure: true }); const r = await f.publisher.publish({ date: '2026-10-26', version: 2 }); assert.equal(r.status, 'publish_uncertain'); assert.equal(r.automaticRetry, false); assert(!JSON.stringify(r).includes('SECRET')); assert.equal(f.calls.filter((a) => a.includes('push')).length, 1); assert.equal(f.verifications(), 0);
  const g = await fixture(t, { outdated: true }); const s = await g.publisher.publish({ date: '2026-10-26', version: 2 }); assert.equal(s.status, 'verification_pending'); assert.equal(g.verifications(), 3); assert.equal(g.calls.filter((a) => a.includes('push')).length, 1);
});
test('repo and branch syntax rejects command injection; cancellation never starts process', async (t) => {
  for (const value of ['../private', 'wswsmao/a;rm -rf /', 'http://host/repo', '-option/repo']) assert.throws(() => normalizeRepository(value));
  const f = await fixture(t); const c = new AbortController(); c.abort(); await assert.rejects(() => f.publisher.publish({ date: '2026-10-26', version: 2, signal: c.signal })); assert.equal(f.calls.length, 0);
});

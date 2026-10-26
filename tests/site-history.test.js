import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSite } from '../lib/site.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const edition = (date, title) => ({ date, version: 1, title, articles: [], coverage: { complete: true } });
test('historical backfill preserves latest landing page and automatic history', async (t) => {
  const base = path.join(root, '.runtime/tests'); await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(path.join(base, 'history-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await renderSite({ siteDir: dir, edition: edition('2026-10-26', 'Latest report') });
  await renderSite({ siteDir: dir, edition: edition('2026-10-24', 'Backfill report') });
  const latest = await fs.readFile(path.join(dir, 'index.html'), 'utf8'); assert(latest.includes('<h1>Latest report</h1>')); assert(latest.includes('2026-10-24'));
  const archive = await fs.readFile(path.join(dir, 'archive.html'), 'utf8'); assert(archive.includes('2026-10-26')); assert(archive.includes('2026-10-24'));
});

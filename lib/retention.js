import fs from 'node:fs/promises';
import path from 'node:path';

/** Delete expired runtime artefacts so a month of diagnostics never fills the disk.
 *
 *  Retention is a parameter (default 30 days): recent runs stay inspectable, older ones go.
 *  Two things are never touched: the published archive under reports/ (that is the product) and
 *  article-index.json (it carries cross-day dedupe history, which must outlive the retention window).
 */
const KEEP_ALWAYS = new Set(['article-index.json', 'deliveries.json', 'occurrences.json']);

export async function pruneExpired({ runtimeDir, runsDir, retentionDays = 30, clock = () => new Date() } = {}) {
  const cutoff = clock().getTime() - Math.max(1, Number(retentionDays) || 30) * 86400000;
  const removed = { runs: 0, files: 0, bytes: 0 };

  const sizeOf = async (target) => {
    let total = 0;
    const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) total += await sizeOf(full);
      else total += await fs.stat(full).then((s) => s.size).catch(() => 0);
    }
    return total;
  };

  // Expired run directories: their state.json started_at is the authority, not mtime.
  if (runsDir) {
    const ids = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of ids) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(runsDir, entry.name);
      const state = await fs.readFile(path.join(dir, 'state.json'), 'utf8').then(JSON.parse).catch(() => null);
      const started = Date.parse(state?.started_at ?? '') || 0;
      // A run that has not started yet has no timestamp: leave it alone rather than guess.
      if (!started || started >= cutoff) continue;
      const bytes = await sizeOf(dir);
      const ok = await fs.rm(dir, { recursive: true, force: true }).then(() => true).catch(() => false);
      if (ok) { removed.runs += 1; removed.bytes += bytes; }
    }
  }

  // Expired loose files directly under the runtime root.
  if (runtimeDir) {
    const entries = await fs.readdir(runtimeDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || KEEP_ALWAYS.has(entry.name)) continue;
      const full = path.join(runtimeDir, entry.name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.mtimeMs >= cutoff) continue;
      const ok = await fs.rm(full, { force: true }).then(() => true).catch(() => false);
      if (ok) { removed.files += 1; removed.bytes += stat.size; }
    }
  }

  return removed;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruneExpired } from '../lib/retention.js';

/** Retention used to age every run directory on the same window, which kept ten failed runs for thirty
 *  days. A run that produced no edition has diagnostics worth a day or two, not a month, so it ages out
 *  faster while finished editions keep the configured window.
 */

async function runDir(root, id, { status, startedAt, files = {} }) {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ run_id: id, status, started_at: startedAt }), 'utf8');
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body, 'utf8');
  return dir;
}

async function layout(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runs = path.join(root, 'runs');
  await fs.mkdir(runs, { recursive: true });
  return { root, runs };
}

const now = new Date('2026-10-30T04:00:00Z');
const clock = () => now;
const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();

test('a failed run ages out after three days', async (t) => {
  const { root, runs } = await layout(t);
  await runDir(runs, 'old-failed', { status: 'failed', startedAt: daysAgo(4) });
  await runDir(runs, 'new-failed', { status: 'failed', startedAt: daysAgo(1) });
  const r = await pruneExpired({ runtimeDir: root, runsDir: runs, retentionDays: 30, clock });
  assert.equal(r.runs, 1);
  assert.equal(await fs.access(path.join(runs, 'old-failed')).then(() => true).catch(() => false), false);
  assert.equal(await fs.access(path.join(runs, 'new-failed')).then(() => true).catch(() => false), true, 'a recent failure is still inspectable');
});

test('an interrupted run ages out on the same short window', async (t) => {
  const { root, runs } = await layout(t);
  await runDir(runs, 'old-interrupted', { status: 'interrupted', startedAt: daysAgo(5) });
  const r = await pruneExpired({ runtimeDir: root, runsDir: runs, retentionDays: 30, clock });
  assert.equal(r.runs, 1);
});

test('a finished edition keeps the configured window', async (t) => {
  const { root, runs } = await layout(t);
  await runDir(runs, 'complete-10d', { status: 'complete', startedAt: daysAgo(10) });
  await runDir(runs, 'partial-10d', { status: 'partial', startedAt: daysAgo(10) });
  const r = await pruneExpired({ runtimeDir: root, runsDir: runs, retentionDays: 30, clock });
  assert.equal(r.runs, 0, 'finished editions are still inside the 30-day window');
  await pruneExpired({ runtimeDir: root, runsDir: runs, retentionDays: 5, clock });
  assert.equal(await fs.access(path.join(runs, 'complete-10d')).then(() => true).catch(() => false), false, 'and age out on the configured window');
});

test('a run with no start timestamp is left alone', async (t) => {
  const { root, runs } = await layout(t);
  const dir = path.join(runs, 'no-time');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ status: 'failed' }), 'utf8');
  const r = await pruneExpired({ runtimeDir: root, runsDir: runs, retentionDays: 30, clock });
  assert.equal(r.runs, 0);
});

test('the protected files are never removed regardless of age', async (t) => {
  const { root, runs } = await layout(t);
  const old = new Date(now.getTime() - 400 * 86400000);
  for (const name of ['article-index.json', 'deliveries.json', 'occurrences.json']) {
    const file = path.join(root, name);
    await fs.writeFile(file, '{}', 'utf8');
    await fs.utimes(file, old, old);
  }
  await fs.writeFile(path.join(root, 'scratch.json'), '{}', 'utf8');
  await fs.utimes(path.join(root, 'scratch.json'), old, old);
  await pruneExpired({ runtimeDir: root, runsDir: runs, retentionDays: 30, clock });
  for (const name of ['article-index.json', 'deliveries.json', 'occurrences.json']) {
    assert.equal(await fs.access(path.join(root, name)).then(() => true).catch(() => false), true, `${name} must survive`);
  }
  assert.equal(await fs.access(path.join(root, 'scratch.json')).then(() => true).catch(() => false), false, 'ordinary scratch files still expire');
});

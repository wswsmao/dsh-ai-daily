import fs from 'node:fs/promises';
import path from 'node:path';

/** Read the reader's votes and turn them into facts about the sources behind them.
 *
 *  The point of a down-vote is not to lower one article's score: it says the screening let something
 *  through that should not have appeared. Acting on that means changing how the next edition judges the
 *  same kind of content, so this module only aggregates - by account and by category - and hands the
 *  numbers to the model. No score, no threshold, no automatic exclusion: deciding what the numbers mean
 *  is exactly the judgement being asked for.
 */

const MAX_REASON = 300;

async function readJsonl(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`FEEDBACK_UNREADABLE: ${file}：${String(error?.message ?? error).slice(0, 200)}`);
  }
  const rows = [];
  for (const [i, line] of raw.split('\n').entries()) {
    const text = line.trim();
    if (!text) continue;
    try {
      rows.push(JSON.parse(text));
    } catch (error) {
      // A half-written line is a real defect: silently dropping it would make the review act on a
      // partial picture. Name the line so it can be inspected.
      throw new Error(`FEEDBACK_LINE_INVALID: 第 ${i + 1} 行不是合法 JSON：${text.slice(0, 120)}`);
    }
  }
  return rows;
}

/** Aggregate votes into per-account and per-category counts, newest reasons first. */
export async function loadFeedback({ file, sinceDays = 120, clock = () => new Date() } = {}) {
  if (!file) throw new Error('FEEDBACK_FILE_NOT_CONFIGURED');
  const all = await readJsonl(file);
  const cutoff = clock().getTime() - sinceDays * 86400000;
  const rows = all.filter((r) => {
    const t = Date.parse(r?.at ?? '');
    return Number.isFinite(t) && t >= cutoff;
  });

  const byAccount = new Map();
  const byCategory = new Map();
  const bump = (map, key, verdict, reason, title, at) => {
    if (!key) return;
    const row = map.get(key) ?? { good: 0, bad: 0, reasons: [] };
    row[verdict] += 1;
    if (verdict === 'bad' && reason) {
      row.reasons.push({ at: String(at ?? '').slice(0, 10), title: String(title ?? '').slice(0, 80), reason: String(reason).slice(0, MAX_REASON) });
      if (row.reasons.length > 12) row.reasons = row.reasons.slice(-12);
    }
    map.set(key, row);
  };

  for (const r of rows) {
    const verdict = r?.verdict === 'bad' ? 'bad' : 'good';
    bump(byAccount, String(r?.account ?? r?.author ?? '').trim(), verdict, r?.reason, r?.title, r?.at);
    bump(byCategory, String(r?.category ?? '').trim(), verdict, r?.reason, r?.title, r?.at);
  }

  const plain = (m) => Object.fromEntries([...m.entries()].sort((a, b) => b[1].bad - a[1].bad || b[1].good - a[1].good));
  return { total: rows.length, sinceDays, byAccount: plain(byAccount), byCategory: plain(byCategory) };
}

/** The facts one candidate carries into the judgement. Null when nothing is known about its source. */
export function feedbackForAccount(feedback, account) {
  const key = String(account ?? '').trim();
  if (!feedback || !key) return null;
  const row = feedback.byAccount?.[key];
  if (!row) return null;
  return { good: row.good, bad: row.bad, reasons: row.reasons.slice(-5) };
}

export function feedbackSummary(feedback) {
  if (!feedback || !feedback.total) return null;
  return {
    votes: feedback.total,
    since_days: feedback.sinceDays,
    accounts: Object.entries(feedback.byAccount ?? {})
      .slice(0, 20)
      .map(([account, v]) => ({ account, good: v.good, bad: v.bad })),
    categories: Object.entries(feedback.byCategory ?? {})
      .slice(0, 10)
      .map(([category, v]) => ({ category, good: v.good, bad: v.bad })),
  };
}

export const feedbackPath = (projectDir) => path.join(projectDir, '.runtime', 'feedback.jsonl');

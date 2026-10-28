import { sha256 } from './io.js';

/** Stage L5: collapse candidates onto distinct information points, apply the judged quality score,
 *  then apply the 7:2:1 budget with a ~30 article target.
 *
 *  IMPORTANT: every judgement about content (quality, which of several duplicates is best) is made
 *  by the model. This module only performs deterministic work: grouping, thresholding, quota
 *  arithmetic and ordering. Regex/keyword counting must never stand in for understanding - a
 *  marketing post saying "重磅发布，性能提升 100 倍" would score high on keywords and is junk. */
/** Turn raw articles into ranking rows, applying the pre-screen gate.
 *  An article with no keep verdict never passed the gate: it is only here because pass 2 opened it
 *  without a keep-list, and those were exactly the industry reports that used to slip in. */
export function toRows(articles) {
  return (articles ?? [])
    .filter((a) => a && a.analysis && !a.analysis.processing_error)
    .map((a) => ({ article: a, category: normalizeCategory(a), quality: readScore(a), point: a.prescreen?.point ?? '' }))
    .filter((r) => r.article?.prescreen?.keep === true);
}

/** Rank two rows. Score first; equal scores fall back to the model's tie verdict, and only when the
 *  model has not judged them does the original order decide. The code never invents a preference. */
export function compareRows(a, b) {
  const byScore = (b.quality?.total ?? 0) - (a.quality?.total ?? 0);
  if (byScore !== 0) return byScore;
  const ra = a.quality?.tie_rank;
  const rb = b.quality?.tie_rank;
  const aJudged = Number.isInteger(ra);
  const bJudged = Number.isInteger(rb);
  if (aJudged && bJudged && ra !== rb) return ra - rb;
  if (aJudged !== bJudged) return aJudged ? -1 : 1;  // a judged article outranks an unjudged tie
  return 0;
}

/** Groups of rows sharing the same total score, where the model must decide the order.
 *  Only groups with 2+ members are returned, and only within a score band that actually competes
 *  for a slot (callers pass the rows they care about). */
export function findTieGroups(rows) {
  const byScore = new Map();
  for (const row of rows ?? []) {
    const total = row.quality?.total;
    if (!Number.isFinite(total)) continue;
    const g = byScore.get(total) ?? [];
    g.push(row);
    byScore.set(total, g);
  }
  return [...byScore.values()].filter((g) => g.length > 1);
}

export function selectEdition(articles, { target = 30, ratio = { application: 0.7, model: 0.2, hardware: 0.1 }, minScore = 6 } = {}) {
  const eligible = toRows(articles);

  // A missing score means the model never judged it; treat that as unscored, not as zero, so we do
  // not silently drop good articles when scoring is unavailable.
  const scored = eligible.filter((r) => r.quality !== null);
  const unscored = eligible.filter((r) => r.quality === null);

  // Hard floor on the judged score: below it an article is not good enough for any topic, however thin.
  const passing = scored.filter((r) => r.quality.total >= minScore);
  const below = scored.length - passing.length;

  // Collapse onto distinct information points: same point -> keep the better ranked one.
  const byPoint = new Map();
  for (const row of [...passing, ...unscored.map((r) => ({ ...r, quality: r.quality ?? { total: minScore } }))]) {
    const key = pointKey(row.point, row.article);
    const prior = byPoint.get(key);
    if (!prior || compareRows(row, prior) < 0) byPoint.set(key, row);
  }
  const unique = [...byPoint.values()].sort(compareRows);

  const quota = {};
  for (const [k, r] of Object.entries(ratio)) quota[k] = Math.round(target * r);
  const picked = [];
  const used = { application: 0, model: 0, hardware: 0 };
  const leftovers = [];

  for (const row of unique) {
    const cat = row.category;
    // Unknown category is not a reason to drop: it only loses priority.
    if (cat === 'none') { leftovers.push(row); continue; }
    if (used[cat] < quota[cat]) { picked.push(row); used[cat] += 1; }
    else leftovers.push(row);
  }
  // Unused quota in a thin category flows to the best remaining articles of any category.
  leftovers.sort(compareRows);
  for (const row of leftovers) {
    if (picked.length >= target) break;
    picked.push(row);
  }

  const counts = { application: 0, model: 0, hardware: 0 };
  for (const row of picked) if (row.category !== 'none') counts[row.category] += 1;
  return {
    articles: picked.map((r) => r.article),
    stats: {
      candidates: articles.length,
      scored: scored.length,
      unscored: unscored.length,
      belowThreshold: below,
      uniquePoints: unique.length,
      selected: picked.length,
      counts,
      target,
      deduped: unique.length ? eligible.length - unique.length : 0,
      minScore,
    },
  };
}

/** Read the score the model already attached to the article. Returns null when absent. */
function readScore(article) {
  const q = article?.analysis?.quality ?? article?.quality;
  if (!q || typeof q !== 'object') return null;
  const dims = ['novelty', 'specificity', 'depth', 'firstHand', 'honesty'];
  const values = dims.map((d) => Number(q[d]));
  if (values.some((v) => !Number.isFinite(v))) return null;
  const total = Number.isFinite(Number(q.total)) ? Number(q.total) : values.reduce((a, b) => a + b, 0);
  // tie_rank comes from the model's tie verdict (see tie-judge.js); carrying it here is what lets
  // compareRows order equal scores without the code inventing a preference.
  const tieRank = article?.analysis?.tie_rank ?? q.tie_rank;
  const score = { novelty: values[0], specificity: values[1], depth: values[2], firstHand: values[3], honesty: values[4], total };
  if (Number.isInteger(tieRank)) score.tie_rank = tieRank;
  return score;
}

export function normalizeCategory(article) {
  const c = article?.prescreen?.category;
  if (c === 'application' || c === 'model' || c === 'hardware') return c;
  return 'none';
}

/** Build model payloads that ask for (a) a 5-dimension quality score and (b) pairwise votes inside
 *  each duplicated information point. The caller runs the model; this stays free of content logic. */
export function buildJudgementBatches(rows, { batchSize = 8 } = {}) {
  const batches = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    batches.push(rows.slice(i, i + batchSize).map((r, n) => ({
      n,
      title: String(r.article?.title ?? '').slice(0, 200),
      summary: String(r.article?.analysis?.summary_zh ?? '').slice(0, 1200),
      point: String(r.point ?? '').slice(0, 300),
    })));
  }
  return batches;
}

/** Pairwise comparison groups: only points with 2+ candidates need a vote. */
export function buildVoteGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.point || pointKey(row.point, row.article);
    const g = groups.get(key) ?? [];
    g.push(row);
    groups.set(key, g);
  }
  const out = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    out.push({
      point: key,
      candidates: list.map((r, i) => ({
        n: i,
        title: String(r.article?.title ?? '').slice(0, 200),
        summary: String(r.article?.analysis?.summary_zh ?? '').slice(0, 700),
      })),
    });
  }
  return out;
}

/** Apply votes: `verdicts` maps a point to winning indices ordered best-first. */
export function applyVotes(rows, verdicts) {
  if (!verdicts || !Object.keys(verdicts).length) return rows;
  const keep = new Set();
  for (const [point, order] of Object.entries(verdicts)) {
    const list = rows.filter((r) => (r.point || pointKey(r.point, r.article)) === point);
    const winner = Number.isInteger(order?.[0]) ? list[order[0]] : undefined;
    if (winner) keep.add(winner);
  }
  return rows.filter((r) => {
    const p = r.point || pointKey(r.point, r.article);
    return !(p in verdicts) || keep.has(r);
  });
}

export function pointKey(point, article) {
  const p = String(point ?? '').trim().toLowerCase().replace(/\s+/gu, '');
  if (p.length >= 8) return sha256(p);
  // Without a usable point, fall back to the article identity so nothing is merged blindly.
  return sha256(`id:${article?.id ?? article?.url ?? ''}`);
}

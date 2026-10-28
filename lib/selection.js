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
export function toRows(articles, allowed = null) {
  return (articles ?? [])
    .filter((a) => a && a.analysis && !a.analysis.processing_error)
    .map((a) => ({ article: a, category: normalizeCategory(a, allowed), quality: readScore(a), point: a.prescreen?.point ?? '' }))
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

  // Collapse onto distinct information points first: the same story reported twice is one article.
  const byPoint = new Map();
  for (const row of eligible) {
    const key = pointKey(row.point, row.article);
    const prior = byPoint.get(key);
    if (!prior || compareRows(row, prior) < 0) byPoint.set(key, row);
  }
  const unique = [...byPoint.values()].sort(compareRows);

  // Short-pool rule: when the pool cannot fill the target, publish what there is. Dropping an article
  // for scoring below the floor makes no sense while dozens of slots sit empty - the reader would
  // rather see a decent piece than a gap.
  if (unique.length <= target) {
    const counts = Object.fromEntries(Object.keys(ratio).map((k) => [k, 0]));
    for (const row of unique) if (row.category !== 'none') counts[row.category] += 1;
    const scored = unique.filter((r) => r.quality !== null);
    return {
      articles: unique.map((r) => r.article),
      stats: {
        candidates: articles.length,
        scored: scored.length,
        unscored: unique.length - scored.length,
        belowThreshold: 0,
        uniquePoints: unique.length,
        selected: unique.length,
        counts,
        target,
        deduped: eligible.length - unique.length,
        minScore,
        shortPool: true,
      },
    };
  }

  const scored = unique.filter((r) => r.quality !== null);
  const unscored = unique.filter((r) => r.quality === null);
  // Only now, with more than a full edition available, does the quality floor apply.
  const passing = scored.filter((r) => (r.quality?.total ?? 0) >= minScore);
  const below = scored.length - passing.length;
  const ranked = [...passing, ...unscored].sort(compareRows);

  // Per-category名额: each category keeps its best n. Unused seats in a thin category flow to the
  // best remaining articles overall, so the edition is never left short for the sake of a ratio.
  const quota = {};
  for (const [k, r] of Object.entries(ratio)) quota[k] = Math.round(target * r);
  const picked = [];
  const used = Object.fromEntries(Object.keys(ratio).map((k) => [k, 0]));
  const leftovers = [];
  for (const row of ranked) {
    const cat = row.category;
    if (cat === 'none') { leftovers.push(row); continue; }
    if (used[cat] < quota[cat]) { picked.push(row); used[cat] += 1; }
    else leftovers.push(row);
  }
  leftovers.sort(compareRows);
  for (const row of leftovers) {
    if (picked.length >= target) break;
    picked.push(row);
  }
  picked.sort(compareRows);

  const counts = Object.fromEntries(Object.keys(ratio).map((k) => [k, 0]));
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

/** Resolve an article's category against the configured set. A category the configuration does not
 *  define is a real failure (the model ignored the instruction), so it throws instead of degrading to
 *  a placeholder - a silently unclassified article would rank into the edition unnoticed. */
export function normalizeCategory(article, allowed = null) {
  const c = article?.prescreen?.category;
  if (!c) {
    // No verdict at all: the gate filters these out before ranking, so this is not reached in a
    // normal run. Return null rather than inventing a category.
    return null;
  }
  if (allowed && !allowed.includes(c)) {
    throw new Error(`MODEL_CATEGORY_INVALID: 《${String(article?.title ?? '')}》的分类 "${c}" 不在配置中。有效分类：${allowed.join(', ')}`);
  }
  return c;
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

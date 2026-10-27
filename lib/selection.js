import { sha256 } from './io.js';

/** Stage L5: collapse candidates onto distinct information points, then apply the 7:2:1
 *  category budget with a ~30 article target. Never pad with low-value articles to hit a
 *  quota; never drop a high-value article just to satisfy a ratio. Rules: config/selection-policy.md. */
export function selectEdition(articles, { target = 30, ratio = { application: 0.7, model: 0.2, hardware: 0.1 } } = {}) {
  const scored = articles
    .filter((a) => a && a.analysis && !a.analysis.processing_error)
    .map((a) => ({ article: a, category: normalizeCategory(a), value: valueScore(a), point: a.prescreen?.point ?? '' }));

  // Collapse onto distinct information points: same point -> keep the highest value one.
  const byPoint = new Map();
  for (const row of scored) {
    const key = pointKey(row.point, row.article);
    const prior = byPoint.get(key);
    if (!prior || row.value > prior.value) byPoint.set(key, row);
  }
  const unique = [...byPoint.values()].sort((a, b) => b.value - a.value);

  const quota = {};
  for (const [k, r] of Object.entries(ratio)) quota[k] = Math.round(target * r);
  const picked = [];
  const used = { application: 0, model: 0, hardware: 0 };
  const leftovers = [];

  for (const row of unique) {
    const cat = row.category;
    // An unknown category (pre-screen did not run) is not a reason to drop an article: it only loses
    // priority. Dropping it would silently empty editions whenever pre-screening is unavailable.
    if (cat === 'none') { leftovers.push(row); continue; }
    if (used[cat] < quota[cat]) { picked.push(row); used[cat] += 1; }
    else leftovers.push(row);
  }
  // Unused quota in a thin category flows to the best remaining articles of any category.
  leftovers.sort((a, b) => b.value - a.value);
  for (const row of leftovers) {
    if (picked.length >= target) break;
    picked.push(row);
  }

  const counts = { application: 0, model: 0, hardware: 0 };
  for (const row of picked) counts[row.category] += 1;
  return {
    articles: picked.map((r) => r.article),
    stats: {
      candidates: articles.length,
      analyzed: scored.length,
      uniquePoints: unique.length,
      selected: picked.length,
      counts,
      target,
      deduped: unique.length ? scored.length - unique.length : 0,
    },
  };
}

function normalizeCategory(article) {
  const c = article?.prescreen?.category;
  if (c === 'application' || c === 'model' || c === 'hardware') return c;
  return 'none';
}

/** Value = concrete evidence (numbers, named systems, measurements) plus specificity of the point.
 *  Popularity signals are deliberately excluded: they favour entry-level content over the
 *  architecture-level progress this digest is for. */
function valueScore(article) {
  const text = `${article?.title ?? ''}\n${article?.analysis?.summary_zh ?? ''}\n${article?.prescreen?.point ?? ''}`;
  let score = 0;
  const specifics = text.match(/(\d+(\.\d+)?\s*(%|pp|倍|token|tokens|ms|s\b|GB|B\b|K\b|M\b)|arXiv[: ]\d{4}\.\d{4,5}|v\d+\.\d+|CVE-\d{4}-\d+|SOTA|开源|发布|提出)/giu);
  if (specifics) score += Math.min(6, specifics.length);
  if (article?.analysis?.status === 'technical') score += 2;
  const quotes = Array.isArray(article?.analysis?.evidence_quotes) ? article.analysis.evidence_quotes.length : 0;
  score += Math.min(3, quotes);
  if (article?.body_complete === true) score += 1;
  if (article?.prescreen?.keep === true) score += 2;
  return score;
}

function pointKey(point, article) {
  const p = String(point ?? '').trim().toLowerCase().replace(/\s+/gu, '');
  if (p.length >= 8) return sha256(p);
  // Without a usable point, fall back to the article identity so nothing is merged blindly.
  return sha256(`id:${article?.id ?? article?.url ?? ''}`);
}

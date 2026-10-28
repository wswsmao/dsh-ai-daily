/** Stage L5a: break ties between equally scored articles by asking the model, not the code.
 *
 *  Why this exists: the 5-dimension score has only 11 possible values (0-10), so equal totals are
 *  common. Sorting equal scores by array position was arbitrary - the order came from collection
 *  order, which means nothing about quality. Deciding "which of these two is better" is a judgement
 *  about content, so the model makes it and both full texts are supplied.
 *
 *  Delegation: when a live parent Agent exists the verdict comes from a sub-agent, which sees the
 *  contested group in isolation. Scheduled runs have no initiator, so they fall back to a direct
 *  model call with the same prompt.
 *
 *  Every call is charged to the shared model budget so the run's usage stays observable.
 */
import { judgeContestedSeat } from './seat-judge.js';

export async function judgeTies({ ctx, llm, selection, groups, signal, onUsage, maxCharsPerArticle = 20000, maxCalls = 40 }) {
  let calls = 0;
  for (const group of groups) {
    checkAbortSignal(signal);
    if (calls >= maxCalls) break;
    if (!Array.isArray(group) || group.length < 2) continue;

    // The whole group contests a single seat ordering; ask once for the full order.
    const seats = group.length;
    try {
      const verdict = await judgeContestedSeat({ ctx, llm, selection, rows: group, seats, signal, maxCharsPerArticle });
      calls += 1;
      onUsage?.(1, verdict.via);
      const order = Array.isArray(verdict?.keep) ? verdict.keep.filter((n) => Number.isInteger(n) && n >= 0 && n < group.length) : [];
      if (order.length !== group.length) continue; // incomplete verdict: leave this group in score order
      group.forEach((row, i) => {
        const rank = order.indexOf(i);
        if (rank < 0) return;
        const reason = String(verdict?.reason ?? '').slice(0, 200);
        row.quality = { ...row.quality, tie_rank: rank, tie_reason: reason };
        // Also persist onto the article: selection rebuilds its rows from articles, so a verdict kept
        // only on the transient row object would be lost before ranking.
        if (row.article) {
          row.article.analysis = row.article.analysis ?? {};
          row.article.analysis.tie_rank = rank;
          row.article.analysis.tie_reason = reason;
        }
      });
    } catch (e) {
      checkAbortSignal(signal);
      // A failed verdict must not drop articles; keep the score order.
    }
  }
  return calls;
}

function checkAbortSignal(signal) {
  if (signal?.aborted) throw new Error('CANCELLED');
}

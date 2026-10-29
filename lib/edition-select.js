import { runFileJob } from './file-job.js';

/** Stage L6: choose the edition from the whole candidate pool in one judgement.
 *
 *  The pool is written to a file and a sub-agent reads it: it can read in as many passes as the work
 *  needs, so a large pool is limited by the agent's own reading strategy rather than by a prompt
 *  size. The verdict comes back as a file, never as parsed reply text.
 *
 *  Every content judgement belongs to the model. This module states the goal, the seat counts and the
 *  one-article-per-story rule, then maps indices back to rows.
 */

// Even when the pool is short, an article the model scored at the bottom is not a filler.
const MAX_FLOOR_IN_SHORT_POOL = 4;

function shortPoolResult(rows, target, minScore) {
  const floor = Math.min(minScore, MAX_FLOOR_IN_SHORT_POOL);
  const kept = (rows ?? []).filter((r) => r.quality === null || (r.quality?.total ?? 0) >= floor);
  const dropped = (rows?.length ?? 0) - kept.length;
  return {
    rows: kept,
    via: 'none',
    reason: dropped
      ? `候选不足，保留 ${kept.length} 篇（低于 ${floor} 分的 ${dropped} 篇除外）`
      : '候选不足，全部保留',
    candidateCount: rows?.length ?? 0,
    droppedByFloor: dropped,
  };
}

function buildPool(rows) {
  return {
    candidates: rows.map((row, index) => ({
      index,
      title: String(row.article?.title ?? '').slice(0, 200),
      account: String(row.article?.account ?? '').slice(0, 60),
      category: row.category,
      score: row.quality?.total ?? null,
      summary: String(row.article?.analysis?.summary_zh ?? '').slice(0, 800),
    })),
  };
}

function buildInstruction({ target, ratioLine, categoryLine }) {
  return [
    '你在为一个技术日报选稿。读者是有经验的操作系统工程师，关注 AI 尤其是 Agent 系统与架构层的新进展，',
    '要的是"看完能知道一件昨天不知道的事"。',
    '',
    '输入文件里的每篇都已经过全文阅读与打分，字段含义：',
    `- category：${categoryLine}`,
    '- score：0-10 的内容质量分（新颖度、具体性、系统层深度、一手性、诚实度）',
    '- summary：这篇讲了什么',
    '',
    `本次要选出 ${target} 篇，名额分配：${ratioLine}。`,
    `候选多于名额时按你的判断取舍；候选不足 ${target} 篇则全部保留。`,
    '',
    '规则只有一条：同一件事的多篇报道只留最值得读的一篇。',
    '',
    '输出文件写成：{"keep":[候选index...],"reason":"整体取舍说明"}，keep 按推荐优先级从高到低。',
  ].join('\n');
}

function applyKeep(rows, verdict) {
  const keep = (verdict.keep ?? [])
    .filter((n) => Number.isInteger(n) && n >= 0 && n < rows.length)
    .filter((n, i, all) => all.indexOf(n) === i);
  if (!keep.length) {
    return {
      rows,
      via: verdict.via,
      reason: verdict.reason,
      candidateCount: rows.length,
      emptyVerdict: true,
    };
  }
  return {
    rows: keep.map((n) => rows[n]),
    via: verdict.via,
    reason: verdict.reason,
    candidateCount: rows.length,
  };
}

/** Choose which rows to publish. Returns the selected rows in the agent's order. */
export async function chooseEdition({
  ctx,
  cwd,
  dir,
  llm,
  selection,
  rows,
  target,
  ratio,
  categories,
  minScore = 6,
  signal,
}) {
  // A pool that cannot fill the edition is published almost whole: empty seats help nobody. The
  // exception is an article the model scored at the bottom - that is a burden, not a filler.
  if (!Array.isArray(rows) || rows.length <= target) {
    return shortPoolResult(rows, target, minScore);
  }

  const ratioLine = Object.entries(ratio)
    .map(([k, v]) => `${k} ${Math.round(target * v)}`)
    .join('，');
  const categoryLine = Object.entries(categories ?? {})
    .map(([k, d]) => `${k}（${d}）`)
    .join(' | ');
  const instruction = buildInstruction({ target, ratioLine, categoryLine });

  const answer = await runFileJob({
    ctx,
    cwd,
    dir,
    name: 'edition',
    input: buildPool(rows),
    instruction,
    label: 'edition-select',
    signal,
  });
  return applyKeep(rows, { keep: answer?.keep, reason: answer?.reason, via: 'agent' });
}


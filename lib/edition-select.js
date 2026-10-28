/** Stage L6: choose the edition from the whole candidate pool in a single judgement.
 *
 *  The pool already carries each article's category, score and summary - the model's own reading of
 *  the body. Handing the entire pool to one agent and stating the goal, the seat counts and the
 *  "one article per story" rule is enough: how to compare, order and break ties is its job, not ours.
 *  Splitting the decision into per-category or per-tie-band calls loses the global view that makes
 *  those comparisons sound.
 *
 *  A sub-agent is preferred because it judges in an isolated context. Scheduled runs have no
 *  initiator Agent to own a child, so they fall back to one direct model call with the same prompt.
 */

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['keep', 'reason'],
  properties: {
    keep: { type: 'array', items: { type: 'integer' }, description: '保留的候选 index，按推荐优先级从高到低' },
    reason: { type: 'string', description: '整体取舍说明，一句话' },
  },
};

function buildSystem({ target, ratioLine, categories }) {
  const categoryLine = Object.entries(categories ?? {}).map(([k, d]) => `${k}（${d}）`).join(' | ');
  return [
    '你在为一个技术日报选稿。读者是有经验的操作系统工程师，关注 AI 尤其是 Agent 系统与架构层的新进展，',
    '要的是"看完能知道一件昨天不知道的事"。',
    '',
    `候选池里每篇都已经过全文阅读与打分，字段含义：`,
    `- \`category\`：${categoryLine}`,
    '- `score`：0-10 的内容质量分（新颖度、具体性、系统层深度、一手性、诚实度）',
    '- `summary`：这篇讲了什么',
    '',
    `本次要选出 ${target} 篇，名额分配：${ratioLine}。`,
    `候选多于名额时按你的判断取舍；候选不足 ${target} 篇则全部保留。`,
    '',
    '规则只有一条：同一件事的多篇报道只留最值得读的一篇。',
    '',
    '只输出 JSON：{"keep":[候选index...],"reason":"整体取舍说明"}。keep 按推荐优先级从高到低。',
  ].join('\n');
}

function buildPool(rows) {
  return rows.map((row, i) => ({
    index: i,
    title: String(row.article?.title ?? '').slice(0, 200),
    account: String(row.article?.account ?? '').slice(0, 60),
    category: row.category,
    score: row.quality?.total ?? null,
    summary: String(row.article?.analysis?.summary_zh ?? '').slice(0, 800),
  }));
}

async function viaSubagent({ ctx, system, pool, signal }) {
  const subagents = ctx?.get?.('subagents') ?? ctx?.subagents;
  const agents = ctx?.get?.('agents') ?? ctx?.agents;
  if (!subagents?.startActivation) return null;
  const parent = agents?.currentInitiator?.();
  // No initiator means a scheduled run owns no child session; use the direct path instead.
  if (!parent) return null;
  const provider = subagents.list?.()[0];
  if (!provider) return null;
  const activation = await subagents.startActivation({
    provider,
    label: 'edition-select',
    delivery: 'caller',
    signal,
    request: {
      parent,
      signal,
      prompt: [{ type: 'text', text: JSON.stringify(pool) }],
      outputSchema: OUTPUT_SCHEMA,
    },
  });
  try {
    const result = await activation.result;
    const structured = result?.structured;
    if (structured && Array.isArray(structured.keep)) {
      return { keep: structured.keep, reason: String(structured.reason ?? ''), via: 'subagent' };
    }
    return null;
  } finally {
    await activation.dispose?.().catch(() => {});
  }
}

async function viaDirect({ llm, selection, system, pool, signal }) {
  let text = '';
  for await (const c of llm.stream({
    ...selection,
    maxTokens: 4000,
    system,
    tools: [],
    signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(pool) }] }],
  })) {
    if (c.type === 'text-delta') text += c.text;
  }
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('EDITION_SELECT_JSON_INVALID');
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed?.keep)) throw new Error('EDITION_SELECT_SHAPE_INVALID');
  return { keep: parsed.keep, reason: String(parsed.reason ?? ''), via: 'direct' };
}

/** Choose which rows to publish. Returns the selected rows in the agent's order. */
export async function chooseEdition({ ctx, llm, selection, rows, target, ratio, categories, signal }) {
  // A pool that cannot fill the edition is published whole: dropping a good article for an empty
  // seat helps nobody.
  if (!Array.isArray(rows) || rows.length <= target) {
    return { rows: rows ?? [], via: 'none', reason: '候选不足，全部保留', candidateCount: rows?.length ?? 0 };
  }

  const ratioLine = Object.entries(ratio).map(([k, v]) => `${k} ${Math.round(target * v)}`).join('，');
  const system = buildSystem({ target, ratioLine, categories });
  const pool = buildPool(rows);

  try {
    const viaSub = await viaSubagent({ ctx, system, pool, signal });
    if (viaSub) return applyKeep(rows, viaSub);
  } catch (e) {
    if (signal?.aborted) throw e;
    // A failed child must not cost the edition; fall through to the direct call.
  }
  const direct = await viaDirect({ llm, selection, system, pool, signal });
  return applyKeep(rows, direct);
}

function applyKeep(rows, verdict) {
  const keep = (verdict.keep ?? [])
    .filter((n) => Number.isInteger(n) && n >= 0 && n < rows.length)
    .filter((n, i, all) => all.indexOf(n) === i);
  // An empty verdict means the model judged nothing publishable; keep the pool rather than emit a
  // blank edition, and record that the verdict was empty so the gap is visible.
  if (!keep.length) {
    return { rows, via: verdict.via, reason: verdict.reason, candidateCount: rows.length, emptyVerdict: true };
  }
  return { rows: keep.map((n) => rows[n]), via: verdict.via, reason: verdict.reason, candidateCount: rows.length };
}

export const EDITION_SELECT_SCHEMA = OUTPUT_SCHEMA;

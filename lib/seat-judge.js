/** Stage L6: settle a contested seat with a sub-agent when one is reachable, otherwise a direct call.
 *
 *  Why a sub-agent: several candidates tie at the cut line, and which one survives is a content
 *  judgement. A sub-agent gets an isolated context, so it sees only the contested group - the same
 *  view every time, which is what stops two calls from disagreeing about what "similar" means.
 *
 *  The sub-agent service is an optional Host capability and is absent for scheduled runs (there is no
 *  initiator Agent to own a child). When it cannot be used, the same judgement runs as one direct
 *  model call, so the feature degrades instead of disappearing.
 */

const JUDGE_SYSTEM = [
  '你是技术日报的选稿编辑。下面几篇文章在评分上并列，但席位有限，必须选出该保留的那些。',
  '只按内容价值判断：信息增量、技术具体程度、系统/架构层深度、一手性、对读者的实际价值。',
  '不要按标题口吻、公众号名气、文章长度判断。',
  '若两篇讲的是同一件事，只保留信息更完整的那一篇，并在 reason 中说明。',
].join('\n');

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['keep', 'reason'],
  properties: {
    keep: { type: 'array', items: { type: 'integer' }, description: '按优先级从高到低保留的 index 列表' },
    reason: { type: 'string', description: '一句话说明取舍依据' },
  },
};

function judgePayload(rows, seats, maxCharsPerArticle) {
  return {
    seats,
    instruction: `只能保留 ${seats} 篇，请给出保留的 index（按优先级从高到低）。`,
    articles: rows.map((row, i) => ({
      index: i,
      title: String(row.article?.title ?? '').slice(0, 200),
      account: String(row.article?.account ?? '').slice(0, 60),
      score: row.quality?.total ?? null,
      summary: String(row.article?.analysis?.summary_zh ?? '').slice(0, 600),
      body: String(row.article?.body_text ?? '').slice(0, maxCharsPerArticle),
    })),
  };
}

/** Try the sub-agent path. Returns null when unavailable so the caller can fall back. */
async function viaSubagent({ ctx, rows, seats, signal, maxCharsPerArticle, label }) {
  const subagents = ctx?.get?.('subagents') ?? ctx?.subagents;
  const agents = ctx?.get?.('agents') ?? ctx?.agents;
  if (!subagents?.startActivation) return null;
  const parent = agents?.currentInitiator?.();
  // No initiator means this run was started by a schedule rather than a conversation; a child
  // cannot be owned, so use the direct path.
  if (!parent) return null;
  const provider = subagents.list?.()[0];
  if (!provider) return null;
  const activation = await subagents.startActivation({
    provider,
    label,
    delivery: 'caller',
    signal,
    request: {
      parent,
      signal,
      prompt: [{ type: 'text', text: JSON.stringify(judgePayload(rows, seats, maxCharsPerArticle)) }],
      outputSchema: OUTPUT_SCHEMA,
    },
  });
  try {
    const result = await activation.result;
    const structured = result?.structured;
    if (structured && Array.isArray(structured.keep)) return { keep: structured.keep, reason: String(structured.reason ?? ''), via: 'subagent' };
    return null;
  } finally {
    await activation.dispose?.().catch(() => {});
  }
}

/** Direct model call: same prompt, no child session. */
async function viaDirect({ llm, selection, rows, seats, signal, maxCharsPerArticle }) {
  let text = '';
  for await (const c of llm.stream({
    ...selection,
    maxTokens: 2000,
    system: JUDGE_SYSTEM,
    tools: [],
    signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(judgePayload(rows, seats, maxCharsPerArticle)) }] }],
  })) {
    if (c.type === 'text-delta') text += c.text;
  }
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('SEAT_JUDGE_JSON_INVALID');
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed?.keep)) throw new Error('SEAT_JUDGE_SHAPE_INVALID');
  return { keep: parsed.keep, reason: String(parsed.reason ?? ''), via: 'direct' };
}

/** Judge one contested group and return the indices to keep, in the model's order. */
export async function judgeContestedSeat({ ctx, llm, selection, rows, seats, signal, maxCharsPerArticle = 8000 }) {
  // A single row needs no verdict; anything larger must be ranked by the model even when every row
  // fits, because the point is the *order* (which one is best), not merely the cut.
  if (!Array.isArray(rows) || rows.length <= 1) {
    return { keep: (rows ?? []).map((_, i) => i), reason: '无需裁决', via: 'none' };
  }
  let usedSubagent = false;
  try {
    const viaSub = await viaSubagent({ ctx, rows, seats, signal, maxCharsPerArticle, label: 'seat-judge' });
    if (viaSub && viaSub.keep.length) return viaSub;
    usedSubagent = true;
  } catch (e) {
    if (signal?.aborted) throw e;
    // A failed child must not lose the decision; fall through to the direct call.
  }
  const direct = await viaDirect({ llm, selection, rows, seats, signal, maxCharsPerArticle });
  return { ...direct, subagentAttempted: usedSubagent };
}

export const SEAT_JUDGE_SCHEMA = OUTPUT_SCHEMA;

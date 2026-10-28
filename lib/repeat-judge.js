/** Stage L5b: decide whether today's article repeats something already published.
 *
 *  A content hash only catches byte-identical bodies. Real reposts get a new intro, a different
 *  headline, or light edits, so the hash differs and the same story is published twice. Whether two
 *  pieces carry "the same story" is a judgement about content, so the model makes it - the code only
 *  pairs candidates by shared topic and applies the verdict.
 */
export async function judgeRepeats({ llm, selection, articles, known, signal, onUsage, maxChars = 6000, maxCalls = 60 }) {
  // Candidates: articles that were already reported on a different day (or have no report record yet
  // but a near-identical earlier entry exists). We compare today's text against the earlier summary.
  const priorByTopic = new Map();
  for (const [id, rec] of Object.entries(known ?? {})) {
    if (!Array.isArray(rec?.reported_on) || !rec.reported_on.length) continue;
    const summary = String(rec?.analysis?.summary_zh ?? '').trim();
    if (!summary) continue;
    const topics = Array.isArray(rec?.analysis?.topics) ? rec.analysis.topics : [];
    for (const t of topics.length ? topics : ['_']) {
      const list = priorByTopic.get(t) ?? [];
      list.push({ id, summary: summary.slice(0, 600), reported_on: rec.reported_on });
      priorByTopic.set(t, list);
    }
  }

  let calls = 0;
  for (const a of articles ?? []) {
    if (calls >= maxCalls) break;
    checkAbortSignal(signal);
    if (!a?.analysis || a.analysis.processing_error) continue;
    const topics = Array.isArray(a.analysis.topics) && a.analysis.topics.length ? a.analysis.topics : ['_'];
    const pool = [];
    for (const t of topics) for (const p of priorByTopic.get(t) ?? []) if (!pool.some((x) => x.id === p.id)) pool.push(p);
    if (!pool.length) continue;

    const payload = {
      task: '判断今天这篇文章是否与之前已发布过的某篇是同一个内容（同一事件的重复报道）。',
      rules: [
        '判据是"讲的是不是同一件事/同一个系统或发布"，不是措辞相似度。',
        '同一事件的转载、洗稿、换个标题重发都算重复。',
        '同一主题但讲不同系统、不同数据、不同结论的，不算重复。',
        '拿不准时返回 match=false（宁可多推一篇，也不要漏掉新内容）。',
      ],
      article: {
        title: String(a.title ?? '').slice(0, 200),
        account: String(a.account ?? '').slice(0, 60),
        body: String(a.body_text ?? '').slice(0, maxChars),
      },
      publishedBefore: pool.slice(0, 8).map((p) => ({ id: p.id, summary: p.summary, reported_on: p.reported_on })),
    };

    try {
      const reply = await askJson(llm, selection, payload, signal);
      calls += 1;
      onUsage?.(calls);
      if (reply?.match === true) {
        a.repeated = true;
        a.repeat_of = String(reply?.of ?? '').slice(0, 120);
        a.repeat_reason = String(reply?.reason ?? '').slice(0, 200);
      } else {
        a.repeated = false;
      }
    } catch (e) {
      checkAbortSignal(signal);
      // A failed verdict must not hide articles; fall back to the hash comparison already computed.
    }
  }
  return calls;
}

async function askJson(llm, selection, payload, signal) {
  let text = '';
  for await (const c of llm.stream({ ...selection, maxTokens: 800, messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(payload) }] }], system: '你是技术编辑。只输出JSON：{"match":true|false,"of":"重复的那篇id或空","reason":"一句话"}.', tools: [], signal })) {
    if (c.type === 'text-delta') text += c.text;
  }
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('REPEAT_JUDGE_JSON_INVALID');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function checkAbortSignal(signal) {
  if (signal?.aborted) throw new Error('CANCELLED');
}

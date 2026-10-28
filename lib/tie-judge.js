/** Stage L5a: break ties between equally scored articles by asking the model, not the code.
 *
 *  Why this exists: the 5-dimension score has only 11 possible values (0-10), so equal totals are
 *  common (yesterday: eight articles on 8 points, six on 7). Sorting equal scores by array position
 *  was arbitrary - the order came from collection order, which means nothing about quality.
 *  Deciding "which of these two is better" is a judgement about content, so the model makes it and
 *  both full texts are supplied. Code only groups, asks, and applies the verdict.
 */
export async function judgeTies({ llm, selection, groups, signal, onUsage, maxCharsPerArticle = 20000, maxPairs = 40 }) {
  let calls = 0;
  for (const group of groups) {
    checkAbortSignal(signal);
    if (calls >= maxPairs) break;
    if (!Array.isArray(group) || group.length < 2) continue;

    const payload = {
      task: '下面几篇文章难度相当，请判断哪一篇最值得读。',
      rules: [
        '只按内容质量判断：信息增量、技术具体程度、系统/架构层深度、一手性、对读者的实际价值。',
        '不要按标题口吻、公众号名气或文章长度判断。',
        '必须返回 indexes，按从最值得读到最不值得读排序，且必须覆盖全部条目。',
      ],
      articles: group.map((row, i) => ({
        index: i,
        title: String(row.article?.title ?? '').slice(0, 200),
        account: String(row.article?.account ?? '').slice(0, 60),
        score: row.quality?.total ?? null,
        body: String(row.article?.body_text ?? '').slice(0, maxCharsPerArticle),
      })),
    };

    try {
      const reply = await askJson(llm, selection, payload, signal);
      calls += 1;
      onUsage?.(calls);
      const order = Array.isArray(reply?.indexes) ? reply.indexes.filter((n) => Number.isInteger(n) && n >= 0 && n < group.length) : [];
      if (order.length !== group.length) continue; // incomplete verdict: leave this group in score order
      group.forEach((row, i) => {
        const rank = order.indexOf(i);
        if (rank < 0) return;
        const reason = String(reply?.reason ?? '').slice(0, 200);
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

async function askJson(llm, selection, payload, signal) {
  let text = '';
  for await (const c of llm.stream({ ...selection, maxTokens: 2000, messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(payload) }] }], system: '你是技术编辑。只输出JSON：{"indexes":[按质量降序的索引],"reason":"一句话"}.', tools: [], signal })) {
    if (c.type === 'text-delta') text += c.text;
  }
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('TIE_JUDGE_JSON_INVALID');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function checkAbortSignal(signal) {
  if (signal?.aborted) throw new Error('CANCELLED');
}

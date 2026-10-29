import { runFileJob } from './file-job.js';

/** Stage L5b: decide whether an article repeats something already published.
 *
 *  A content hash only catches byte-identical bodies. Real reposts get a new intro, a different
 *  headline or light edits, so the hash differs and the same story ships twice. Whether two pieces
 *  carry the same story is a judgement about content, so the model makes it.
 *
 *  The comparison set is written to a file and read by a sub-agent: with a week of history the set is
 *  far larger than a prompt should carry, and the agent decides how much to read.
 */
/** Answer shape: only the articles judged to repeat something already published.
 *
 *  A keyed map is not expressible: the platform accepts `additionalProperties` only as a boolean.
 *  A list of entries carrying their own id is the portable form. */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['repeats'],
  properties: {
    repeats: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'match', 'reason'],
        properties: {
          id: { type: 'string' },
          match: { type: 'boolean' },
          of: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
};
export async function judgeRepeats({ ctx, cwd, dir, llm, selection, articles, known, signal, onUsage }) {
  if (!Array.isArray(articles) || !articles.length) return 0;

  // Only previously published entries can make today's piece a repeat.
  const prior = [];
  for (const [id, rec] of Object.entries(known ?? {})) {
    if (!Array.isArray(rec?.reported_on) || !rec.reported_on.length) continue;
    const summary = String(rec?.analysis?.summary_zh ?? '').trim();
    if (!summary) continue;
    prior.push({
      id,
      summary: summary.slice(0, 600),
      topics: Array.isArray(rec?.analysis?.topics) ? rec.analysis.topics.slice(0, 3) : [],
      reported_on: rec.reported_on,
    });
  }

  const today = articles
    .filter((a) => a?.analysis && !a.analysis.processing_error)
    .map((a) => ({
      id: a.id,
      title: String(a.title ?? '').slice(0, 200),
      account: String(a.account ?? '').slice(0, 60),
      topics: Array.isArray(a.analysis.topics) ? a.analysis.topics.slice(0, 3) : [],
      summary: String(a.analysis.summary_zh ?? '').slice(0, 800),
    }));
  if (!today.length || !prior.length) return 0;

  const instruction = [
    '判断今天的文章里，哪些与"已经发布过的文章"讲的是同一件事。',
    '',
    'input.repeats 是今天待判的文章；input.published 是此前已发布过的文章摘要。',
    '判据是"讲的是不是同一件事/同一个系统或发布"，不是措辞相似度。',
    '同一事件的转载、洗稿、换个标题重发都算重复。',
    '同一主题但讲不同系统、不同数据、不同结论的，不算重复。',
    '拿不准时判 false（宁可多推一篇，也不要漏掉新内容）。',
    '',
    '结论放进结构化返回值：repeats 是数组，每项含 id、match、of（重复的那篇 id）、reason。',
    '只写你判定为重复的条目；输入里今天的文章若都不重复，返回空数组。',
    '只写 match=true 的条目即可，未列出的一律视为不重复。',
  ].join('\n');

  let calls = 0;
  let answer = null;
  try {
    answer = await runFileJob({
      ctx,
      cwd,
      dir,
      name: 'repeats',
      input: { repeats: today, published: prior },
      instruction,
      schema: OUTPUT_SCHEMA,
      label: 'repeat-judge',
      signal,
    });
    calls += 1;
    onUsage?.(calls);
  } catch (error) {
    // Whether today's piece repeats an earlier story decides what ships. Swallowing this would let a
    // duplicate through unnoticed, so it propagates with the cause attached.
    throw new Error('REPEAT_JUDGE_FAILED: ' + String(error?.message ?? error).slice(0, 300));
  }

  const entries = Array.isArray(answer?.repeats) ? answer.repeats : null;
  if (!entries) throw new Error('REPEAT_JUDGE_FAILED: 结构化返回值里没有 repeats 数组');
  const byId = new Map(articles.map((a) => [a.id, a]));
  for (const entry of entries) {
    const article = byId.get(String(entry?.id ?? ''));
    // An id this run does not know is a broken answer, not something to ignore: it means the child
    // judged something other than what it was given.
    if (!article) {
      throw new Error(`REPEAT_JUDGE_FAILED: 返回了未知的文章 id（${String(entry?.id ?? '空').slice(0, 60)}）`);
    }
    if (entry.match === true) {
      article.repeated = true;
      article.repeat_of = String(entry.of ?? '').slice(0, 120);
      article.repeat_reason = String(entry.reason ?? '').slice(0, 200);
    } else {
      article.repeated = false;
    }
  }
  return calls;
}

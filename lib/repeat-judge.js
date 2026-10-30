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
 *  Positions identify the entries, not the ids: an id here is a 45-character string
 *  (`article:<base64>:<msgId>:<n>`) that the child would have to re-type exactly, and one run came
 *  back with a fabricated one carrying `reason: "placeholder"` because retyping that many long strings
 *  is what a model does when it loses the thread. An integer cannot drift, which is the same reason
 *  the screening and edition stages address their rows by index. */
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
        required: ['index', 'match', 'reason'],
        properties: {
          index: { type: 'integer' },
          match: { type: 'boolean' },
          of: { type: 'integer' },
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
      // Kept for mapping the answer back; it is not part of what the child is asked to re-type.
      id,
      index: prior.length,
      summary: summary.slice(0, 600),
      topics: Array.isArray(rec?.analysis?.topics) ? rec.analysis.topics.slice(0, 3) : [],
      reported_on: rec.reported_on,
    });
  }

  const today = articles
    .filter((a) => a?.analysis && !a.analysis.processing_error)
    .map((a) => ({
      index: 0,
      title: String(a.title ?? '').slice(0, 200),
      account: String(a.account ?? '').slice(0, 60),
      topics: Array.isArray(a.analysis.topics) ? a.analysis.topics.slice(0, 3) : [],
      summary: String(a.analysis.summary_zh ?? '').slice(0, 800),
    }));
  for (let i = 0; i < today.length; i += 1) today[i].index = i;
  if (!today.length || !prior.length) return 0;

  const instruction = [
    '判断今天的文章里，哪些与"已经发布过的文章"讲的是同一件事。',
    '',
    'input.repeats 是今天待判的文章，每项有 index、title、account、topics、summary。',
    'input.published 是此前已发布过的文章摘要，每项有 index、summary、topics、reported_on。',
    '判据是"讲的是不是同一件事/同一个系统或发布"，不是措辞相似度。',
    '同一事件的转载、洗稿、换个标题重发都算重复。',
    '同一主题但讲不同系统、不同数据、不同结论的，不算重复。',
    '拿不准时判 false（宁可多推一篇，也不要漏掉新内容）。',
    '',
    '结论放进结构化返回值：repeats 是数组，每项含 index、match、of、reason。',
    '- index：今天那篇文章的 index（整数，原样填 input.repeats 里的值）',
    '- of：它与哪一篇已发布文章重复，填 input.published 里的 index（整数）',
    '- reason：一句话说明为什么算同一件事',
    '只写你判定为重复的条目；输入里今天的文章若都不重复，返回空数组 []。',
    '同一篇今天文章不要出现两次。index 必须是输入里真实存在的整数，不要自己编造。',
  ].join('\n');

  let calls = 0;
  let answer = null;
  try {
    answer = await runFileJob({
      ctx,
      cwd,
      dir,
      name: 'repeats',
      // The child is sent only what it judges from plus the integers that address each row. The ids
      // stay here: showing them is what invited the copy that produced a fabricated one.
      input: {
        repeats: today,
        published: prior.map(({ id: _id, ...row }) => row),
      },
      instruction,
      schema: OUTPUT_SCHEMA,
      label: 'repeat-judge',
      signal,
      // Completeness and range are checked at the job boundary, so a broken answer reruns the turn
      // instead of failing an edition that already spent its whole analysis budget. Only a partial
      // answer earns the retry: one that returned nothing usable did not do the work and would repeat.
      validate: (structured) => {
        const list = Array.isArray(structured?.repeats) ? structured.repeats : null;
        if (!list) throw new Error('REPEAT_JUDGE_FAILED: 结构化返回值里没有 repeats 数组');
        const bad = [];
        const seen = new Set();
        for (const entry of list) {
          const index = entry?.index;
          if (!Number.isInteger(index) || index < 0 || index >= today.length) {
            bad.push(`index=${String(index)}（有效范围 0-${today.length - 1}）`);
            continue;
          }
          if (seen.has(index)) bad.push(`index=${index} 出现两次`);
          seen.add(index);
          const of = entry?.of;
          if (of !== undefined && (!Number.isInteger(of) || of < 0 || of >= prior.length)) {
            bad.push(`index=${index} 的 of=${String(of)}（有效范围 0-${prior.length - 1}）`);
          }
        }
        if (bad.length) {
          const error = new Error(
            `REPEAT_JUDGE_FAILED: ${bad.length} 条结论越界，共 ${list.length} 条（${bad.slice(0, 5).join('；')}）`,
          );
          // A single bad entry among otherwise valid ones may be a slip worth another pass; an answer
          // where nothing resolves means the turn never worked the task.
          if (bad.length < list.length || list.length === 0) error.answerRejected = true;
          throw error;
        }
      },
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
  // The child addresses rows positionally, so map position back to the article it was shown. Building
  // it from the same filter that produced `today` is what keeps the two in step.
  const byIndex = new Map();
  let cursor = 0;
  for (const article of articles) {
    if (!article?.analysis || article.analysis.processing_error) continue;
    byIndex.set(cursor, article);
    cursor += 1;
  }
  // `of` addresses the published list, whose ids are what the rest of the run refers to.
  const priorIds = prior.map((p) => p.id);
  for (const entry of entries) {
    const article = byIndex.get(Number(entry?.index));
    // Ranges were validated at the job boundary; reaching here with a gap means the mapping between
    // the rows sent and the rows held drifted, which is a code defect worth naming.
    if (!article) {
      throw new Error(`REPEAT_JUDGE_FAILED: index ${String(entry?.index)} 无法映射回文章（内部不一致）`);
    }
    if (entry.match === true) {
      article.repeated = true;
      article.repeat_of = priorIds[Number(entry.of)] ?? '';
      article.repeat_reason = String(entry.reason ?? '').slice(0, 200);
    } else {
      article.repeated = false;
    }
  }
  return calls;
}

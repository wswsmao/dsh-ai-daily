import { checkAbort } from './io.js';
import { runFileJob } from './file-job.js';

/** Stage L2: the model decides which listed candidates are worth opening.
 *
 *  The candidate list is written to a file and a sub-agent reads it, so the size of one keyword's
 *  result list no longer competes with a context window: the agent reads as much as it needs, in as
 *  many passes as it likes, and writes its verdicts to a file the caller reads back.
 *
 *  All content judgement lives in the model. This module shapes the input, states the rules and maps
 *  the answer back onto candidate keys.
 */
/** Answer shape the child must return.
 *
 *  A keyed map cannot be expressed here: the platform accepts `additionalProperties` only as a
 *  boolean, so declaring the per-key object shape under it is rejected outright. A list of entries
 *  that each carry their own key is the portable form, and the caller builds the map. */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'keep', 'reason', 'category', 'point'],
        properties: {
          key: { type: 'string' },
          keep: { type: 'boolean' },
          reason: { type: 'string' },
          category: { type: 'string' },
          point: { type: 'string' },
        },
      },
    },
  },
};
export async function prescreenCandidates({
  ctx,
  cwd,
  dir,
  name,
  policy,
  items,
  categories,
  signal,
  onUsage,
}) {
  if (!Array.isArray(items) || !items.length) return new Map();
  checkAbort(signal);

  const rows = items.map((it, n) => ({
    index: n,
    key: it.key,
    title: String(it.title ?? '').slice(0, 200),
    account: String(it.account ?? '').slice(0, 80),
    date: String(it.relative_date ?? it.date ?? '').slice(0, 40),
    snippet: String(it.snippet ?? '').slice(0, 400),
  }));

  const categoryLine = Object.entries(categories ?? {})
    .map(([k, d]) => `${k}（${d}）`)
    .join(' | ');
  const categoryKeys = Object.keys(categories ?? {});

  const instruction = [
    policy,
    '',
    `输入文件里是某个关键词在时间窗内的候选列表，每项有 index、key、title、account、date、snippet。`,
    `对每篇输出一条结论：keep（true/false）、reason（一句话）、category（只能是 ${categoryLine}）、point（一句话概括在讲哪件事）。`,
    '同一件事的多篇只让最值得读的那一篇 keep=true，其余 keep=false 并写明「同一事件，已被第 N 条覆盖」。',
    '拿不准时 keep=false。',
    '',
    '结论放进结构化返回值：verdicts 是一个数组，每项含 key、keep、reason、category、point。',
    'key 必须原样使用输入里的 key，每一条候选都要有一条结论，不要遗漏，也不要重复。',
  ].join('\n');

  let calls = 0;
  const answer = await runFileJob({
    ctx,
    cwd,
    dir,
    name,
    input: { candidates: rows },
    instruction,
    schema: OUTPUT_SCHEMA,
    label: `prescreen-${name}`,
    signal,
  });
  calls += 1;
  onUsage?.(null, calls);

  // The answer arrives as a list; index it by candidate key. A duplicate key would silently shadow an
  // earlier verdict, so it is reported rather than resolved by order.
  const entries = Array.isArray(answer?.verdicts) ? answer.verdicts : null;
  if (!entries) throw new Error('PRESCREEN_RESULT_INVALID: 结构化返回值里没有 verdicts 数组');
  const verdicts = new Map();
  for (const entry of entries) {
    const key = String(entry?.key ?? '');
    if (!key) throw new Error('PRESCREEN_RESULT_INVALID: 有条结论缺少 key');
    if (verdicts.has(key)) throw new Error(`PRESCREEN_RESULT_INVALID: 同一个 key 出现两次（${key.slice(0, 60)}）`);
    verdicts.set(key, entry);
  }
  const result = new Map();
  // Every candidate must come back judged. A missing verdict is a broken screening step, and letting
  // it through would silently promote an unread article into the pool, so it fails with the list of
  // what was skipped - that is what makes the failure reproducible.
  const missing = [];
  for (const row of rows) {
    const v = verdicts.get(row.key);
    if (!v) {
      missing.push({ index: row.index, key: row.key, title: row.title });
      continue;
    }
    if (!categoryKeys.includes(v.category)) {
      throw new Error(
        `MODEL_CATEGORY_INVALID: 初筛返回了未定义的分类 "${String(v.category)}"（${row.title}）。` +
          `有效分类：${categoryKeys.join(', ')}`,
      );
    }
    result.set(row.key, {
      keep: v.keep === true,
      reason: String(v.reason ?? '').slice(0, 300),
      category: v.category,
      point: String(v.point ?? '').slice(0, 300),
    });
  }
  if (missing.length) {
    const sample = missing
      .slice(0, 5)
      .map((m) => `#${m.index} ${String(m.title).slice(0, 40)}`)
      .join(' | ');
    throw new Error(
      `PRESCREEN_INCOMPLETE: ${missing.length}/${rows.length} 个候选没有初筛结论（${sample}）。` +
        `输出文件：${answer?.__outputFile ?? '见进度文件'}`,
    );
  }
  return result;
}


export async function loadPolicy(file) {
  const fs = await import('node:fs/promises');
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

export const candidateKey = (title, account) => `${String(title ?? '')}|${String(account ?? '')}`;

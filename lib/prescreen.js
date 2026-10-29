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
    `输出文件写成：{"verdicts":{"<key>":{"keep":true,"reason":"...","category":"${categoryKeys[0] ?? 'application'}","point":"..."}}}`,
    'key 必须原样使用输入里的 key。',
  ].join('\n');

  let calls = 0;
  const answer = await runFileJob({
    ctx,
    cwd,
    dir,
    name,
    input: { candidates: rows },
    instruction,
    label: `prescreen-${name}`,
    signal,
  });
  calls += 1;
  onUsage?.(null, calls);

  const verdicts = answer?.verdicts ?? {};
  const result = new Map();
  // Every candidate must come back judged. A missing verdict is a broken screening step, and letting
  // it through would silently promote an unread article into the pool, so it fails with the list of
  // what was skipped - that is what makes the failure reproducible.
  const missing = [];
  for (const row of rows) {
    const v = verdicts[row.key];
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

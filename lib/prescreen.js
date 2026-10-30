import { checkAbort, mapLimit } from './io.js';
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
 *  that each carry their own index is the portable form, and the caller builds the map.
 *
 *  The index identifies the candidate, not the title: a title may contain quotes or punctuation that
 *  a child re-types slightly differently, and one real run lost a candidate because `"主管"` came back
 *  with different quotation marks. An integer cannot drift. */
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
        required: ['index', 'keep', 'reason', 'category', 'point'],
        properties: {
          index: { type: 'integer' },
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

  // The policy file states every rule except the category list, which lives in project config so a
  // project can add a category without editing prose. Substituting it here keeps one source per fact:
  // a hardcoded list in the policy drifted from the configured set and told the child about three
  // categories while the answer schema allowed four.
  const policyText = String(policy ?? '').replace('{{CATEGORIES}}', categoryLine);

  // The policy file is the single source of truth for what to keep. Restating a tie-break here used to
  // contradict it - the policy says keep when unsure, this block said drop - and one child spotted the
  // conflict, followed the policy, and reported it instead of finishing. The instruction now only names
  // the answer shape and the mechanics the policy does not cover.
  const instruction = [
    policyText,
    '',
    `输入文件里是某个关键词在时间窗内的候选列表，每项有 index、key、title、account、date、snippet。`,
    `对每篇输出一条结论：keep、reason（一句话）、category（只能是 ${categoryLine}）、point（一句话概括在讲哪件事）。`,
    '同一件事的多篇只让最值得读的那一篇 keep=true，其余 keep=false，并写明「同一事件，已被第 N 条」，N 用那条的 index。',
    '',
    '结论放进结构化返回值：verdicts 是一个数组，每项含 index、keep、reason、category、point。',
    'index 用输入里那条候选的 index（整数，原样填），每一条候选都要有一条结论，不要遗漏，也不要重复。',
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
    // Completeness is checked before the answer is accepted, so an answer that quietly drops a
    // candidate makes the job rerun instead of failing the run after it has moved on.
    validate: (structured) => {
      const list = Array.isArray(structured?.verdicts) ? structured.verdicts : [];
      const seen = new Set(list.map((v) => v?.index));
      const missing = rows.filter((r) => !seen.has(r.index));
      if (missing.length) {
        const sample = missing.slice(0, 3).map((m) => `#${m.index} ${String(m.title).slice(0, 30)}`).join(' | ');
        throw new Error(`ANSWER_INCOMPLETE: ${missing.length}/${rows.length} 个候选没有结论（${sample}）`);
      }
    },
  });
  calls += 1;
  onUsage?.(null, calls);

  // The answer arrives as a list; match it back by candidate index. Titles were used before and a
  // child re-typed one with different quotation marks, which read as a missing verdict and failed the
  // whole query. An out-of-range or duplicated index is a broken answer, not something to skip.
  const entries = Array.isArray(answer?.verdicts) ? answer.verdicts : null;
  if (!entries) throw new Error('PRESCREEN_RESULT_INVALID: 结构化返回值里没有 verdicts 数组');
  const byIndex = rows.length ? new Map(rows.map((r) => [r.index, r])) : new Map();
  const verdicts = new Map();
  for (const entry of entries) {
    const index = entry?.index;
    if (!Number.isInteger(index) || !byIndex.has(index)) {
      throw new Error(`PRESCREEN_RESULT_INVALID: 结论里的 index 不在输入范围内（${String(index)}）`);
    }
    if (verdicts.has(index)) throw new Error(`PRESCREEN_RESULT_INVALID: 同一个 index 出现两次（${index}）`);
    verdicts.set(index, entry);
  }
  const result = new Map();
  // Every candidate must come back judged. A missing verdict is a broken screening step, and letting
  // it through would silently promote an unread article into the pool, so it fails with the list of
  // what was skipped - that is what makes the failure reproducible.
  const missing = [];
  for (const row of rows) {
    const v = verdicts.get(row.index);
    if (!v) {
      missing.push({ index: row.index, title: row.title });
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

/** Screen every keyword's candidates in as few passes as possible.
 *
 *  Screening one keyword at a time made each keyword blind to the others: the same article could be
 *  judged twice with different answers, and a story reported under several keywords only collapsed much
 *  later at selection. Handing one child the whole pool lets it see duplicates while it decides, which
 *  is a quality gain on top of cutting 59 child launches to one.
 *
 *  A very large pool is split instead of forced through one answer: the split is by candidate count so
 *  each child still sees a whole number of candidates, and pieces run concurrently because none of them
 *  touches the WeChat window.
 */
export const PRESCREEN_CHUNK = 150;

export async function prescreenAll({
  ctx,
  cwd,
  dir,
  entries,
  policy,
  categories,
  signal,
  onUsage,
  onProgress,
  chunkSize = PRESCREEN_CHUNK,
  concurrency = 3,
}) {
  // entries: [{ query, records }] - one entry per keyword, records already inside the window.
  // The same article commonly appears under several keywords, so the pool is keyed by article identity:
  // judging it once is the whole point of a single pool, and a duplicate key would otherwise be read as
  // the child answering twice.
  const flat = [];
  const seenKeys = new Set();
  for (const entry of entries) {
    for (const record of entry.records ?? []) {
      const key = candidateKey(record.title, record.account);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      flat.push({
        key,
        keyword: entry.query.keyword,
        title: record.title,
        account: record.account,
        relative_date: record.relative_date,
        snippet: record.snippet,
      });
    }
  }
  const keepByKeyword = new Map();
  for (const entry of entries) keepByKeyword.set(entry.query.id, []);
  // An empty pool still returns the same shape: the caller reads verdicts unconditionally, and a
  // partial object here would fail on the empty case rather than simply judging nothing.
  if (!flat.length) return { keepByKeyword, calls: 0, chunks: 0, verdicts: new Map() };

  const size = Math.max(20, Number(chunkSize) || PRESCREEN_CHUNK);
  const chunks = [];
  for (let i = 0; i < flat.length; i += size) chunks.push(flat.slice(i, i + size));

  let calls = 0;
  const verdicts = new Map();
  await mapLimit(chunks, Math.max(1, Math.min(4, Number(concurrency) || 3)), async (chunk, chunkIndex) => {
    checkAbort(signal);
    const rows = chunk.map((c, n) => ({
      index: n,
      key: c.key,
      keyword: c.keyword,
      title: String(c.title ?? '').slice(0, 200),
      account: String(c.account ?? '').slice(0, 80),
      date: String(c.relative_date ?? '').slice(0, 40),
      snippet: String(c.snippet ?? '').slice(0, 400),
    }));
    const categoryLine = Object.entries(categories ?? {})
      .map(([k, d]) => `${k}（${d}）`)
      .join(' | ');
    const policyText = String(policy ?? '').replace('{{CATEGORIES}}', categoryLine);
    // Every piece states that it holds one slice of a larger pool: the duplicate rule still applies
    // inside the slice, and an article repeated across slices is caught at selection, which sees all of
    // them. Saying so stops a child from rejecting a row merely because it looks unpaired.
    const instruction = [
      policyText,
      '',
      `输入文件里是候选列表（每项含 index、key、keyword、title、account、date、snippet）。`,
      chunks.length > 1 ? `这是整池 ${flat.length} 条中的第 ${chunkIndex + 1} 片（${rows.length} 条）。` : '',
      `对每篇输出一条结论：keep、reason（一句话）、category（只能是 ${categoryLine}）、point（一句话概括在讲哪件事）。`,
      '同一件事的多篇只让最值得读的那一篇 keep=true，其余 keep=false，并写明「同一事件，已被第 N 条」，N 用那条的 index。',
      '',
      '结论放进结构化返回值：verdicts 是一个数组，每项含 index、keep、reason、category、point。',
      'index 用输入里那条候选的 index（整数，原样填），每一条候选都要有一条结论，不要遗漏，也不要重复。',
    ]
      .filter((line) => line !== '')
      .join('\n');

    const answer = await runFileJob({
      ctx,
      cwd,
      dir,
      name: `prescreen-${chunkIndex + 1}of${chunks.length}`,
      input: { candidates: rows },
      instruction,
      schema: OUTPUT_SCHEMA,
      label: `prescreen-${chunkIndex + 1}of${chunks.length}`,
      signal,
      validate: (structured) => {
        const list = Array.isArray(structured?.verdicts) ? structured.verdicts : [];
        const seen = new Set(list.map((v) => v?.index));
        const missing = rows.filter((r) => !seen.has(r.index));
        if (missing.length) {
          const sample = missing.slice(0, 3).map((m) => `#${m.index} ${String(m.title).slice(0, 30)}`).join(' | ');
          throw new Error(`ANSWER_INCOMPLETE: 第 ${chunkIndex + 1} 片漏了 ${missing.length}/${rows.length} 条（${sample}）`);
        }
      },
    });
    calls += 1;
    const entriesOut = Array.isArray(answer?.verdicts) ? answer.verdicts : null;
    if (!entriesOut) throw new Error(`PRESCREEN_RESULT_INVALID: 第 ${chunkIndex + 1} 片没有 verdicts 数组`);
    const categoryKeys = Object.keys(categories ?? {});
    const byIndex = new Map(rows.map((r) => [r.index, r]));
    for (const v of entriesOut) {
      const row = byIndex.get(v?.index);
      if (!row) throw new Error(`PRESCREEN_RESULT_INVALID: 第 ${chunkIndex + 1} 片的 index 不在范围内（${String(v?.index)}）`);
      if (verdicts.has(row.key)) throw new Error(`PRESCREEN_RESULT_INVALID: 同一个候选被判断两次（${row.key.slice(0, 60)}）`);
      if (!categoryKeys.includes(v.category)) {
        throw new Error(
          `MODEL_CATEGORY_INVALID: 初筛返回了未定义的分类 "${String(v.category)}"（${row.title}）。` +
            `有效分类：${categoryKeys.join(', ')}`,
        );
      }
      verdicts.set(row.key, {
        keep: v.keep === true,
        reason: String(v.reason ?? '').slice(0, 300),
        category: v.category,
        point: String(v.point ?? '').slice(0, 300),
        keyword: row.keyword,
      });
    }
    onProgress?.({ chunk: chunkIndex + 1, of: chunks.length, judged: verdicts.size, total: flat.length });
  });
  onUsage?.(null, calls);

  // The pool was judged as a whole, so every candidate has a verdict. A gap here means the child
  // answered less than it was given; the per-chunk validator already rejects that, so reaching this
  // point with a hole is a code defect worth naming rather than papering over.
  const missing = flat.filter((c) => !verdicts.has(c.key));
  if (missing.length) {
    const sample = missing.slice(0, 5).map((m) => m.title.slice(0, 40)).join(' | ');
    throw new Error(`PRESCREEN_INCOMPLETE: ${missing.length}/${flat.length} 个候选没有结论（${sample}）`);
  }
  for (const entry of entries) {
    const list = keepByKeyword.get(entry.query.id);
    for (const record of entry.records ?? []) {
      const v = verdicts.get(candidateKey(record.title, record.account));
      if (v?.keep) list.push(candidateKey(record.title, record.account));
    }
  }
  return { keepByKeyword, calls, chunks: chunks.length, verdicts };
}

export const candidateKey = (title, account) => `${String(title ?? '')}|${String(account ?? '')}`;

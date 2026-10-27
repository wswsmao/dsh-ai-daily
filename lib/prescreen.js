import fs from 'node:fs/promises';
import { checkAbort, sleep } from './io.js';

/** Stage L2: pre-screen every candidate from one query in a SINGLE model call.
 *
 *  One call on purpose: the model must see the whole result list to apply the
 *  "same event -> keep only the best article" rule in config/prescreen-policy.md. Batched calls
 *  hide the other batches, so eight write-ups of the same release each look unique and all get
 *  opened. A 24h result list is small (tens of titles plus snippets), so one call is cheap.
 *
 *  All judgement lives in the model; this module only shapes the payload and maps the reply back.
 */
export async function prescreenCandidates({ llm, selection, policy, items, signal, onUsage, maxCalls = 120 }) {
  if (!Array.isArray(items) || !items.length) return new Map();
  checkAbort(signal);
  const result = new Map();
  if (maxCalls < 1) return result;

  const payload = items.map((it, n) => ({
    n,
    title: String(it.title ?? '').slice(0, 200),
    account: String(it.account ?? '').slice(0, 80),
    date: String(it.relative_date ?? it.date ?? '').slice(0, 40),
    snippet: String(it.snippet ?? '').slice(0, 400),
  }));

  const system = [
    policy,
    '',
    '现在给你**同一个关键词在最近24小时内的完整结果列表**，你能看到全部候选，因此必须应用上面的「同一件事只留最值得读的」规则：',
    '同一件事的多篇报道只让最值得读的那一篇 keep=true，其余 keep=false，并在 reason 中写明「同一事件，已被第N条覆盖」。',
    '',
    '只输出一个JSON对象：',
    '{"items":[{"n":0,"keep":true,"reason":"...","category":"application|model|hardware|none","point":"..."}]}',
    'items 数量必须与输入一致，n 必须原样返回。',
    'keep=true 必须同时满足：新、具体、系统/架构层、有信息增量。拿不准就 keep=false。',
  ].join('\n');

  let calls = 0;
  try {
    const data = await streamPrescreenJson(llm, selection, system, payload, signal);
    calls += 1;
    onUsage?.(null, calls);
    const rows = Array.isArray(data?.items) ? data.items : [];
    const byN = new Map(rows.filter((r) => Number.isInteger(r?.n)).map((r) => [r.n, r]));
    items.forEach((it, n) => {
      const row = byN.get(n);
      if (!row) {
        // A missing verdict is a gap in our own pipeline, not evidence the article is bad.
        result.set(it.key, { keep: true, reason: '模型未返回该条目，交由全文复核', category: 'none', point: '', prescreen_missing: true });
        return;
      }
      result.set(it.key, {
        keep: row.keep === true,
        reason: String(row.reason ?? '').slice(0, 300),
        category: ['application', 'model', 'hardware'].includes(row.category) ? row.category : 'none',
        point: String(row.point ?? '').slice(0, 300),
      });
    });
  } catch (e) {
    checkAbort(signal);
    // A failed call must not silently drop candidates: keep them for full-text review instead.
    for (const it of items) {
      result.set(it.key, { keep: true, reason: `初筛失败，交由全文复核：${String(e?.message ?? e).slice(0, 120)}`, category: 'none', point: '', prescreen_error: true });
    }
    await sleep(1500, signal);
  }
  return result;
}

async function streamPrescreenJson(llm, selection, system, payload, signal) {
  let text = '';
  for await (const c of llm.stream({ ...selection, maxTokens: 8000, messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(payload) }] }], system, tools: [], signal })) {
    if (c.type === 'text-delta') text += c.text;
  }
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('PRESCREEN_JSON_INVALID');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function loadPolicy(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return ''; }
}

export const candidateKey = (title, account) => `${String(title ?? '')}|${String(account ?? '')}`;

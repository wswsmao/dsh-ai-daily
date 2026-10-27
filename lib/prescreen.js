import fs from 'node:fs/promises';
import { sha256, checkAbort, sleep } from './io.js';

/** Stage L2: pre-screen wechat candidates using ONLY what the search result list shows
 *  (title / account / relative date / snippet), so we never pay to open an article that
 *  is obviously off-target. Judgement follows config/prescreen-policy.md. */
export async function prescreenCandidates({ llm, selection, policy, items, signal, onUsage, batchSize = 12, maxCalls = 120 }) {
  if (!Array.isArray(items) || !items.length) return new Map();
  checkAbort(signal);
  const groups = [];
  for (let i = 0; i < items.length; i += batchSize) groups.push(items.slice(i, i + batchSize));
  const result = new Map();
  let calls = 0;
  for (const group of groups) {
    checkAbort(signal);
    if (calls >= maxCalls) break;
    const payload = group.map((it, n) => ({
      n,
      title: String(it.title ?? '').slice(0, 200),
      account: String(it.account ?? '').slice(0, 80),
      date: String(it.relative_date ?? it.date ?? '').slice(0, 40),
      snippet: String(it.snippet ?? '').slice(0, 400),
    }));
    const system = `${policy}\n\n只输出一个JSON对象：{"items":[{"n":0,"keep":true,"reason":"...","category":"application|model|hardware|none","point":"..."}]}。items数量必须与输入一致。keep=true必须同时满足：新、具体、系统/架构层、有信息增量。拿不准就keep=false。`;
    try {
      const data = await streamPrescreenJson(llm, selection, system, payload, signal);
      calls += 1;
      onUsage?.(null, calls);
      const rows = Array.isArray(data?.items) ? data.items : [];
      const byN = new Map(rows.filter((r) => Number.isInteger(r?.n)).map((r) => [r.n, r]));
      group.forEach((it, n) => {
        const row = byN.get(n);
        if (!row) {
          // A missing verdict is a gap in our own pipeline, not evidence the article is bad.
          // Treat it like a failed batch: keep it for full-text review rather than silently drop.
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
      // A failed batch must not silently drop candidates: keep them for full-text review instead.
      for (const it of group) {
        result.set(it.key, { keep: true, reason: `初筛失败，交由全文复核：${String(e?.message ?? e).slice(0, 120)}`, category: 'none', point: '', prescreen_error: true });
      }
      await sleep(1500, signal);
    }
  }
  return result;
}

async function streamPrescreenJson(llm, selection, system, payload, signal) {
  let text = '';
  for await (const c of llm.stream({ ...selection, maxTokens: 4000, messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(payload) }] }], system, tools: [], signal })) {
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
export const stableHash = (value) => sha256(value);

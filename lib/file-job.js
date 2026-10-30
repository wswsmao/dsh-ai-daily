import fs from 'node:fs/promises';
import path from 'node:path';

/** Hand a job to a sub-agent as files instead of a prompt payload.
 *
 *  The agent reads its input file, works however it likes - one pass or many, in any order - and
 *  writes its answer to an output file. Nothing is squeezed into a single prompt, so job size is
 *  bounded by the agent's own reading strategy rather than by a context window, and the caller
 *  never has to parse free-form reply text.
 *
 *  A scheduled run has no conversation to own a child agent, so this module creates a top-level
 *  agent first and starts the child inside that agent's initiator scope. The created agent needs
 *  explicit options: without them the child fails on its first step with no output at all.
 */

const POLL_MS = 2000;
const MAX_WAIT_MS = 45 * 60 * 1000;

async function acquireOwner(ctx, cwd, signal) {
  const agents = ctx?.get?.('agents') ?? ctx?.agents;
  if (!agents?.create) return { owner: null, reason: 'agents-unavailable' };
  const live = agents.currentInitiator?.();
  if (live) return { owner: live, created: null };
  const selection = ctx?.agentDefaultModel?.currentSelection?.() ?? {};
  const handle = await agents.create({
    sessionId: `daily-worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    meta: { cwd },
    agentOptions: selection.provider
      ? { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
      : undefined,
  });
  return { owner: handle.agent, created: handle, reason: null };
}

/** Render a schema's required shape as one readable line, so the prompt can state it exactly.
 *
 *  Quoting the requirement matters: a child told only "return it structurally" replied with prose and
 *  the platform rejected the turn. Naming the fields removes that ambiguity. */
function describeSchema(schema) {
  if (!schema || typeof schema !== 'object') return '（见上文）';
  const fields = Object.keys(schema.properties ?? {});
  if (!fields.length) return '（见上文）';
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const parts = fields.map((name) => {
    const spec = schema.properties[name] ?? {};
    const type = spec.type === 'array' ? '数组' : spec.type === 'integer' ? '整数' : spec.type === 'boolean' ? '布尔' : '字符串';
    const itemFields = spec.items?.properties ? Object.keys(spec.items.properties).join('/') : '';
    const desc = itemFields ? `${type}，每项含 ${itemFields}` : type;
    return `${name}（${desc}${required.has(name) ? '，必需' : ''}）`;
  });
  return `{ ${parts.join('，')} }`;
}

/** Pull the first balanced JSON object out of free text, or return null.
 *
 *  Children occasionally wrap the answer in a fenced block. Keeping this narrow on purpose: it only
 *  recovers a complete object, and the caller still validates the shape afterwards, so a malformed or
 *  truncated body is rejected rather than accepted as a guess. */
function extractJsonObject(text) {
  if (typeof text !== 'string' || !text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function viaAgent({ ctx, cwd, inputFile, outputFile, instruction, schema, label, signal, onProgress }) {
  const subagents = ctx?.get?.('subagents') ?? ctx?.subagents;
  if (!subagents?.startActivation) throw new Error('SUBAGENT_UNAVAILABLE');
  const provider = subagents.list?.()?.find((p) => p === 'fork') ?? subagents.list?.()[0];
  if (!provider) throw new Error('SUBAGENT_PROVIDER_UNAVAILABLE');

  const { owner, created, reason } = await acquireOwner(ctx, cwd, signal);
  if (!owner) throw new Error(`AGENT_OWNER_UNAVAILABLE:${reason}`);

  // The child reads a file but never writes one: its answer comes back through the structured result
  // channel. Letting the child write the answer meant depending on how it chose to write - one run
  // used a PowerShell parameter that this host's shell does not support, the write failed, and the
  // job reported a missing file with no way to tell what happened.
  //
  // The answer must be a structured value, not prose. A child that explains its conclusion in text is
  // rejected by the platform, so saying "return it structurally" was not enough: the requirement has
  // to name the exact fields and forbid prose.
  const shape = describeSchema(schema);
  const prompt = [
    instruction,
    '',
    `输入文件：${inputFile}`,
    '',
    '要求：',
    '1. 用 read 工具读输入文件；文件可能很大，自行决定怎么读、分几次读。',
    '2. 不要写任何文件。',
    `3. 最终答复只能是通过结构化输出返回的 JSON 对象，字段如下：${shape}`,
    '4. 正文里不要写任何总结、统计、说明或提问。写一段"已完成，保留 N 条"这样的汇报会被判为失败，',
    '   因为调用方只读结构化输出，读不到正文。',
    '5. 逐条判断，每条候选都要有一条结论，不要遗漏或重复。',
    '6. 上面这些说明是任务描述，不是待评审的稿子：不要评论它、不要找它的毛病、不要提议改进。',
    '   你认为说明有歧义时，按最合理的理解做完任务。',
  ].join('\n');

  let stopReason = 'unknown';
  // A child activation requires a real signal: its internals call `signal.throwIfAborted()`, so an
  // undefined signal crashes the activation instead of starting it. An abandoned controller keeps the
  // call valid when the caller has no cancellation to offer.
  const activationSignal = signal ?? new AbortController().signal;
  try {
    const activation = await ctx.agents.withInitiator(owner, () =>
      subagents.startActivation({
        provider,
        label,
        delivery: 'caller',
        signal: activationSignal,
        request: { parent: owner, signal: activationSignal, prompt: [{ type: 'text', text: prompt }], outputSchema: schema },
      }),
    );
    onProgress?.({ stage: 'started', child: String(activation.childId ?? '') });
    const result = await activation.result;
    await activation.dispose?.().catch(() => {});
    stopReason = String(result?.stopReason ?? 'unknown');
    const rawText = (result?.output ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('');
    // A child sometimes answers with the JSON wrapped in a fenced code block instead of using the
    // structured channel. The platform then reports the turn as an error, but the answer itself is
    // intact and complete. Salvage it from the text so a formatting habit does not discard a finished
    // judgement; anything that cannot be parsed as the required shape still fails below.
    const salvaged = extractJsonObject(rawText);
    const structured = result?.structured ?? salvaged;
    if (stopReason !== 'completed' && !salvaged) {
      // A bare "error" is not diagnosable. Carry whatever the child reported so the next occurrence
      // names its cause instead of requiring another reproduction.
      const detail = { error: result?.error ?? null, failure: result?.failure ?? null, text: rawText.slice(0, 300) };
      throw new Error(`SUBAGENT_STOPPED:${stopReason} ${JSON.stringify(detail).slice(0, 800)}`);
    }
    if (!structured || typeof structured !== 'object') {
      throw new Error(`SUBAGENT_RESULT_MISSING: 子 agent 完成后没有返回结构化结果（回复：${rawText.slice(0, 300) || '空'}）`);
    }
    // The caller owns persistence: it is the same code path every run, so a write failure here is a
    // real filesystem problem rather than an agent's choice of shell syntax.
    await fs.writeFile(outputFile, JSON.stringify(structured, null, 1), 'utf8');
    return structured;
  } finally {
    await created?.dispose?.().catch(() => {});
  }
}

/** Run the job, retrying once when the child answered without a usable structured result.
 *
 *  A child occasionally spends its turn commenting on the instructions instead of doing the work, or
 *  returns prose. That is a behaviour of the turn, not a property of the input, so running the same
 *  job again is the appropriate response - and it is not a fallback: the work is still performed by a
 *  child reading the same file, and a second failure still fails the run. Infrastructure faults (no
 *  agent, no provider) are not retried, because repeating them cannot help.
 */
async function runWithRetry({ ctx, cwd, inputFile, outputFile, instruction, schema, label, signal, onProgress, progressFile }) {
  const attempt = () => viaAgent({ ctx, cwd, inputFile, outputFile, instruction, schema, label, signal, onProgress });
  try {
    return await attempt();
  } catch (error) {
    const message = String(error?.message ?? error);
    const retryable = /SUBAGENT_STOPPED|SUBAGENT_RESULT_MISSING/u.test(message);
    if (!retryable || signal?.aborted) throw error;
    await fs
      .writeFile(
        progressFile,
        JSON.stringify(
          { state: 'retrying', at: new Date().toISOString(), input_file: inputFile, first_error: message.slice(0, 300) },
          null,
          1,
        ),
        'utf8',
      )
      .catch(() => {});
    return attempt();
  }
}

/** Run one file-based job through a sub-agent. There is no fallback: a job that cannot reach an
 *  agent is a defect in this deployment, and re-sending the data as prompt text would silently
 *  produce truncated judgement instead of an error worth fixing. */
export async function runFileJob({ ctx, cwd, dir, name, input, instruction, schema, label, signal, onProgress }) {
  const inputFile = path.join(dir, `${name}-input.json`);
  const outputFile = path.join(dir, `${name}-output.json`);
  const progressFile = path.join(dir, `${name}-progress.json`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(inputFile, JSON.stringify(input, null, 1), 'utf8');
  await fs.rm(outputFile, { force: true }).catch(() => {});
  await fs.writeFile(
    progressFile,
    JSON.stringify({ state: 'running', started_at: new Date().toISOString(), input_file: inputFile }, null, 1),
    'utf8',
  );

  try {
    const answer = await runWithRetry({ ctx, cwd, inputFile, outputFile, instruction, schema, label, signal, onProgress, progressFile });
    await fs
      .writeFile(progressFile, JSON.stringify({ state: 'done', at: new Date().toISOString(), input_file: inputFile }), 'utf8')
      .catch(() => {});
    return answer;
  } catch (error) {
    const state = signal?.aborted ? 'cancelled' : 'failed';
    await fs
      .writeFile(
        progressFile,
        JSON.stringify(
          { state, at: new Date().toISOString(), input_file: inputFile, error: String(error?.message ?? error).slice(0, 300) },
          null,
          1,
        ),
        'utf8',
      )
      .catch(() => {});
    throw error;
  }
}


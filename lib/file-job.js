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
    `3. 你的最终答复必须是通过结构化输出返回的 JSON 对象，字段如下：${shape}`,
    '4. 不要在正文里解释结论：结论只放在结构化输出里，正文留空或只写"完成"。缺少必需字段会被判为失败。',
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
    if (stopReason !== 'completed') {
      // A bare "error" is not diagnosable. Carry whatever the child reported so the next occurrence
      // names its cause instead of requiring another reproduction.
      const detail = {
        error: result?.error ?? null,
        failure: result?.failure ?? null,
        text: (result?.output ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('')
          .slice(0, 300),
      };
      throw new Error(`SUBAGENT_STOPPED:${stopReason} ${JSON.stringify(detail).slice(0, 800)}`);
    }

    const structured = result?.structured;
    if (!structured || typeof structured !== 'object') {
      const text = (result?.output ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('')
        .slice(0, 300);
      throw new Error(`SUBAGENT_RESULT_MISSING: 子 agent 完成后没有返回结构化结果（回复：${text || '空'}）`);
    }
    // The caller owns persistence: it is the same code path every run, so a write failure here is a
    // real filesystem problem rather than an agent's choice of shell syntax.
    await fs.writeFile(outputFile, JSON.stringify(structured, null, 1), 'utf8');
    return structured;
  } finally {
    await created?.dispose?.().catch(() => {});
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
    const answer = await viaAgent({ ctx, cwd, inputFile, outputFile, instruction, schema, label, signal, onProgress });
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


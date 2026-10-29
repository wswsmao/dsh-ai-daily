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
  const prompt = [
    instruction,
    '',
    `输入文件：${inputFile}`,
    '',
    '要求：',
    '1. 用 read 工具读输入文件；文件可能很大，自行决定怎么读、分几次读。',
    '2. 按上面的要求逐条判断，把结论放进结构化返回值（final 结果的对象里），不要写文件。',
  ].join('\n');

  let stopReason = 'unknown';
  try {
    const activation = await ctx.agents.withInitiator(owner, () =>
      subagents.startActivation({
        provider,
        label,
        delivery: 'caller',
        signal,
        request: { parent: owner, signal, prompt: [{ type: 'text', text: prompt }], outputSchema: schema },
      }),
    );
    onProgress?.({ stage: 'started', child: String(activation.childId ?? '') });
    const result = await activation.result;
    await activation.dispose?.().catch(() => {});
    stopReason = String(result?.stopReason ?? 'unknown');
    if (stopReason !== 'completed') throw new Error(`SUBAGENT_STOPPED:${stopReason}`);

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


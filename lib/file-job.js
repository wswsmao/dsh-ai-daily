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

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolve the agent to own a child: the live initiator, or a top-level agent created for this run. */
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

async function viaAgent({ ctx, cwd, inputFile, outputFile, instruction, label, signal, onProgress }) {
  const subagents = ctx?.get?.('subagents') ?? ctx?.subagents;
  if (!subagents?.startActivation) throw new Error('SUBAGENT_UNAVAILABLE');
  const provider = subagents.list?.()?.find((p) => p === 'fork') ?? subagents.list?.()[0];
  if (!provider) throw new Error('SUBAGENT_PROVIDER_UNAVAILABLE');

  const { owner, created, reason } = await acquireOwner(ctx, cwd, signal);
  if (!owner) throw new Error(`AGENT_OWNER_UNAVAILABLE:${reason}`);

  const prompt = [
    instruction,
    '',
    `输入文件：${inputFile}`,
    `输出文件：${outputFile}`,
    '',
    '要求：',
    '1. 用 read 工具读输入文件；文件可能很大，自行决定怎么读、分几次读。',
    '2. 按上面的要求判断，把结论用 write 工具写到输出文件，JSON 格式。',
    '3. 写完后只回复"完成"两个字。',
  ].join('\n');

  try {
    const activation = await ctx.agents.withInitiator(owner, () =>
      subagents.startActivation({
        provider,
        label,
        delivery: 'caller',
        signal,
        request: { parent: owner, signal, prompt: [{ type: 'text', text: prompt }] },
      }),
    );
    onProgress?.({ stage: 'started', child: String(activation.childId ?? '') });
    const result = await activation.result;
    await activation.dispose?.().catch(() => {});
    if (result?.stopReason && result.stopReason !== 'completed') {
      throw new Error(`SUBAGENT_STOPPED:${result.stopReason}`);
    }
  } finally {
    await created?.dispose?.().catch(() => {});
  }

  const answer = await readJsonSafe(outputFile);
  if (!answer) throw new Error('AGENT_OUTPUT_MISSING');
  return answer;
}

/** Run one file-based job through a sub-agent. There is no fallback: a job that cannot reach an
 *  agent is a defect in this deployment, and re-sending the data as prompt text would silently
 *  produce truncated judgement instead of an error worth fixing. */
export async function runFileJob({ ctx, cwd, dir, name, input, instruction, label, signal, onProgress }) {
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
    const answer = await viaAgent({ ctx, cwd, inputFile, outputFile, instruction, label, signal, onProgress });
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


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

/** Read the answer file, telling "never written" apart from "written but unparsable".
 *
 *  The two mean different things: the first is an agent that stopped without answering, the second is
 *  an answer in the wrong shape. Collapsing them into one code hid which happened, so each gets its own
 *  message and the unparsable case quotes what was actually written. */
async function readAnswer(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`AGENT_OUTPUT_MISSING: 子 agent 结束时没有写出结果文件 ${file}`);
    }
    throw new Error(`AGENT_OUTPUT_UNREADABLE: 无法读取结果文件 ${file}：${String(error?.message ?? error).slice(0, 200)}`);
  }
  if (!raw.trim()) throw new Error(`AGENT_OUTPUT_EMPTY: 结果文件存在但内容为空 ${file}`);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `AGENT_OUTPUT_INVALID: 结果文件不是合法 JSON ${file}，前 200 字：${raw.slice(0, 200).replace(/\s+/gu, ' ')}`,
    );
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

  let stopReason = 'unknown';
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
    stopReason = String(result?.stopReason ?? 'unknown');
    if (stopReason !== 'completed') throw new Error(`SUBAGENT_STOPPED:${stopReason}`);
  } finally {
    await created?.dispose?.().catch(() => {});
  }

  try {
    return await readAnswer(outputFile);
  } catch (error) {
    // Name what the child reported alongside the file problem: "completed but no file" and "wrote a
    // broken file" need different fixes, and the stop reason is the only clue the caller has.
    throw new Error(`${error.message}（子 agent 结束状态：${stopReason}，输入文件：${inputFile}）`);
  }
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


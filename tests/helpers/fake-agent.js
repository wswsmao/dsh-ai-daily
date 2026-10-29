import fs from 'node:fs/promises';

/** Minimal Host stand-ins so a file job can run without a real sub-agent.
 *
 *  The child reads its input file and returns a structured object; it never writes a file, so the fake
 *  models exactly that contract: hand `respond` the parsed input, use its return value as the
 *  structured result.
 */
export function fakeAgentContext(respond) {
  const seen = { prompts: [], schema: null, wroteFiles: [] };
  const ctx = {
    subagents: {
      list: () => ['fork'],
      async startActivation(spec) {
        const prompt = spec.request.prompt.map((b) => b.text ?? '').join('');
        seen.prompts.push(prompt);
        seen.schema = spec.request.outputSchema ?? null;
        const inputFile = /输入文件：(.+)/u.exec(prompt)?.[1]?.trim();
        if (!inputFile) throw new Error('PROMPT_MISSING_INPUT_PATH');
        const input = JSON.parse(await fs.readFile(inputFile, 'utf8'));
        const structured = await respond(input, { inputFile, schema: seen.schema });
        return {
          childId: 'child-1',
          result: Promise.resolve({ stopReason: 'completed', structured, output: [] }),
          dispose: async () => {},
        };
      },
    },
    agents: {
      currentInitiator: () => ({ id: 'parent-1' }),
      withInitiator: (_agent, op) => op(),
      async create() {
        return { agent: { id: 'owner-1' }, dispose: async () => {} };
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
    get(name) {
      return this[name];
    },
  };
  return { ctx, seen };
}

/** A context that cannot reach the sub-agent service, used to assert the module fails loudly. */
export function brokenAgentContext() {
  return { get: () => undefined };
}

/** A child that completes without returning a structured answer, mirroring a child that never wrote. */
export function silentAgentContext() {
  return {
    subagents: {
      list: () => ['fork'],
      async startActivation() {
        return { childId: 'child-1', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} };
      },
    },
    agents: {
      currentInitiator: () => ({ id: 'parent-1' }),
      withInitiator: (_a, op) => op(),
      async create() {
        return { agent: { id: 'owner-1' }, dispose: async () => {} };
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
    get(name) {
      return this[name];
    },
  };
}

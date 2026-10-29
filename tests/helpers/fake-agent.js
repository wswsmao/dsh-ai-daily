import fs from 'node:fs/promises';

/** Minimal Host stand-ins so a file job can run without a real sub-agent.
 *
 *  `respond(inputFile, outputFile)` receives the paths the module chose; it decides what the child
 *  "writes". This keeps tests focused on the caller's contract - the input file exists and the
 *  output file is read back - rather than on prompt text.
 */
export function fakeAgentContext(respond) {
  const created = [];
  const ctx = {
    subagents: {
      list: () => ['fork'],
      async startActivation(spec) {
        const prompt = spec.request.prompt.map((b) => b.text ?? '').join('');
        const inputFile = /输入文件：(.+)/u.exec(prompt)?.[1]?.trim();
        const outputFile = /输出文件：(.+)/u.exec(prompt)?.[1]?.trim();
        if (!inputFile || !outputFile) throw new Error('PROMPT_MISSING_PATHS');
        const input = JSON.parse(await fs.readFile(inputFile, 'utf8'));
        const answer = await respond(input, { inputFile, outputFile });
        await fs.writeFile(outputFile, JSON.stringify(answer, null, 1), 'utf8');
        return { childId: 'child-1', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} };
      },
    },
    agents: {
      currentInitiator: () => ({ id: 'parent-1' }),
      withInitiator: (_agent, op) => op(),
      async create() {
        created.push('owner');
        return { agent: { id: 'owner-1' }, dispose: async () => {} };
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
    get(name) {
      return this[name];
    },
  };
  return { ctx, created };
}

/** A context that cannot reach the sub-agent service, used to assert the module fails loudly. */
export function brokenAgentContext() {
  return { get: () => undefined };
}

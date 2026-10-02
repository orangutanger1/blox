import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_TOOLS, isFileTool, runChatLoop, runFileTool, type ChatLoopResult, type ChatTool } from '../agent/chatLoop.js';

// A minimal, vendor-neutral coding agent: any OpenAI-compatible
// /chat/completions endpoint (OpenRouter, OpenAI, a local server) + blox's MCP
// server over stdio + four file tools. It exists so the bench can measure the
// environment with non-Claude models without going through Claude's harness.
// Everything it knows about Roblox/blox comes from the MCP server itself
// (instructions + tool schemas), the same surface every MCP client gets.
//
//   node dist/bench/openaiAgent.js --project <dir> --model <id> [--max-turns N] [--budget USD] <prompt>
//   env: OPENAI_BASE_URL (default https://openrouter.ai/api/v1), OPENAI_API_KEY or OPENROUTER_API_KEY
//   writes { turns, costUsd?, model, tokens, billing } to $BLOX_BENCH_STATS when set.

export { addUsage, FILE_TOOLS, runFileTool } from '../agent/chatLoop.js';

export function mcpToChatTools(tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[]): ChatTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? { type: 'object', properties: {} } },
  }));
}

const PREAMBLE = `You are an autonomous Roblox game developer. You work on a project on disk with
read_file / write_file / edit_file / list_files, and in a running Roblox Studio through
the blox tools. Work until the acceptance criteria pass or you run out of budget, then
finish with a short honest report of what works (with evidence) and what does not.
Batch related edits, then verify once.`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<void> {
  const project = resolve(flag(argv, 'project') ?? process.cwd());
  const model = flag(argv, 'model');
  if (!model) throw new Error('--model is required');
  const maxTurns = Number(flag(argv, 'max-turns') ?? 60);
  const budget = Number(flag(argv, 'budget') ?? 4);
  // A hung provider must not eat the whole bench timeout.
  const requestTimeoutMs = Number(process.env.BLOX_AGENT_REQUEST_TIMEOUT_SEC ?? 300) * 1000;
  const prompt = argv.at(-1) ?? '';
  const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('set OPENAI_API_KEY or OPENROUTER_API_KEY');

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
  const mcp = new Client({ name: 'blox-bench-openai-agent', version: '0.1.0' });
  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', '--project', project],
    env: { ...(process.env as Record<string, string>), BLOX_AGENT_NAME: `openai-agent:${model}` },
    stderr: 'ignore',
  }));
  // The bench kills agents that hit its timeout; take the MCP child down too.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => { void mcp.close().finally(() => process.exit(143)); });
  }
  const { tools: mcpTools } = await mcp.listTools();
  const writeStats = (r: Pick<ChatLoopResult, 'turns' | 'tokens' | 'costUsd'>) => {
    const f = process.env.BLOX_BENCH_STATS;
    if (f) writeFileSync(f, JSON.stringify({ turns: r.turns, model, tokens: r.tokens, billing: 'provider', ...(r.costUsd !== null ? { costUsd: r.costUsd } : {}) }));
  };
  let r: ChatLoopResult;
  try {
    r = await runChatLoop({
      baseUrl, apiKey, model, maxTurns, budgetUsd: budget, requestTimeoutMs,
      messages: [
        { role: 'system', content: `${PREAMBLE}\n\n${mcp.getInstructions() ?? ''}` },
        { role: 'user', content: prompt },
      ],
      tools: [...FILE_TOOLS, ...mcpToChatTools(mcpTools as never)],
      log: (t) => console.error(t),
      onTurn: (turn, names, u) => {
        console.error(`[turn ${turn}] ${names.join(', ') || 'final answer'}`);
        writeStats({ turns: turn, ...u });
      },
      async callTool(name, args) {
        if (isFileTool(name)) return { text: runFileTool(project, name, args) };
        const res = (await mcp.callTool({ name, arguments: args }, undefined, { timeout: 900_000 })) as {
          content?: { type: string; text?: string }[]; isError?: boolean;
        };
        const parts = (res.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `(${c.type} omitted)`));
        return { text: (res.isError ? 'ERROR: ' : '') + parts.join('\n') };
      },
    });
  } finally {
    await mcp.close().catch(() => {});
  }
  writeStats(r);
  if (r.error) console.error(`model API failed: ${r.error}`);
  console.log(r.final);
  console.log(`\nstop: ${r.stop}\nmodel: ${model}\nturns: ${r.turns}${r.costUsd !== null ? `  cost: $${r.costUsd.toFixed(4)}` : ''}`);
  const t = r.tokens;
  console.log(`tokens: input=${t.input} cache_read=${t.cacheRead} cache_write=${t.cacheWrite} output=${t.output}`);
  if (r.stop === 'error') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String((e as Error).stack ?? e));
    process.exit(1);
  });
}

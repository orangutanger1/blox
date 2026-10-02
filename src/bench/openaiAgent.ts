import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TokenUsage } from './harness.js';

// A minimal, vendor-neutral coding agent: any OpenAI-compatible
// /chat/completions endpoint (OpenRouter, OpenAI, a local server) + blox's MCP
// server over stdio + four file tools. It exists so the bench can measure the
// environment with non-Claude models without going through Claude's harness.
// Everything it knows about Roblox/blox comes from the MCP server itself
// (instructions + tool schemas), the same surface every MCP client gets.
//
//   node dist/bench/openaiAgent.js --project <dir> --model <id> [--max-turns N] [--budget USD] <prompt>
//   env: OPENAI_BASE_URL (default https://openrouter.ai/api/v1), OPENAI_API_KEY or OPENROUTER_API_KEY
//   writes { turns, costUsd?, model, tokens } to $BLOX_BENCH_STATS when set.

export interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

export function addUsage(t: TokenUsage, u: ChatUsage | undefined): TokenUsage {
  if (!u) return t;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const written = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    input: t.input + Math.max(0, (u.prompt_tokens ?? 0) - cached - written),
    cacheRead: t.cacheRead + cached,
    cacheWrite: t.cacheWrite + written,
    output: t.output + (u.completion_tokens ?? 0),
  };
}

export function mcpToChatTools(tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[]): ChatTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? { type: 'object', properties: {} } },
  }));
}

const str = (description: string) => ({ type: 'string', description });

export const FILE_TOOLS: ChatTool[] = [
  { type: 'function', function: { name: 'read_file', description: 'Read a project file (path relative to the project root).', parameters: { type: 'object', properties: { path: str('file path') }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a project file; parent dirs are created.', parameters: { type: 'object', properties: { path: str('file path'), content: str('full file content') }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace one exact, unique occurrence of old_text with new_text in a project file.', parameters: { type: 'object', properties: { path: str('file path'), old_text: str('text to find (must occur once)'), new_text: str('replacement') }, required: ['path', 'old_text', 'new_text'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List project files under a directory (recursive, dotfiles skipped).', parameters: { type: 'object', properties: { dir: str('directory, default "."') } } } },
];

function inside(root: string, p: string): string {
  const abs = resolve(root, p);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`path escapes the project: ${p}`);
  return abs;
}

export function runFileTool(root: string, name: string, a: Record<string, unknown>): string {
  const p = typeof a.path === 'string' ? a.path : '';
  if (name === 'read_file') return readFileSync(inside(root, p), 'utf8');
  if (name === 'write_file') {
    const f = inside(root, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, String(a.content ?? ''));
    return `wrote ${p}`;
  }
  if (name === 'edit_file') {
    const f = inside(root, p);
    const src = readFileSync(f, 'utf8');
    const old = String(a.old_text ?? '');
    const n = old ? src.split(old).length - 1 : 0;
    if (n !== 1) throw new Error(`old_text occurs ${n} times in ${p}; it must occur exactly once`);
    writeFileSync(f, src.replace(old, () => String(a.new_text ?? '')));
    return `edited ${p}`;
  }
  if (name === 'list_files') {
    const base = inside(root, typeof a.dir === 'string' ? a.dir : '.');
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        if (e.startsWith('.') || e === 'node_modules') continue;
        const f = join(d, e);
        if (statSync(f).isDirectory()) walk(f);
        else out.push(relative(root, f));
        if (out.length >= 500) return;
      }
    };
    if (existsSync(base)) walk(base);
    return out.join('\n') || '(empty)';
  }
  throw new Error(`unknown tool ${name}`);
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  [k: string]: unknown; // provider extras (e.g. reasoning_details) are echoed back as received
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
  const openRouter = baseUrl.includes('openrouter.ai');

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
  const tools = [...FILE_TOOLS, ...mcpToChatTools(mcpTools as never)];
  const messages: ChatMessage[] = [
    { role: 'system', content: `${PREAMBLE}\n\n${mcp.getInstructions() ?? ''}` },
    { role: 'user', content: prompt },
  ];

  let tokens: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let cost = 0;
  let costKnown = openRouter;
  let turns = 0;
  let final = '';
  let stop = 'max_turns';
  const writeStats = () => {
    const f = process.env.BLOX_BENCH_STATS;
    if (f) writeFileSync(f, JSON.stringify({ turns, model, tokens, ...(costKnown ? { costUsd: cost } : {}) }));
  };

  try {
    while (turns < maxTurns) {
      if (costKnown && cost >= budget) { stop = 'budget'; break; }
      turns++;
      let res: Response | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, tools, ...(openRouter ? { usage: { include: true } } : {}) }),
            signal: AbortSignal.timeout(requestTimeoutMs),
          });
        } catch (e) {
          if (attempt === 3) throw e;
          console.error(`[turn ${turns}] request failed (${(e as Error).name}); retrying`);
          continue;
        }
        if (res.status !== 429 && res.status < 500) break;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
      if (!res?.ok) throw new Error(`model API ${res?.status}: ${((await res?.text()) ?? "").slice(0, 500)}`);
      const body = (await res!.json()) as { choices?: { message: ChatMessage; finish_reason?: string }[]; usage?: ChatUsage; error?: { message?: string } };
      if (body.error || !body.choices?.length) throw new Error(`model API error: ${body.error?.message ?? 'no choices'}`);
      tokens = addUsage(tokens, body.usage);
      if (typeof body.usage?.cost === 'number') cost += body.usage.cost;
      else costKnown = false;
      writeStats();
      const msg = body.choices[0].message;
      console.error(`[turn ${turns}] ${msg.tool_calls?.map((c) => c.function.name).join(', ') || 'final answer'}`);
      messages.push({ ...msg, role: 'assistant', content: msg.content ?? '' });
      if (!msg.tool_calls?.length) { final = msg.content ?? ''; stop = 'done'; break; }
      for (const call of msg.tool_calls) {
        let text: string;
        try {
          const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
          if (FILE_TOOLS.some((t) => t.function.name === call.function.name)) {
            text = runFileTool(project, call.function.name, args);
          } else {
            const r = (await mcp.callTool({ name: call.function.name, arguments: args }, undefined, { timeout: 900_000 })) as {
              content?: { type: string; text?: string }[]; isError?: boolean;
            };
            const parts = (r.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `(${c.type} omitted)`));
            text = (r.isError ? 'ERROR: ' : '') + parts.join('\n');
          }
        } catch (e) {
          text = `ERROR: ${(e as Error).message}`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      }
    }
  } finally {
    writeStats();
    await mcp.close().catch(() => {});
  }
  console.log(final);
  console.log(`\nstop: ${stop}\nmodel: ${model}\nturns: ${turns}${costKnown ? `  cost: $${cost.toFixed(4)}` : ''}`);
  console.log(`tokens: input=${tokens.input} cache_read=${tokens.cacheRead} cache_write=${tokens.cacheWrite} output=${tokens.output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String((e as Error).stack ?? e));
    process.exit(1);
  });
}

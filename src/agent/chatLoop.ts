import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { TokenUsage } from './runAgent.js';
import { isWritableProjectPath } from './guardrail.js';

// A minimal, vendor-neutral agent loop over any OpenAI-compatible
// /chat/completions endpoint (OpenRouter, OpenAI, a local server). The caller
// supplies the tools and how to run them; this owns the request/retry/usage
// loop. Shared by the built-in runner (--runner openai) and the bench agent.

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

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | ContentPart[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  [k: string]: unknown; // provider extras (e.g. reasoning_details) are echoed back as received
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

const str = (description: string) => ({ type: 'string', description });

export const FILE_TOOLS: ChatTool[] = [
  { type: 'function', function: { name: 'read_file', description: 'Read a project file (path relative to the project root).', parameters: { type: 'object', properties: { path: str('file path') }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a project file; parent dirs are created.', parameters: { type: 'object', properties: { path: str('file path'), content: str('full file content') }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace one exact, unique occurrence of old_text with new_text in a project file.', parameters: { type: 'object', properties: { path: str('file path'), old_text: str('text to find (must occur once)'), new_text: str('replacement') }, required: ['path', 'old_text', 'new_text'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List project files under a directory (recursive, dotfiles skipped).', parameters: { type: 'object', properties: { dir: str('directory, default "."') } } } },
];

export const isFileTool = (name: string) => FILE_TOOLS.some((t) => t.function.name === name);

function inside(root: string, p: string): string {
  const abs = resolve(root, p);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`path escapes the project: ${p}`);
  return abs;
}

// The same containment + writable-file rules the Claude runner's guardrail hook
// enforces on Read/Write/Edit.
export function runFileTool(root: string, name: string, a: Record<string, unknown>): string {
  const p = typeof a.path === 'string' ? a.path : '';
  if (name === 'read_file') return readFileSync(inside(root, p), 'utf8');
  if (name === 'write_file' || name === 'edit_file') {
    const f = inside(root, p);
    if (!isWritableProjectPath(root, p)) {
      throw new Error(`writes are limited to project source files (.luau/.lua/.json/.txt/.md/.csv, not .blox/ or .git/); "${p}" is not one`);
    }
    if (name === 'write_file') {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, String(a.content ?? ''));
      return `wrote ${p}`;
    }
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

export interface ToolCallResult {
  text: string;
  // Shown to the model as a follow-up user message (tool messages are text-only
  // on most OpenAI-compatible endpoints).
  images?: { data: string; mimeType: string }[];
}

export interface ChatLoopOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[]; // system + first user message; appended to in place
  tools: ChatTool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
  maxTurns: number;
  budgetUsd: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  onTurn?: (turn: number, toolNames: string[], usage: { tokens: TokenUsage; costUsd: number | null }) => void;
  log?: (text: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type ChatStop = 'done' | 'max_turns' | 'budget' | 'aborted' | 'stopped' | 'error';

export interface ChatLoopResult {
  turns: number;
  tokens: TokenUsage;
  costUsd: number | null; // null when the endpoint does not report cost
  final: string;
  stop: ChatStop;
  error?: string; // set when stop is 'error' (the model API failed after retries)
}

// Thrown by a callTool that wants the run to end (e.g. a denied --ask gate).
export class StopRun extends Error {
  constructor(public readonly toolText: string) {
    super(toolText);
  }
}

// Never throws for model-API failures: they end the run with stop 'error' so
// callers keep the turns/tokens/cost spent so far.
export async function runChatLoop(o: ChatLoopOptions): Promise<ChatLoopResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const openRouter = o.baseUrl.includes('openrouter.ai');
  const url = `${o.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const timeoutMs = o.requestTimeoutMs ?? 300_000;
  let tokens: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let cost = 0;
  let costKnown = true;
  let turns = 0;
  let final = '';
  let stop: ChatStop = 'max_turns';
  let error: string | undefined;
  const result = (): ChatLoopResult => ({ turns, tokens, costUsd: costKnown ? cost : null, final, stop, ...(error ? { error } : {}) });

  try {
    while (turns < o.maxTurns) {
      if (o.signal?.aborted) { stop = 'aborted'; break; }
      if (costKnown && cost >= o.budgetUsd) { stop = 'budget'; break; }
      turns++;
      let res: Response | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          // A hung provider must not eat the whole run.
          const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
          res = await doFetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
            body: JSON.stringify({ model: o.model, messages: o.messages, tools: o.tools, ...(openRouter ? { usage: { include: true } } : {}) }),
            signal,
          });
        } catch (e) {
          if (o.signal?.aborted) { stop = 'aborted'; return result(); }
          if (attempt === 3) throw e;
          o.log?.(`[turn ${turns}] request failed (${(e as Error).name}); retrying`);
          continue;
        }
        if (res.status !== 429 && res.status < 500) break;
        o.log?.(`[turn ${turns}] model API ${res.status}; retrying`);
        await sleep(2000 * 2 ** attempt);
      }
      if (!res?.ok) throw new Error(`model API ${res?.status}: ${((await res?.text()) ?? '').slice(0, 500)}`);
      const body = (await res.json()) as { choices?: { message: ChatMessage }[]; usage?: ChatUsage; error?: { message?: string } };
      if (body.error || !body.choices?.length) throw new Error(`model API error: ${body.error?.message ?? 'no choices'}`);
      tokens = addUsage(tokens, body.usage);
      if (typeof body.usage?.cost === 'number') cost += body.usage.cost;
      else costKnown = false;
      const msg = body.choices[0].message;
      const calls = msg.tool_calls ?? [];
      o.onTurn?.(turns, calls.map((c) => c.function.name), { tokens, costUsd: costKnown ? cost : null });
      o.messages.push({ ...msg, role: 'assistant', content: msg.content ?? '' });
      if (!calls.length) {
        final = typeof msg.content === 'string' ? msg.content : '';
        stop = 'done';
        break;
      }
      const images: ContentPart[] = [];
      let stopAfter: string | null = null;
      for (const call of calls) {
        let text: string;
        if (stopAfter !== null) {
          text = 'skipped: the run is stopping';
        } else {
          try {
            const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
            const r = await o.callTool(call.function.name, args);
            text = r.text;
            for (const img of r.images ?? []) images.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
          } catch (e) {
            if (e instanceof StopRun) { stopAfter = e.toolText; text = e.toolText; }
            else text = `ERROR: ${(e as Error).message}`;
          }
        }
        o.messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      }
      if (stopAfter !== null) { final = stopAfter; stop = 'stopped'; break; }
      if (images.length) o.messages.push({ role: 'user', content: [{ type: 'text', text: 'Image(s) returned by the tool calls above:' }, ...images] });
    }
  } catch (e) {
    stop = 'error';
    error = (e as Error).message;
  }
  return result();
}

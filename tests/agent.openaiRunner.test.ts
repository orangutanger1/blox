import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveChatEndpoint, bloxChatTools, runOpenAiAgent } from '../src/agent/openaiRunner.js';
import { runChatLoop, type ChatMessage } from '../src/agent/chatLoop.js';
import { TOOLS, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { buildDigest } from '../src/context/digest.js';
import { readEvents } from '../src/state/store.js';
import { parseArgs } from '../src/args.js';
import { agentSpec } from '../src/bench/cli.js';
import { fakeStudio } from './fakeStudio.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'blox-oa-'));

function ccrFile(providers: unknown[]): string {
  const f = join(tmp(), 'config.json');
  writeFileSync(f, JSON.stringify({ Providers: providers }));
  return f;
}

type Reply = { content?: string; tool_calls?: { name: string; args: Record<string, unknown> }[]; cost?: number; status?: number };

// Scripted /chat/completions: one reply per request, records request bodies.
function fakeModel(replies: Reply[]) {
  const bodies: { model: string; messages: ChatMessage[]; tools: unknown[] }[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r.status && r.status !== 200) return new Response('boom', { status: r.status });
    const tool_calls = r.tool_calls?.map((c, k) => ({ id: `c${i}-${k}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: r.content ?? '', ...(tool_calls ? { tool_calls } : {}) } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: r.cost ?? 0.001 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

function ctxFor(mode: 'auto' | 'ask' = 'auto') {
  const projectPath = tmp();
  writeFileSync(join(projectPath, 'default.project.json'), JSON.stringify({ name: 'g', tree: { $className: 'DataModel' } }));
  const config = BloxConfigSchema.parse({ projectPath, model: 'openai/gpt-6-luna', runner: 'openai', mode, maxTurns: 10, maxBudgetUsd: 1 });
  const f = fakeStudio();
  const ctx: ToolCtx = {
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath, config, agent: 'test',
  };
  return { config, ctx, digest: buildDigest(projectPath), studio: f };
}

const env = { OPENROUTER_API_KEY: 'sk-test' } as NodeJS.ProcessEnv;

describe('resolveChatEndpoint', () => {
  it('uses a configured provider for "provider,slug"', () => {
    const f = ccrFile([{ name: 'openrouter', api_base_url: 'https://openrouter.ai/api/v1/chat/completions', api_key: 'k1', models: [] }]);
    expect(resolveChatEndpoint('openrouter,openai/gpt-6-luna', {}, f)).toEqual({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k1', model: 'openai/gpt-6-luna' });
    expect(() => resolveChatEndpoint('local,llama', {}, f)).toThrow(/not configured/);
  });
  it('plain slug: env key, then the stored openrouter key', () => {
    const f = ccrFile([{ name: 'openrouter', api_base_url: 'x', api_key: 'stored' }]);
    expect(resolveChatEndpoint('m', { OPENAI_API_KEY: 'e' }, f).apiKey).toBe('e');
    expect(resolveChatEndpoint('m', {}, f).apiKey).toBe('stored');
    // a custom base URL never receives the OpenRouter key
    expect(() => resolveChatEndpoint('m', { OPENAI_BASE_URL: 'http://localhost:1/v1' }, f)).toThrow(/no API key/);
  });
});

describe('bloxChatTools', () => {
  it('exposes every blox tool as a JSON-schema function', () => {
    const t = bloxChatTools();
    expect(t.map((x) => x.function.name)).toEqual(TOOLS.map((x) => x.name));
    expect(t.every((x) => x.function.parameters.type === 'object' && !('$schema' in x.function.parameters))).toBe(true);
  });
});

describe('runOpenAiAgent', () => {
  it('runs blox + file tools to a final answer and reports turns/cost', async () => {
    const { config, ctx, digest } = ctxFor();
    const m = fakeModel([
      { tool_calls: [{ name: 'status', args: {} }, { name: 'write_file', args: { path: 'src/a.server.luau', content: 'print(1)' } }] },
      { content: 'done: wrote a.server.luau' },
    ]);
    const events: string[] = [];
    const r = await runOpenAiAgent('make a script', config, ctx, digest, { env, fetchImpl: m.fetchImpl, sink: { emit: (e) => events.push(e.type) } });
    expect(r).toMatchObject({ status: 'success', stopReason: 'completed', numTurns: 2 });
    expect(r.costUsd).toBeCloseTo(0.002);
    expect(readFileSync(join(config.projectPath, 'src/a.server.luau'), 'utf8')).toBe('print(1)');
    expect(readEvents(config.projectPath).map((e) => e.tool)).toEqual(['status']);
    expect(events).toContain('status');
    const sys = m.bodies[0].messages[0].content as string;
    expect(sys).toMatch(/read_file\/write_file/);
    expect(sys).not.toMatch(/mcp__blox__/);
  });
  it('keeps writes out of .blox/ (same guardrail as the Claude runner)', async () => {
    const { config, ctx, digest } = ctxFor();
    const m = fakeModel([{ tool_calls: [{ name: 'write_file', args: { path: '.blox/task.json', content: '{}' } }] }, { content: 'ok' }]);
    await runOpenAiAgent('x', config, ctx, digest, { env, fetchImpl: m.fetchImpl });
    expect(existsSync(join(config.projectPath, '.blox/task.json'))).toBe(false);
    expect(JSON.stringify(m.bodies[1].messages.at(-1))).toMatch(/writes are limited/);
  });
  it('--ask without a dock stops at a gated asset call', async () => {
    const { config, ctx, digest, studio } = ctxFor('ask');
    const m = fakeModel([{ tool_calls: [{ name: 'studio_tool', args: { name: 'generate_mesh', args: { prompt: 'tree' } } }] }, { content: 'never' }]);
    const r = await runOpenAiAgent('x', config, ctx, digest, { env, fetchImpl: m.fetchImpl });
    expect(r).toMatchObject({ status: 'error', stopReason: 'gated', numTurns: 1 });
    expect(r.gatedActions[0].tool).toBe('generate_mesh');
    expect(studio.calls.some((c) => c.name === 'generate_mesh')).toBe(false);
  });
  it('--ask with a dock: allow runs the tool, deny tells the model to continue', async () => {
    const { config, ctx, digest } = ctxFor('ask');
    const m = fakeModel([{ tool_calls: [{ name: 'studio_tool', args: { name: 'generate_mesh', args: {} } }] }, { content: 'ok' }]);
    const gate = { isConnected: () => true, request: async () => ({ decision: 'deny' as const, source: 'dock' as const }) };
    const r = await runOpenAiAgent('x', config, ctx, digest, { env, fetchImpl: m.fetchImpl, gate });
    expect(r).toMatchObject({ status: 'success', deniedByUser: ['mcp__blox__studio_tool'] });
    expect(JSON.stringify(m.bodies[1].messages.at(-1))).toMatch(/denied by the user/);
  });
  it('stops at the budget using provider-reported cost', async () => {
    const { config, ctx, digest } = ctxFor();
    const m = fakeModel([{ tool_calls: [{ name: 'status', args: {} }], cost: 0.6 }]);
    const r = await runOpenAiAgent('x', config, ctx, digest, { env, fetchImpl: m.fetchImpl });
    expect(r).toMatchObject({ status: 'error', stopReason: 'budget', numTurns: 2 });
  });
});

describe('runChatLoop', () => {
  it('retries 5xx and returns API failures with the spend so far', async () => {
    const m = fakeModel([{ tool_calls: [{ name: 't', args: {} }] }, { status: 500 }, { status: 400 }]);
    const r = await runChatLoop({
      baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTurns: 5, budgetUsd: 1, fetchImpl: m.fetchImpl, sleep: async () => {},
      messages: [{ role: 'user', content: 'hi' }], tools: [], callTool: async () => ({ text: 'ok' }),
    });
    expect(r).toMatchObject({ stop: 'error', turns: 2 });
    expect(r.error).toMatch(/model API 400/);
    expect(r.tokens.output).toBe(10);
  });
});

describe('--runner wiring', () => {
  it('parses --runner and passes it through the bench blox profile', () => {
    expect(parseArgs(['--runner', 'openai', 'go']).runner).toBe('openai');
    expect(() => parseArgs(['--runner', 'gpt'])).toThrow(/claude or openai/);
    expect(agentSpec('blox', { runner: 'openai', model: 'openai/gpt-6-luna' }).argv).toEqual(expect.arrayContaining(['--runner', 'openai']));
  });
});

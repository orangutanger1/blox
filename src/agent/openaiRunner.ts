import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { BloxConfig } from '../config.js';
import type { ProjectDigest } from '../context/digest.js';
import type { EventSink } from '../panel/events.js';
import { ccrConfigPath } from '../ccr.js';
import { TOOLS, invokeTool, type ToolCtx } from '../tools/registry.js';
import { FILE_TOOLS, isFileTool, runChatLoop, runFileTool, StopRun, type ChatTool, type ContentPart } from './chatLoop.js';
import { buildBloxSystemPrompt } from './systemPrompt.js';
import { denyMessage, dockDenyMessage, isGatedCall, type GateChannel } from './permission.js';
import type { AgentRunResult, GatedAction, StopReason } from './runAgent.js';
import type { ImageInput } from './imageInput.js';
import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk';
import { latestChatSession, loadChatSession, newChatSessionId, saveChatSession, type ChatSession } from './chatSessions.js';
import type { ChatMessage } from './chatLoop.js';
import { buildAssetDedupeHook, buildAssetRecordHook, buildAssetResultHook, type ResultGateChannel } from './hooks.js';

// The built-in runner on any OpenAI-compatible endpoint (`--runner openai`).
// Same blox toolset, system prompt, path guardrails, --ask gates and budget as
// the Claude runner; only the agent loop differs (chatLoop.ts instead of the
// Agent SDK).

export interface ChatEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const OPENROUTER = 'https://openrouter.ai/api/v1';

interface CcrProvider { name?: unknown; api_base_url?: unknown; api_key?: unknown }

function ccrProviders(path: string): CcrProvider[] {
  if (!existsSync(path)) return [];
  try {
    const p = (JSON.parse(readFileSync(path, 'utf8')) as { Providers?: unknown }).Providers;
    return Array.isArray(p) ? (p as CcrProvider[]) : [];
  } catch {
    return [];
  }
}

// Where to send a model id:
//   "provider,slug"  a provider added with `blox model add` (its base URL + key)
//   "slug"           OPENAI_BASE_URL (default OpenRouter) with OPENAI_API_KEY /
//                    OPENROUTER_API_KEY, else the stored openrouter key
export function resolveChatEndpoint(model: string, env: NodeJS.ProcessEnv = process.env, ccrPath = ccrConfigPath()): ChatEndpoint {
  const providers = ccrProviders(ccrPath);
  const comma = model.indexOf(',');
  if (comma > 0) {
    const name = model.slice(0, comma);
    const p = providers.find((x) => x.name === name);
    if (!p || typeof p.api_base_url !== 'string') {
      throw new Error(`provider "${name}" is not configured; add it with \`blox model add ${name} <model> --key <k>\``);
    }
    return {
      baseUrl: p.api_base_url.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, ''),
      apiKey: typeof p.api_key === 'string' ? p.api_key : '',
      model: model.slice(comma + 1),
    };
  }
  const baseUrl = (env.OPENAI_BASE_URL ?? OPENROUTER).replace(/\/$/, '');
  const stored = providers.find((x) => x.name === 'openrouter')?.api_key;
  const apiKey = env.OPENAI_API_KEY ?? env.OPENROUTER_API_KEY ?? (baseUrl === OPENROUTER && typeof stored === 'string' ? stored : undefined);
  if (!apiKey) throw new Error('no API key for --runner openai: set OPENAI_API_KEY / OPENROUTER_API_KEY or run `blox model add openrouter <model> --key <k>`');
  return { baseUrl, apiKey, model };
}

export function bloxChatTools(): ChatTool[] {
  return TOOLS.map((t) => {
    const { $schema: _drop, ...parameters } = z.toJSONSchema(z.object(t.shape)) as Record<string, unknown>;
    return { type: 'function', function: { name: t.name, description: t.description, parameters } };
  });
}

export interface OpenAiRunOptions {
  image?: ImageInput;
  verify?: boolean;
  sink?: EventSink;
  gate?: GateChannel & Partial<ResultGateChannel>;
  abortController?: AbortController;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  // Continue a saved conversation (by id, or the project's latest).
  resume?: string;
  continueSession?: boolean;
  sessionsDir?: string;
}

function stopReason(stop: string): StopReason {
  return stop === 'done' ? 'completed' : stop === 'max_turns' ? 'maxTurns' : stop === 'budget' ? 'budget' : 'error';
}

export async function runOpenAiAgent(
  prompt: string,
  config: BloxConfig,
  ctx: ToolCtx,
  digest: ProjectDigest,
  o: OpenAiRunOptions = {},
): Promise<AgentRunResult> {
  const emit = (e: Parameters<EventSink['emit']>[0]) => {
    try { o.sink?.emit(e); } catch { /* degraded panel beats a dead run */ }
  };
  const log = (text: string) => emit({ type: 'log', text });
  const gatedActions: GatedAction[] = [];
  const deniedByUser: string[] = [];
  const base: AgentRunResult = {
    numTurns: 0, costUsd: 0, status: 'error', stopReason: 'error', detail: 'no result',
    sessionId: null, gatedActions, deniedByUser, nonGatedDenials: [],
  };

  let endpoint: ChatEndpoint;
  try {
    endpoint = resolveChatEndpoint(config.model, o.env ?? process.env);
  } catch (e) {
    return { ...base, detail: (e as Error).message };
  }
  // Images only go to the model when the run is visual (a reference image was
  // attached): a text-only model rejects image content outright.
  const vision = !!o.image || (o.env ?? process.env).BLOX_CHAT_IMAGES === '1';
  const first: ContentPart[] = [{ type: 'text', text: prompt }];
  if (o.image) first.push({ type: 'image_url', image_url: { url: `data:${o.image.mediaType};base64,${o.image.base64}` } });

  let prior: ChatSession | null = null;
  try {
    if (o.resume) prior = loadChatSession(o.resume, o.sessionsDir);
    else if (o.continueSession) prior = latestChatSession(config.projectPath, o.sessionsDir);
  } catch (e) {
    return { ...base, detail: (e as Error).message };
  }
  const sessionId = prior?.id ?? newChatSessionId();
  const messages: ChatMessage[] = [
    { role: 'system', content: buildBloxSystemPrompt(digest, { image: !!o.image, verify: o.verify, toolNames: 'plain' }) },
    ...(prior?.messages ?? []),
    { role: 'user', content: o.image ? first : prompt },
  ];
  const save = () => {
    try {
      saveChatSession({ id: sessionId, projectPath: config.projectPath, model: config.model, messages }, o.sessionsDir);
    } catch (e) {
      log(`could not save the session for --resume: ${(e as Error).message}`);
    }
  };

  const ask = config.mode === 'ask';
  let costWarned = false;
  // The Claude runner's asset hooks, called directly: dedupe hint before a
  // generation, then record it and park on the dock's approve/reject card.
  const resultGate: ResultGateChannel | undefined =
    o.gate?.requestResult ? { isConnected: () => o.gate!.isConnected(), requestResult: o.gate.requestResult.bind(o.gate) } : undefined;
  const preHooks = [buildAssetDedupeHook(config.projectPath)];
  const postHooks = [buildAssetRecordHook(config.projectPath), buildAssetResultHook(resultGate)];
  const runHooks = async (hooks: HookCallback[], input: Record<string, unknown>): Promise<string[]> => {
    const notes: string[] = [];
    for (const h of hooks) {
      try {
        const r = (await h(input as unknown as HookInput, undefined, { signal: new AbortController().signal })) as {
          decision?: string; reason?: string; hookSpecificOutput?: { additionalContext?: string };
        };
        if (r.decision === 'block' && r.reason) notes.push(r.reason);
        if (r.hookSpecificOutput?.additionalContext) notes.push(r.hookSpecificOutput.additionalContext);
      } catch {
        /* hooks are advisory here; never fail the tool call */
      }
    }
    return notes;
  };
  try {
    const r = await runChatLoop({
      ...endpoint,
      maxTurns: config.maxTurns,
      budgetUsd: config.maxBudgetUsd,
      signal: o.abortController?.signal,
      fetchImpl: o.fetchImpl,
      messages,
      tools: [...FILE_TOOLS, ...bloxChatTools()],
      log,
      onTurn(turn, names, u) {
        emit({ type: 'status', turns: turn });
        if (names.length) log(`→ ${names.join(', ')}`);
        if (u.costUsd === null && !costWarned) {
          costWarned = true;
          log('this endpoint does not report cost; only --max-turns bounds the run');
        }
      },
      async callTool(name, args) {
        if (isFileTool(name)) return { text: runFileTool(config.projectPath, name, args) };
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return { text: `ERROR: unknown tool ${name}` };
        const qualified = `mcp__blox__${name}`;
        const gated = ask ? isGatedCall(qualified, args) : null;
        if (gated) {
          let decided = false;
          if (o.gate?.isConnected()) {
            try {
              const d = await o.gate.request(qualified, args);
              if (d.decision === 'allow') decided = true;
              else if (d.source === 'dock') {
                deniedByUser.push(qualified);
                return { text: dockDenyMessage(gated) };
              }
            } catch {
              /* a broken channel must never stall the run — fall back to deny+stop */
            }
          }
          if (!decided) {
            gatedActions.push({ tool: gated, input: args });
            throw new StopRun(denyMessage(gated));
          }
        }
        const hookInput = { tool_name: qualified, tool_input: args };
        const before = name === 'studio_tool' ? await runHooks(preHooks, { ...hookInput, hook_event_name: 'PreToolUse' }) : [];
        const out = await invokeTool(tool, args, ctx);
        const after = name === 'studio_tool' && !out.isError
          ? await runHooks(postHooks, { ...hookInput, hook_event_name: 'PostToolUse', tool_response: { content: [{ type: 'text', text: out.text }] } })
          : [];
        const text = [...before, (out.isError ? 'ERROR: ' : '') + out.text, ...after].join('\n\n');
        if (out.images?.length && !vision) {
          return { text: `${text}\n(${out.images.length} image(s) not shown: this run is text-only${out.artifacts?.length ? `; saved: ${out.artifacts.join(', ')}` : ''})` };
        }
        return { text, images: out.images };
      },
    });
    save();
    const gatedStop = gatedActions.length > 0;
    const ok = r.stop === 'done' && !gatedStop;
    return {
      ...base,
      sessionId,
      numTurns: r.turns,
      costUsd: r.costUsd ?? 0,
      ...(r.costUsd === null ? { costUnknown: true } : {}),
      tokens: r.tokens,
      status: ok ? 'success' : 'error',
      stopReason: gatedStop ? 'gated' : stopReason(r.stop),
      detail: gatedStop ? 'gated' : r.stop === 'done' ? 'success' : r.error ? `model API: ${r.error}` : r.stop,
    };
  } catch (e) {
    save();
    return { ...base, sessionId, detail: (e as Error).message };
  }
}

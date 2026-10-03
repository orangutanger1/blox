import type { BloxConfig } from '../config.js';
import type { ProjectDigest } from '../context/digest.js';
import type { EventSink } from '../panel/events.js';
import type { ToolCtx } from '../tools/registry.js';
import { FILE_TOOLS, StopRun } from './chatLoop.js';
import { CodexAppServer, type Notification, type ServerRequest } from './codex/appServer.js';
import type { ResultGateChannel } from './hooks.js';
import type { ImageInput } from './imageInput.js';
import { bloxChatTools } from './openaiRunner.js';
import type { GateChannel } from './permission.js';
import type { AgentRunResult, GatedAction, StopReason, TokenUsage } from './runAgent.js';
import { buildBloxSystemPrompt } from './systemPrompt.js';
import { bloxToolCaller } from './toolCaller.js';

// `--runner codex`: the agent loop is Codex's, signed in with the user's
// ChatGPT subscription (`blox auth codex`), driven over `codex app-server`.
// Codex's own acting tools are disabled; the model sees only blox's file tools
// and toolset as dynamic tools, answered here through the same caller, gates
// and guardrails as the openai runner. Billing is the ChatGPT plan's.

export interface CodexRunOptions {
  image?: ImageInput;
  verify?: boolean;
  sink?: EventSink;
  gate?: GateChannel & Partial<ResultGateChannel>;
  abortController?: AbortController;
  env?: NodeJS.ProcessEnv;
  appServer?: CodexAppServer;
  // End the run when Codex sends nothing for this long outside a tool call.
  stallMs?: number;
}

// Thread items that are not Codex acting on its own. Any other item type
// (shell, file edits, MCP, web search, image generation, sub-agents, or one a
// later Codex adds) ends the run: every action must be a blox tool call.
const PASSIVE_ITEMS = new Set([
  'userMessage', 'agentMessage', 'reasoning', 'plan', 'hookPrompt', 'dynamicToolCall', 'functionCallOutput',
  'contextCompaction', 'enteredReviewMode', 'exitedReviewMode', 'sleep',
]);

// blox's Claude-flavoured default model means "use Codex's default".
export function codexModel(model: string): string | undefined {
  const m = model.replace(/^codex,/, '');
  return !m || /^claude|^(opus|sonnet|haiku|fable)\b/i.test(m) || m === 'codex' ? undefined : m;
}

export function codexEffort(e: BloxConfig['effort']): string | undefined {
  return e === 'max' ? 'xhigh' : e;
}

export function codexDynamicTools() {
  return [...FILE_TOOLS, ...bloxChatTools()].map((t) => ({
    type: 'function' as const,
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
  }));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function runCodexAgent(
  prompt: string,
  config: BloxConfig,
  ctx: ToolCtx,
  digest: ProjectDigest,
  o: CodexRunOptions = {},
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
  const server = o.appServer ?? new CodexAppServer({ cwd: config.projectPath, env: o.env });
  const owned = !o.appServer;
  const cleanups: (() => void)[] = [];
  try {
    const account = await server.account();
    if (!account) return { ...base, detail: 'Codex is not signed in to ChatGPT: run `blox auth codex`' };
    log(`codex: ChatGPT ${account.planType ?? ''} plan${account.email ? ` (${account.email})` : ''}`.replace('  ', ' '));

    const model = codexModel(config.model);
    const started = await server.request<{ thread?: { id?: string } }>('thread/start', {
      ...(model ? { model } : {}),
      cwd: config.projectPath,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      serviceName: 'blox',
      baseInstructions: buildBloxSystemPrompt(digest, { image: !!o.image, verify: o.verify, toolNames: 'plain' }),
      dynamicTools: codexDynamicTools(),
    });
    const threadId = started?.thread?.id;
    if (!threadId) return { ...base, detail: 'Codex did not start a thread' };

    let turnId: string | null = null;
    let toolCalls = 0;
    let tokens: TokenUsage | undefined;
    let settled = false;
    let interrupted = false;
    let lastProgress = Date.now();
    let outcome: { stop: StopReason; detail: string } = { stop: 'error', detail: 'no result' };
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const interrupt = () => {
      if (interrupted || !turnId) return;
      interrupted = true;
      void server.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    };
    const settle = (stop: StopReason, detail: string, stopTurn = false) => {
      if (settled) return;
      settled = true;
      outcome = { stop, detail };
      if (stopTurn) interrupt();
      resolveDone();
    };

    const callTool = bloxToolCaller({ config, ctx, gate: o.gate, vision: true, gatedActions, deniedByUser });
    cleanups.push(server.onClose((e) => settle('error', e.message)));
    cleanups.push(server.subscribe((n: Notification) => {
      if (n.params.threadId !== threadId || settled) return;
      lastProgress = Date.now();
      const item = n.params.item;
      if (n.method === 'item/started' && isObj(item) && typeof item.type === 'string' && !PASSIVE_ITEMS.has(item.type)) {
        settle('error', `Codex tried its built-in "${item.type}" tool; blox runs allow only blox tools — run stopped`, true);
      } else if (n.method === 'thread/tokenUsage/updated' && isObj(n.params.tokenUsage) && isObj(n.params.tokenUsage.total)) {
        const t = n.params.tokenUsage.total as Record<string, number>;
        tokens = { input: (t.inputTokens ?? 0) - (t.cachedInputTokens ?? 0), output: t.outputTokens ?? 0, cacheRead: t.cachedInputTokens ?? 0, cacheWrite: t.cacheWriteInputTokens ?? 0 };
      } else if (n.method === 'item/completed' && isObj(item) && item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
        log(item.text.trim().slice(0, 2000));
      } else if (n.method === 'turn/completed') {
        const turn = isObj(n.params.turn) ? n.params.turn : {};
        const status = typeof turn.status === 'string' ? turn.status : 'failed';
        const err = isObj(turn.error) && typeof turn.error.message === 'string' ? turn.error.message : undefined;
        if (status === 'completed') settle('completed', 'success');
        else if (status === 'interrupted') settle('error', 'interrupted');
        else settle(/usage limit|rate limit/i.test(err ?? '') ? 'usage-limit' : 'error', err ? `codex: ${err}` : 'Codex turn failed');
      } else if (n.method === 'error' && n.params.willRetry !== true) {
        const err = isObj(n.params.error) && typeof n.params.error.message === 'string' ? n.params.error.message : 'Codex error';
        settle(/usage limit|rate limit/i.test(err) ? 'usage-limit' : 'error', `codex: ${err}`, true);
      }
    }));
    cleanups.push(server.handleRequests(async (r: ServerRequest) => {
      if (r.params.threadId !== threadId) return undefined;
      const fail = (text: string) => ({ success: false, contentItems: [{ type: 'inputText', text }] });
      if (r.method !== 'item/tool/call') return undefined; // approvals etc.: refused by the server default
      if (settled) return fail('run already ended');
      const name = String(r.params.tool ?? '');
      const args = isObj(r.params.arguments) ? r.params.arguments : {};
      if (++toolCalls > config.maxTurns) {
        settle('maxTurns', `stopped after ${config.maxTurns} tool calls (maxTurns)`, true);
        return fail('tool call limit reached; the run is ending');
      }
      emit({ type: 'status', turns: toolCalls });
      log(`→ ${name}`);
      try {
        const out = await callTool(name, args);
        lastProgress = Date.now();
        return {
          success: !out.text.startsWith('ERROR'),
          contentItems: [
            { type: 'inputText', text: out.text },
            ...(out.images ?? []).map((i) => ({ type: 'inputImage', imageUrl: `data:${i.mimeType};base64,${i.data}` })),
          ],
        };
      } catch (e) {
        if (e instanceof StopRun) {
          settle('gated', 'gated', true);
          return fail(e.message);
        }
        return fail(`ERROR: ${(e as Error).message}`);
      }
    }));
    const onAbort = () => settle('error', 'cancelled', true);
    o.abortController?.signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => o.abortController?.signal.removeEventListener('abort', onAbort));
    const stallMs = o.stallMs ?? 10 * 60_000;
    const watchdog = setInterval(() => {
      if (Date.now() - lastProgress > stallMs) settle('idle-timeout', `Codex sent nothing for ${Math.round(stallMs / 1000)}s`, true);
    }, Math.min(5_000, stallMs));
    cleanups.push(() => clearInterval(watchdog));

    const input: unknown[] = [{ type: 'text', text: prompt, text_elements: [] }];
    if (o.image) input.push({ type: 'image', url: `data:${o.image.mediaType};base64,${o.image.base64}` });
    const effort = codexEffort(config.effort);
    const turn = await server.request<{ turn?: { id?: string } }>('turn/start', {
      threadId,
      input,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      cwd: config.projectPath,
    });
    turnId = turn?.turn?.id ?? null;
    if (!turnId) settle('error', 'Codex did not start the turn');
    else if (settled) interrupt();
    await done;
    const ok = outcome.stop === 'completed' && gatedActions.length === 0;
    return {
      ...base,
      numTurns: toolCalls,
      costUsd: 0,
      ...(tokens ? { tokens } : {}),
      status: ok ? 'success' : 'error',
      stopReason: gatedActions.length ? 'gated' : outcome.stop,
      detail: outcome.detail,
    };
  } catch (e) {
    return { ...base, detail: (e as Error).message };
  } finally {
    for (const c of cleanups) c();
    if (owned) server.close();
  }
}

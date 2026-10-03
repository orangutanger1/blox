import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { BloxConfig } from '../config.js';
import { TOOLS, invokeTool, type ToolCtx } from '../tools/registry.js';
import { isFileTool, runFileTool, StopRun } from './chatLoop.js';
import { denyMessage, dockDenyMessage, isGatedCall, type GateChannel } from './permission.js';
import { buildAssetDedupeHook, buildAssetRecordHook, buildAssetResultHook, type ResultGateChannel } from './hooks.js';
import type { GatedAction } from './runAgent.js';

// One tool call from a non-SDK runner (openai, codex): file tools with path
// guardrails, the blox toolset, --ask gates (dock approval, else deny + stop
// the run via StopRun) and the Claude runner's asset hooks called directly.

export interface ToolCallerOptions {
  config: BloxConfig;
  ctx: ToolCtx;
  gate?: GateChannel & Partial<ResultGateChannel>;
  // Pass tool images to the model; otherwise they are saved and described.
  vision: boolean;
  gatedActions: GatedAction[];
  deniedByUser: string[];
}

export type ToolCallResult = { text: string; images?: { data: string; mimeType: string }[] };

export function bloxToolCaller(o: ToolCallerOptions): (name: string, args: Record<string, unknown>) => Promise<ToolCallResult> {
  const { config, ctx, gate } = o;
  const ask = config.mode === 'ask';
  // Dedupe hint before a generation, then record it and park on the dock's
  // approve/reject card.
  const resultGate: ResultGateChannel | undefined =
    gate?.requestResult ? { isConnected: () => gate.isConnected(), requestResult: gate.requestResult.bind(gate) } : undefined;
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
  return async (name, args) => {
    if (isFileTool(name)) return { text: runFileTool(config.projectPath, name, args) };
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { text: `ERROR: unknown tool ${name}` };
    const qualified = `mcp__blox__${name}`;
    const gated = ask ? isGatedCall(qualified, args) : null;
    if (gated) {
      let decided = false;
      if (gate?.isConnected()) {
        try {
          const d = await gate.request(qualified, args);
          if (d.decision === 'allow') decided = true;
          else if (d.source === 'dock') {
            o.deniedByUser.push(qualified);
            return { text: dockDenyMessage(gated) };
          }
        } catch {
          /* a broken channel must never stall the run — fall back to deny+stop */
        }
      }
      if (!decided) {
        o.gatedActions.push({ tool: gated, input: args });
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
    if (out.images?.length && !o.vision) {
      return { text: `${text}\n(${out.images.length} image(s) not shown: this run is text-only${out.artifacts?.length ? `; saved: ${out.artifacts.join(', ')}` : ''})` };
    }
    return { text, images: out.images };
  };
}

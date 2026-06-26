import type { BloxConfig } from '../config.js';
import type { StudioBridge, McpServerConfig } from '../bridge/types.js';
import type { ProjectDigest } from '../context/digest.js';
import type { HookCallbackMatcher, HookEvent, CanUseTool, EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { buildSystemPrompt } from './systemPrompt.js';
import { buildSyncHook, buildAssetResultHook, buildAssetDedupeHook, buildAssetRecordHook, EXECUTE_LUAU_TOOL, GEN_MESH_TOOL, WAIT_JOB_TOOL } from './hooks.js';
import type { ResultGateChannel } from './hooks.js';
import { buildCanUseTool, nonGatedAllowedTools, type GateChannel } from './permission.js';
import { buildGuardrailHook } from './guardrail.js';

// The dock panel's combined channel: P1 pre-call gates + P2 result gates.
export type PanelGateChannel = GateChannel & ResultGateChannel;

// Run-level context that shapes the system prompt (P3). Not persisted config.
export interface PromptContext {
  image?: boolean;
  verify?: boolean;
  // Resume a prior SDK session by id, or continue the project's most recent
  // session. Mutually exclusive (the CLI enforces this); if both are somehow
  // set, resume wins. Forwarded to the SDK's native Options.resume/continue.
  resume?: string;
  continueSession?: boolean;
}

export interface QueryOptionsLike {
  model: string;
  cwd: string;
  systemPrompt: string;
  maxTurns: number;
  // Native SDK option: the query stops with an error_max_budget_usd result
  // once this USD cap is exceeded.
  maxBudgetUsd: number;
  permissionMode: 'bypassPermissions' | 'default';
  // Present only in --auto; required by the SDK whenever permissionMode is
  // 'bypassPermissions'.
  allowDangerouslySkipPermissions?: true;
  // Present only in --ask; consulted because gated tools are kept out of allowedTools.
  canUseTool?: CanUseTool;
  // Reasoning effort; omitted when unset so the SDK default ('high') applies.
  effort?: EffortLevel;
  settingSources: never[];
  // Omitted for CCR-routed models: the openrouter transformer maps adaptive
  // thinking to reasoning-disabled, which 400s any model that mandates reasoning
  // (e.g. gemini-2.5-pro). Native Claude keeps it.
  thinking?: { type: 'adaptive' };
  // Native SDK session continuation. resume loads a specific session id;
  // continue picks the project's most recent. Omitted for a fresh run.
  resume?: string;
  continue?: boolean;
  allowedTools: string[];
  mcpServers: Record<string, McpServerConfig>;
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  // Set per-run by runAgent (not here) to forward CLI stderr — used to surface
  // rate-limit/retry notices to the dock instead of a silent stall.
  stderr?: (data: string) => void;
}

const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Grep', 'Glob'];

// Turn cap for CCR-routed (non-Claude) runs. They tend to loop past completion
// instead of emitting a clean stop, so cap them tighter than native Claude.
// WARNING: low values truncate genuinely multi-step builds (a run that needs >N
// turns ends as error_max_turns). Raise via BLOX_ROUTED_MAX_TURNS.
function routedMaxTurns(): number {
  const raw = Number(process.env.BLOX_ROUTED_MAX_TURNS);
  return Number.isInteger(raw) && raw > 0 ? raw : 12;
}

export function buildQueryOptions(
  config: BloxConfig,
  bridge: StudioBridge,
  digest: ProjectDigest,
  gate?: PanelGateChannel,
  promptCtx: PromptContext = {},
): QueryOptionsLike {
  const allTools = [...FILE_TOOLS, ...bridge.allowedTools()];
  const ask = config.mode === 'ask';
  // A CCR-routed model is "provider,slug" (has a comma); native Claude isn't.
  const routed = config.model.includes(',');
  return {
    model: config.model,
    cwd: config.projectPath,
    systemPrompt: buildSystemPrompt(digest, { image: promptCtx.image, verify: promptCtx.verify }),
    maxTurns: routed ? Math.min(config.maxTurns, routedMaxTurns()) : config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    permissionMode: ask ? 'default' : 'bypassPermissions',
    ...(ask
      ? { canUseTool: buildCanUseTool(gate) }
      : { allowDangerouslySkipPermissions: true as const }),
    ...(config.effort ? { effort: config.effort } : {}),
    settingSources: [],
    ...(promptCtx.resume
      ? { resume: promptCtx.resume }
      : promptCtx.continueSession
        ? { continue: true }
        : {}),
    ...(routed ? {} : { thinking: { type: 'adaptive' as const } }),
    allowedTools: ask ? nonGatedAllowedTools(allTools) : allTools,
    mcpServers: bridge.mcpServers(),
    hooks: {
      PreToolUse: [
        { hooks: [buildGuardrailHook(config.projectPath)] },
        { matcher: EXECUTE_LUAU_TOOL, hooks: [buildSyncHook(config.projectPath)] },
        // Advisory prompt-hash dedupe before a (slow) mesh generation.
        { matcher: GEN_MESH_TOOL, hooks: [buildAssetDedupeHook(config.projectPath)] },
      ],
      PostToolUse: [
        // Record prompt→tag so the dedupe hook can hit on a repeat. Runs in all
        // modes; independent of the ask-mode result gate below.
        { matcher: GEN_MESH_TOOL, hooks: [buildAssetRecordHook(config.projectPath)] },
        ...(ask && gate
          ? [
              { matcher: GEN_MESH_TOOL, hooks: [buildAssetResultHook(gate)] },
              { matcher: WAIT_JOB_TOOL, hooks: [buildAssetResultHook(gate)] },
            ]
          : []),
      ],
    },
  };
}

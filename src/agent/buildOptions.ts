import type { BloxConfig } from '../config.js';
import type { StudioBridge, McpServerConfig } from '../bridge/types.js';
import type { ProjectDigest } from '../context/digest.js';
import type { HookCallbackMatcher, HookEvent, CanUseTool, EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { buildSystemPrompt } from './systemPrompt.js';
import { buildSyncHook, buildAssetResultHook, EXECUTE_LUAU_TOOL, GEN_MESH_TOOL, WAIT_JOB_TOOL } from './hooks.js';
import type { ResultGateChannel } from './hooks.js';
import { buildCanUseTool, nonGatedAllowedTools, type GateChannel } from './permission.js';

// The dock panel's combined channel: P1 pre-call gates + P2 result gates.
export type PanelGateChannel = GateChannel & ResultGateChannel;

// Run-level context that shapes the system prompt (P3). Not persisted config.
export interface PromptContext {
  image?: boolean;
  verify?: boolean;
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
  thinking: { type: 'adaptive' };
  allowedTools: string[];
  mcpServers: Record<string, McpServerConfig>;
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}

const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Grep', 'Glob'];

export function buildQueryOptions(
  config: BloxConfig,
  bridge: StudioBridge,
  digest: ProjectDigest,
  gate?: PanelGateChannel,
  promptCtx: PromptContext = {},
): QueryOptionsLike {
  const allTools = [...FILE_TOOLS, ...bridge.allowedTools()];
  const ask = config.mode === 'ask';
  return {
    model: config.model,
    cwd: config.projectPath,
    systemPrompt: buildSystemPrompt(digest, { image: promptCtx.image, verify: promptCtx.verify }),
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    permissionMode: ask ? 'default' : 'bypassPermissions',
    ...(ask
      ? { canUseTool: buildCanUseTool(gate) }
      : { allowDangerouslySkipPermissions: true as const }),
    ...(config.effort ? { effort: config.effort } : {}),
    settingSources: [],
    thinking: { type: 'adaptive' },
    allowedTools: ask ? nonGatedAllowedTools(allTools) : allTools,
    mcpServers: bridge.mcpServers(),
    hooks: {
      PreToolUse: [
        { matcher: EXECUTE_LUAU_TOOL, hooks: [buildSyncHook(config.projectPath)] },
      ],
      ...(ask && gate
        ? {
            PostToolUse: [
              { matcher: GEN_MESH_TOOL, hooks: [buildAssetResultHook(gate)] },
              { matcher: WAIT_JOB_TOOL, hooks: [buildAssetResultHook(gate)] },
            ],
          }
        : {}),
    },
  };
}

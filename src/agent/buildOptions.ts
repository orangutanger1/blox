import type { BloxConfig } from '../config.js';
import type { StudioBridge, McpServerConfig } from '../bridge/types.js';
import type { ProjectDigest } from '../context/digest.js';
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import { buildSystemPrompt } from './systemPrompt.js';
import { buildSyncHook, EXECUTE_LUAU_TOOL } from './hooks.js';

export interface QueryOptionsLike {
  model: string;
  cwd: string;
  systemPrompt: string;
  maxTurns: number;
  // Native SDK option: the query stops with an error_max_budget_usd result
  // once this USD cap is exceeded.
  maxBudgetUsd: number;
  permissionMode: 'bypassPermissions';
  // Required by the Agent SDK whenever permissionMode is 'bypassPermissions'.
  allowDangerouslySkipPermissions: true;
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
): QueryOptionsLike {
  return {
    model: config.model,
    cwd: config.projectPath,
    systemPrompt: buildSystemPrompt(digest),
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    thinking: { type: 'adaptive' },
    allowedTools: [...FILE_TOOLS, ...bridge.allowedTools()],
    mcpServers: bridge.mcpServers(),
    hooks: {
      PreToolUse: [
        { matcher: EXECUTE_LUAU_TOOL, hooks: [buildSyncHook(config.projectPath)] },
      ],
    },
  };
}

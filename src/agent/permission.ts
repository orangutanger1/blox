import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

// Unqualified names of the tools gated in --ask mode (master design §6 stop-to-ask):
// asset generation (spends Roblox credits, irreversible) + play-mode/input-sim
// (side-effectful, slow). Policy lives here, not on the bridge — the bridge is
// transport; gating is an autonomy concern.
export const GATED_TOOLS = [
  'generate_mesh',
  'generate_material',
  'generate_procedural_model',
  'insert_from_creator_store',
  'start_stop_play',
  'character_navigation',
  'user_keyboard_input',
  'user_mouse_input',
] as const;

// True when `toolName` is gated, accepting the bare name ('generate_mesh') or any
// MCP-qualified form ('mcp__<server>__generate_mesh') — gating the action is correct
// regardless of which server exposes it. Tool names contain only single underscores,
// so the '__' separator before the bare name is unambiguous.
export function isGated(toolName: string): boolean {
  return GATED_TOOLS.some((g) => toolName === g || toolName.endsWith(`__${g}`));
}

// Drop gated tools from an allow-list. allowedTools auto-approves (bypassing
// canUseTool), so gated tools must be excluded to route through the callback;
// they stay advertised by the MCP server and remain callable by the model.
export function nonGatedAllowedTools(tools: string[]): string[] {
  return tools.filter((t) => !isGated(t));
}

export function denyMessage(toolName: string): string {
  return `Action "${toolName}" requires approval and is blocked in --ask mode. Do not retry it. Briefly explain what you intended to do with it and why, then stop.`;
}

// Permission callback for --ask: allow everything except gated tools, which are
// denied with feedback so the agent self-explains and stops. Denials surface in
// the result's permission_denials[] for the report.
export function buildCanUseTool(): CanUseTool {
  return async (toolName) => {
    if (isGated(toolName)) {
      return { behavior: 'deny', message: denyMessage(toolName) };
    }
    return { behavior: 'allow' };
  };
}

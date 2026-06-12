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

export function dockDenyMessage(toolName: string): string {
  return `Action "${toolName}" was denied by the user from the Studio panel. Do not retry it. Continue with the rest of the task without it.`;
}

// How the permission callback reaches the panel's gate broker without
// depending on the server: connectivity check + an awaitable decision.
export interface GateChannel {
  isConnected(): boolean;
  request(
    tool: string,
    input: Record<string, unknown>,
  ): Promise<{ decision: 'allow' | 'deny'; source: 'dock' | 'timeout' }>;
}

// Permission callback for --ask. Without a connected dock this is exactly the
// pre-panel behavior: deny with feedback so the agent self-explains and stops.
// With a connected dock the call PAUSES on the gate broker; Allow lets the run
// continue, an explicit user Deny tells the agent to skip the action and keep
// going, and a timeout falls back to the deny+stop path (spec §5, §7).
//
// Allow results MUST carry updatedInput: the CLI's response schema requires it
// (sdk.d.ts marks it optional, but a bare {behavior:'allow'} fails validation
// CLI-side and comes back as "Tool permission request failed").
export function buildCanUseTool(gate?: GateChannel): CanUseTool {
  return async (toolName, input) => {
    const allow = { behavior: 'allow' as const, updatedInput: (input ?? {}) as Record<string, unknown> };
    if (!isGated(toolName)) return allow;
    if (gate?.isConnected()) {
      try {
        const d = await gate.request(toolName, allow.updatedInput);
        if (d.decision === 'allow') return allow;
        if (d.source === 'dock') return { behavior: 'deny', message: dockDenyMessage(toolName) };
      } catch {
        // A broken channel must never stall the run — fall back to deny+stop.
      }
    }
    return { behavior: 'deny', message: denyMessage(toolName) };
  };
}

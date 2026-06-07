import type { HookCallback, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { syncProject, realSpawn, type SpawnFn } from '../sync/rojo.js';

export const EXECUTE_LUAU_TOOL = 'mcp__Roblox_Studio__execute_luau';

// PreToolUse gate: push .luau files to Studio via Rojo before the agent runs
// Luau tests, so execute_luau always sees current files. blox owns sync; the
// agent owns when/what to test.
export function buildSyncHook(projectPath: string, spawn: SpawnFn = realSpawn): HookCallback {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    if (input.tool_name !== EXECUTE_LUAU_TOOL) return { continue: true };

    const res = await syncProject(projectPath, spawn);
    if (res.ok) return { continue: true };

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `Rojo sync failed before running tests: ${res.detail}. Files may be stale in Studio.`,
      },
    };
  };
}

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { StudioBridge, McpServerConfig } from './types.js';

// Returns successive entries; repeats the last once exhausted.
// Lets a dev/gated run script a fix loop (e.g. fail -> fail -> pass).
export function sequenceResponder(results: string[]): () => string {
  let i = 0;
  return () => {
    const v = results[Math.min(i, results.length - 1)] ?? '';
    i++;
    return v;
  };
}

export interface MockBridgeOptions {
  /** Successive execute_luau outputs; the last repeats. */
  luauResults?: string[];
  /** Successive get_console_output values; the last repeats. */
  consoleResults?: string[];
}

// Deterministic start_stop_play echo for the mock bridge.
export function playResult(isStart: boolean): string {
  return isStart ? '[mock] Game Started' : '[mock] Game Stopped';
}

// In-process fake Studio bridge for tests/dev without a live Studio.
export function createMockStudioBridge(opts: MockBridgeOptions = {}): StudioBridge {
  const nextLuau = sequenceResponder(opts.luauResults ?? ['[mock] ok: tests passed']);
  const nextConsole = sequenceResponder(opts.consoleResults ?? ['[mock] (console) ok']);
  const server = createSdkMcpServer({
    name: 'Roblox_Studio',
    version: '0.0.0',
    tools: [
      tool('search_game_tree', 'Return the (fake) DataModel tree', { query: z.string().optional() },
        async () => ({ content: [{ type: 'text' as const, text: '[mock] Workspace, ReplicatedStorage, ServerScriptService' }] })),
      tool('inspect_instance', 'Return (fake) instance details', { path: z.string() },
        async ({ path }) => ({ content: [{ type: 'text' as const, text: `[mock] instance ${path}: {}` }] })),
      tool('script_read', 'Return (fake) script source', { path: z.string() },
        async ({ path }) => ({ content: [{ type: 'text' as const, text: `[mock] source of ${path}` }] })),
      tool('script_search', 'Return (fake) script search results', { query: z.string() },
        async ({ query }) => ({ content: [{ type: 'text' as const, text: `[mock] scripts matching ${query}` }] })),
      tool('script_grep', 'Return (fake) grep results across scripts', { pattern: z.string() },
        async ({ pattern }) => ({ content: [{ type: 'text' as const, text: `[mock] grep ${pattern}` }] })),
      tool('execute_luau', 'Run (fake) Luau and return canned output', { code: z.string() },
        // code is intentionally ignored; the mock returns the next scripted result.
        async (_args) => ({ content: [{ type: 'text' as const, text: nextLuau() }] })),
      tool('start_stop_play', 'Start or stop a (fake) play session', { is_start: z.boolean() },
        async ({ is_start }) => ({ content: [{ type: 'text' as const, text: playResult(is_start) }] })),
      tool('get_console_output', 'Return (fake) Studio console output', {},
        async () => ({ content: [{ type: 'text' as const, text: nextConsole() }] })),
      tool('character_navigation', 'Navigate the (fake) character to a position or instance',
        {
          instance_path: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          z: z.number().optional(),
          speed_multiplier: z.number().optional(),
        },
        async () => ({ content: [{ type: 'text' as const, text: '[mock] navigated' }] })),
      tool('user_keyboard_input', 'Send (fake) keyboard actions',
        {
          actions: z.array(z.object({
            action: z.string(),
            key_code: z.string().optional(),
            instance_path: z.string().optional(),
            text_inputs: z.string().optional(),
            wait_time_ms: z.number().optional(),
          })),
        },
        async () => ({ content: [{ type: 'text' as const, text: '[mock] Success' }] })),
      tool('user_mouse_input', 'Send (fake) mouse actions',
        {
          actions: z.array(z.object({
            action: z.string(),
            x: z.number().optional(),
            y: z.number().optional(),
            instance_path: z.string().optional(),
            mouse_button: z.string().optional(),
            wait_time_ms: z.number().optional(),
          })),
        },
        async () => ({ content: [{ type: 'text' as const, text: '[mock] Success' }] })),
      tool('generate_mesh', 'Return a (fake) generated mesh id', { prompt: z.string() },
        async ({ prompt }) => ({ content: [{ type: 'text' as const, text: `[mock] mesh for: ${prompt}` }] })),
      tool('generate_material', 'Return a (fake) generated material id', { prompt: z.string() },
        async ({ prompt }) => ({ content: [{ type: 'text' as const, text: `[mock] material for: ${prompt}` }] })),
      tool('generate_procedural_model', 'Return a (fake) procedural model', { prompt: z.string() },
        async ({ prompt }) => ({ content: [{ type: 'text' as const, text: `[mock] model for: ${prompt}` }] })),
      tool('insert_from_creator_store', 'Insert a (fake) creator-store asset', { assetId: z.string() },
        async ({ assetId }) => ({ content: [{ type: 'text' as const, text: `[mock] inserted ${assetId}` }] })),
    ],
  });
  return {
    mcpServers: (): Record<string, McpServerConfig> => ({
      Roblox_Studio: server as unknown as McpServerConfig,
    }),
    allowedTools: () =>
      [
        'search_game_tree', 'inspect_instance',
        'script_read', 'script_search', 'script_grep', 'execute_luau',
        'start_stop_play', 'get_console_output',
        'character_navigation', 'user_keyboard_input', 'user_mouse_input',
        'generate_mesh', 'generate_material', 'generate_procedural_model', 'insert_from_creator_store',
      ].map((t) => `mcp__Roblox_Studio__${t}`),
  };
}

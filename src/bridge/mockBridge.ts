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
}

// In-process fake Studio bridge for tests/dev without a live Studio.
export function createMockStudioBridge(opts: MockBridgeOptions = {}): StudioBridge {
  const nextLuau = sequenceResponder(opts.luauResults ?? ['[mock] ok: tests passed']);
  const server = createSdkMcpServer({
    name: 'Roblox_Studio',
    version: '0.0.0',
    tools: [
      tool('search_game_tree', 'Return the (fake) DataModel tree', { query: z.string().optional() },
        async () => ({ content: [{ type: 'text' as const, text: '[mock] Workspace, ReplicatedStorage, ServerScriptService' }] })),
      tool('inspect_instance', 'Return (fake) instance details', { path: z.string() },
        async ({ path }) => ({ content: [{ type: 'text' as const, text: `[mock] instance ${path}: {}` }] })),
      tool('execute_luau', 'Run (fake) Luau and return canned output', { code: z.string() },
        // code is intentionally ignored; the mock returns the next scripted result.
        async (_args) => ({ content: [{ type: 'text' as const, text: nextLuau() }] })),
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
        'search_game_tree', 'inspect_instance', 'execute_luau',
        'generate_mesh', 'generate_material', 'generate_procedural_model', 'insert_from_creator_store',
      ].map((t) => `mcp__Roblox_Studio__${t}`),
  };
}

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

// 1x1 transparent PNG — a deterministic stand-in for a captured frame.
const MOCK_CAPTURE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Deterministic screen_capture result: an image content block, like the real tool.
// (The Agent SDK forwards image content blocks to the model as vision input.)
export function captureResult(): { type: 'image'; data: string; mimeType: string } {
  return { type: 'image' as const, data: MOCK_CAPTURE_PNG, mimeType: 'image/png' };
}

// Deterministic search_creator_store result: mirrors the real {searchId, objectTypes}
// JSON text shape so the mocked search->insert chain is honest.
export function creatorSearchResult(query: string): string {
  return JSON.stringify({ searchId: `mock-search-${query}`, objectTypes: ['mock-asset'] });
}

// Deterministic wait_job_finished result for the mock bridge.
export function jobFinishedResult(generationId: string): string {
  return `[mock] Generation ${generationId} finished.`;
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
      tool('execute_luau', 'Run (fake) Luau and return canned output',
        { code: z.string(), datamodel_type: z.enum(['Edit', 'Client', 'Server']) },
        // code is intentionally ignored; the mock returns the next scripted result.
        async (_args) => ({ content: [{ type: 'text' as const, text: nextLuau() }] })),
      tool('start_stop_play', 'Start or stop a (fake) play session', { is_start: z.boolean() },
        async ({ is_start }) => ({ content: [{ type: 'text' as const, text: playResult(is_start) }] })),
      tool('get_console_output', 'Return (fake) Studio console output', {},
        async () => ({ content: [{ type: 'text' as const, text: nextConsole() }] })),
      tool('character_navigation', 'Navigate the (fake) character to a position or instance',
        {
          datamodel_type: z.enum(['Client']),
          instance_path: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          z: z.number().optional(),
          speed_multiplier: z.number().optional(),
        },
        async () => ({ content: [{ type: 'text' as const, text: '[mock] navigated' }] })),
      tool('user_keyboard_input', 'Send (fake) keyboard actions',
        {
          datamodel_type: z.enum(['Client']),
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
          datamodel_type: z.enum(['Client']),
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
      tool('screen_capture', 'Return a (fake) captured viewport frame',
        {
          capture_id: z.string(),
          camera_position: z.array(z.number()).optional(),
          look_at_position: z.array(z.number()).optional(),
        },
        async () => ({ content: [captureResult()] })),
      tool('generate_mesh', 'Return a (fake) generated mesh id',
        {
          textPrompt: z.string(),
          size: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
          maxTriangles: z.number().optional(),
        },
        async ({ textPrompt }) => ({ content: [{ type: 'text' as const, text: `[mock] mesh for: ${textPrompt}` }] })),
      tool('generate_material', 'Return a (fake) generated material id',
        {
          materialPattern: z.enum(['Regular', 'Organic']),
          materialId: z.string(),
          baseMaterial: z.string(),
          materialDescription: z.string(),
        },
        async ({ materialDescription }) => ({ content: [{ type: 'text' as const, text: `[mock] material for: ${materialDescription}` }] })),
      tool('generate_procedural_model', 'Return a (fake) procedural model',
        { prompt: z.string(), attachedImageUri: z.string().optional() },
        async ({ prompt }) => ({ content: [{ type: 'text' as const, text: `[mock] model for: ${prompt}` }] })),
      tool('insert_from_creator_store', 'Insert a (fake) creator-store asset',
        { searchId: z.string(), objectTypes: z.array(z.string()).optional(), assetName: z.string().optional() },
        async ({ searchId }) => ({ content: [{ type: 'text' as const, text: `[mock] inserted from search ${searchId}` }] })),
      tool('wait_job_finished', 'Wait for a (fake) generation job to finish',
        { generationId: z.string(), timeout: z.number().optional() },
        async ({ generationId }) => ({ content: [{ type: 'text' as const, text: jobFinishedResult(generationId) }] })),
      tool('search_creator_store', 'Return (fake) creator-store search results', { query: z.string() },
        async ({ query }) => ({ content: [{ type: 'text' as const, text: creatorSearchResult(query) }] })),
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
        'screen_capture',
        'generate_mesh', 'generate_material', 'generate_procedural_model', 'insert_from_creator_store',
        'wait_job_finished', 'search_creator_store',
      ].map((t) => `mcp__Roblox_Studio__${t}`),
  };
}

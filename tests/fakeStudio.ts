// A scripted fake of the Studio MCP proxy for unit tests: records calls and
// answers execute_luau via a handler.
import type { McpClientLike, RawToolResult, ToolInfo } from '../src/studio/session.js';

export interface FakeStudioOptions {
  studios?: { id: string; name: string | null }[][]; // successive list_roblox_studios answers
  studioId?: boolean; // schema advertises studio_id (default true)
  mode?: 'Edit' | 'Play';
  luau?: (code: string, dm: string) => RawToolResult | string;
  tools?: Record<string, (args: Record<string, unknown>) => RawToolResult | string>;
}

export interface FakeStudio {
  client: McpClientLike;
  calls: { name: string; args: Record<string, unknown> }[];
  setMode(m: 'Edit' | 'Play'): void;
}

const text = (t: string, isError = false): RawToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

export function fakeStudio(opts: FakeStudioOptions = {}): FakeStudio {
  const calls: FakeStudio['calls'] = [];
  let mode = opts.mode ?? 'Edit';
  let listIdx = 0;
  const lists = opts.studios ?? [[{ id: 's1', name: 'Place1' }]];
  const withId = opts.studioId !== false;
  const props = (p: string[]) => Object.fromEntries([...p, ...(withId ? ['studio_id'] : [])].map((k) => [k, {}]));
  const tools: ToolInfo[] = [
    { name: 'execute_luau', inputSchema: { properties: props(['code', 'datamodel_type']) } },
    { name: 'get_studio_state', inputSchema: { properties: props([]) } },
    { name: 'start_stop_play', inputSchema: { properties: props(['is_start']) } },
    ...(withId ? [{ name: 'list_roblox_studios', inputSchema: { properties: {} } }] : []),
  ];
  const client: McpClientLike = {
    async listTools() { return { tools }; },
    async callTool(req) {
      calls.push({ name: req.name, args: req.arguments });
      if (req.name === 'list_roblox_studios') {
        const l = lists[Math.min(listIdx++, lists.length - 1)];
        return text(JSON.stringify({ studios: l }));
      }
      if (req.name === 'get_studio_state') {
        return text(`- Current Studio Mode: ${mode}\n- Available DataModels: ${mode === 'Edit' ? 'Edit' : 'Client, Server'}`);
      }
      if (req.name === 'start_stop_play') {
        mode = req.arguments.is_start ? 'Play' : 'Edit';
        return text(req.arguments.is_start ? 'Game Started' : 'Game Stopped');
      }
      if (req.name === 'execute_luau' && opts.luau) {
        const r = opts.luau(String(req.arguments.code), String(req.arguments.datamodel_type));
        return typeof r === 'string' ? text(r) : r;
      }
      const h = opts.tools?.[req.name];
      if (h) {
        const r = h(req.arguments);
        return typeof r === 'string' ? text(r) : r;
      }
      return text(`unknown tool ${req.name}`, true);
    },
    async close() {},
  };
  return { client, calls, setMode: (m) => { mode = m; } };
}

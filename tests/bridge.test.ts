import { describe, it, expect } from 'vitest';
import { createStudioMcpBridge } from '../src/bridge/mcpBridge.js';
import { createMockStudioBridge } from '../src/bridge/mockBridge.js';

describe('real studio bridge', () => {
  it('exposes a stdio MCP server config under Roblox_Studio', () => {
    const b = createStudioMcpBridge();
    const servers = b.mcpServers();
    expect(servers).toHaveProperty('Roblox_Studio');
    const cfg = servers.Roblox_Studio as { type?: string; command: string };
    expect(cfg.type).toBe('stdio');
    expect(typeof cfg.command).toBe('string');
  });

  it('allows only mcp__Roblox_Studio__* tools, incl execute_luau and asset gen', () => {
    const b = createStudioMcpBridge();
    for (const t of b.allowedTools()) {
      expect(t.startsWith('mcp__Roblox_Studio__')).toBe(true);
    }
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__execute_luau');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__generate_mesh');
  });

  it('honors the BLOX_STUDIO_MCP_CMD override', () => {
    const prev = process.env.BLOX_STUDIO_MCP_CMD;
    process.env.BLOX_STUDIO_MCP_CMD = '/custom/StudioMCP';
    try {
      const cfg = createStudioMcpBridge().mcpServers().Roblox_Studio as { command: string };
      expect(cfg.command).toBe('/custom/StudioMCP');
    } finally {
      if (prev === undefined) delete process.env.BLOX_STUDIO_MCP_CMD;
      else process.env.BLOX_STUDIO_MCP_CMD = prev;
    }
  });
});

describe('mock studio bridge', () => {
  it('exposes an in-process server and read-only tools', () => {
    const b = createMockStudioBridge();
    expect(b.mcpServers()).toHaveProperty('roblox_studio');
    expect(b.allowedTools()).toContain('mcp__roblox_studio__search_game_tree');
  });
});

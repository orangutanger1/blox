import { describe, it, expect } from 'vitest';
import { createStudioMcpBridge } from '../src/bridge/mcpBridge.js';
import { createMockStudioBridge } from '../src/bridge/mockBridge.js';

describe('real studio bridge', () => {
  it('exposes a stdio MCP server config under roblox_studio', () => {
    const b = createStudioMcpBridge();
    const servers = b.mcpServers();
    expect(servers).toHaveProperty('roblox_studio');
    const cfg = servers.roblox_studio as { type?: string; command: string };
    expect(cfg.type).toBe('stdio');
    expect(typeof cfg.command).toBe('string');
  });

  it('allows only mcp__roblox_studio__* tools', () => {
    const b = createStudioMcpBridge();
    for (const t of b.allowedTools()) {
      expect(t.startsWith('mcp__roblox_studio__')).toBe(true);
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

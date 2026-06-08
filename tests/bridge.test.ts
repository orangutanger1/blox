import { describe, it, expect } from 'vitest';
import { createStudioMcpBridge, studioLauncher } from '../src/bridge/mcpBridge.js';
import { createMockStudioBridge, sequenceResponder, playResult } from '../src/bridge/mockBridge.js';

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

  it('exposes the tier-2 play tools', () => {
    const b = createStudioMcpBridge();
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__start_stop_play');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__get_console_output');
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
  it('exposes a Roblox_Studio server with execute_luau and asset tools', () => {
    const b = createMockStudioBridge();
    expect(b.mcpServers()).toHaveProperty('Roblox_Studio');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__execute_luau');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__generate_material');
  });

  it('playResult echoes the play state by is_start', () => {
    expect(playResult(true)).toMatch(/Started/);
    expect(playResult(false)).toMatch(/Stopped/);
  });

  it('exposes the tier-2 play tools in the mock too', () => {
    const b = createMockStudioBridge();
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__start_stop_play');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__get_console_output');
  });

  it('mirrors the real bridge SP1b tool set', () => {
    const mockTools = createMockStudioBridge().allowedTools().sort();
    const realTools = createStudioMcpBridge().allowedTools().sort();
    expect(mockTools).toEqual(realTools);
  });
});

describe('studioLauncher', () => {
  it('returns the same command/args the bridge server config uses', () => {
    const l = studioLauncher();
    const cfg = createStudioMcpBridge().mcpServers().Roblox_Studio as {
      command: string; args?: string[];
    };
    expect(l.command).toBe(cfg.command);
    expect(l.args).toEqual(cfg.args ?? []);
  });

  it('defaults to a Windows-side cwd on the cmd.exe path (no override)', () => {
    const prev = process.env.BLOX_STUDIO_MCP_CMD;
    delete process.env.BLOX_STUDIO_MCP_CMD;
    try {
      const l = studioLauncher();
      // linux/WSL + win32 reach mcp.bat via cmd.exe and get a Windows cwd.
      if (process.platform !== 'darwin') {
        expect(l.command).toBe('cmd.exe');
        expect(l.cwd).toBeDefined();
      }
    } finally {
      if (prev === undefined) delete process.env.BLOX_STUDIO_MCP_CMD;
      else process.env.BLOX_STUDIO_MCP_CMD = prev;
    }
  });
});

describe('sequenceResponder', () => {
  it('returns successive entries then repeats the last', () => {
    const next = sequenceResponder(['a', 'b']);
    expect(next()).toBe('a');
    expect(next()).toBe('b');
    expect(next()).toBe('b');
  });

  it('returns empty string when given no entries', () => {
    const next = sequenceResponder([]);
    expect(next()).toBe('');
  });
});

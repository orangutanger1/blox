import { describe, it, expect } from 'vitest';
import { parseDump, parseDumpPage, dumpPageLuau, pullScripts, mockPulledScripts } from '../src/onboard/pull.js';
import type { McpClientFactory } from '../src/doctor.js';

describe('parseDump', () => {
  it('parses a JSON array of scripts', () => {
    const text = JSON.stringify([
      { fullName: 'ServerScriptService.Hello', className: 'Script', source: 'print(1)' },
    ]);
    expect(parseDump(text)).toEqual([
      { fullName: 'ServerScriptService.Hello', className: 'Script', source: 'print(1)' },
    ]);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseDump('not json')).toThrow(/parse/i);
  });

  it('throws when an entry is missing fields', () => {
    expect(() => parseDump(JSON.stringify([{ fullName: 'X' }]))).toThrow(/invalid/i);
  });
});

describe('parseDumpPage', () => {
  it('parses an envelope with scripts and next', () => {
    const text = JSON.stringify({
      scripts: [{ fullName: 'ReplicatedStorage.Mod', className: 'ModuleScript', source: 'return {}' }],
      next: 4,
    });
    expect(parseDumpPage(text)).toEqual({
      scripts: [{ fullName: 'ReplicatedStorage.Mod', className: 'ModuleScript', source: 'return {}' }],
      next: 4,
    });
  });

  it('reports the parse offset on a truncated (unterminated) blob', () => {
    // Mimics the real bug: the transport caps output, cutting a string mid-value.
    const truncated = '{"scripts":[{"fullName":"X","className":"Script","source":"print(';
    expect(() => parseDumpPage(truncated)).toThrow(/parse script dump/i);
  });

  it('throws when the envelope shape is wrong', () => {
    expect(() => parseDumpPage(JSON.stringify({ scripts: [] }))).toThrow(/invalid/i);
    expect(() => parseDumpPage(JSON.stringify([]))).toThrow(/invalid/i);
  });
});

describe('dumpPageLuau', () => {
  it('embeds the requested start and budget', () => {
    const code = dumpPageLuau(12, 60000);
    expect(code).toContain('local start, budget = 12, 60000');
    expect(code).toContain('JSONEncode');
  });
});

// A fake DoctorClient that returns successive page texts across reconnects.
// pullScripts opens a fresh client per page, so the sequence counter lives here.
function pagedFactory(pages: Array<{ text: string; isError?: boolean }>): McpClientFactory {
  let i = 0;
  return async () => ({
    serverInfo: () => ({ name: 'fake', version: '0' }),
    listTools: async () => ({ tools: [{ name: 'mcp__Roblox_Studio__execute_luau' }] }),
    callTool: async () => {
      const p = pages[Math.min(i, pages.length - 1)];
      i++;
      return { content: [{ type: 'text', text: p.text }], isError: p.isError ?? false };
    },
    close: async () => {},
  });
}

function page(scripts: unknown[], next: number, isError = false) {
  return { text: JSON.stringify({ scripts, next }), isError };
}

const launch = { command: 'x', args: [] };

describe('pullScripts', () => {
  it('returns scripts from a single page', async () => {
    const factory = pagedFactory([
      page([{ fullName: 'ReplicatedStorage.Mod', className: 'ModuleScript', source: 'return {}' }], -1),
    ]);
    const scripts = await pullScripts(launch, factory, { probeAttempts: 1, probeDelayMs: 0 });
    expect(scripts).toHaveLength(1);
    expect(scripts[0].className).toBe('ModuleScript');
  });

  it('assembles scripts across multiple pages (the >100KB regression)', async () => {
    const factory = pagedFactory([
      page([{ fullName: 'A', className: 'Script', source: 'print(1)' }], 1),
      page([{ fullName: 'B', className: 'LocalScript', source: 'print(2)' }], 2),
      page([{ fullName: 'C', className: 'ModuleScript', source: 'return {}' }], -1),
    ]);
    const scripts = await pullScripts(launch, factory, { probeAttempts: 1, probeDelayMs: 0 });
    expect(scripts.map((s) => s.fullName)).toEqual(['A', 'B', 'C']);
  });

  it('throws when no Studio attaches', async () => {
    const factory = pagedFactory([{ text: 'no active studio' }]);
    await expect(
      pullScripts(launch, factory, { probeAttempts: 1, probeDelayMs: 0 }),
    ).rejects.toThrow(/studio/i);
  });

  it('throws if a page fails to make progress', async () => {
    // next does not advance past start -> would loop forever; must abort.
    const factory = pagedFactory([
      page([{ fullName: 'A', className: 'Script', source: 'x' }], 0),
    ]);
    await expect(
      pullScripts(launch, factory, { probeAttempts: 1, probeDelayMs: 0 }),
    ).rejects.toThrow(/progress/i);
  });

  it('mockPulledScripts returns a non-empty sample', () => {
    expect(mockPulledScripts().length).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from 'vitest';
import { parseDump, pullScripts, mockPulledScripts } from '../src/onboard/pull.js';
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

// A fake DoctorClient that advertises execute_luau and returns a canned dump.
function fakeFactory(dumpJson: string, isError = false): McpClientFactory {
  return async () => ({
    serverInfo: () => ({ name: 'fake', version: '0' }),
    listTools: async () => ({ tools: [{ name: 'mcp__Roblox_Studio__execute_luau' }] }),
    callTool: async () => ({ content: [{ type: 'text', text: dumpJson }], isError }),
    close: async () => {},
  });
}

const launch = { command: 'x', args: [] };

describe('pullScripts', () => {
  it('returns parsed scripts when attached', async () => {
    const dump = JSON.stringify([
      { fullName: 'ReplicatedStorage.Mod', className: 'ModuleScript', source: 'return {}' },
    ]);
    const scripts = await pullScripts(launch, fakeFactory(dump), { probeAttempts: 1, probeDelayMs: 0 });
    expect(scripts).toHaveLength(1);
    expect(scripts[0].className).toBe('ModuleScript');
  });

  it('throws when no Studio attaches', async () => {
    await expect(
      pullScripts(launch, fakeFactory('no active studio', false), { probeAttempts: 1, probeDelayMs: 0 }),
    ).rejects.toThrow(/studio/i);
  });

  it('mockPulledScripts returns a non-empty sample', () => {
    expect(mockPulledScripts().length).toBeGreaterThan(0);
  });
});

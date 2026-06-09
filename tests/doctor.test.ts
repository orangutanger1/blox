import { describe, it, expect } from 'vitest';
import { runDoctor, formatDoctorReport, type DoctorClient, type McpClientFactory } from '../src/doctor.js';

const launch = { command: 'cmd.exe', args: ['/c', 'x'], cwd: '/mnt/c' };

function fakeFactory(client: Partial<DoctorClient> & { connectThrows?: string }): McpClientFactory {
  return async () => {
    if (client.connectThrows) throw new Error(client.connectThrows);
    return {
      serverInfo: client.serverInfo ?? (() => ({ name: 'RobloxStudio', version: '0.1.0' })),
      listTools: client.listTools ?? (async () => ({ tools: [{ name: 'mcp__Roblox_Studio__execute_luau' }] })),
      callTool: client.callTool ?? (async () => ({ content: [{ type: 'text', text: '2' }], isError: false })),
      close: client.close ?? (async () => {}),
    };
  };
}

describe('runDoctor', () => {
  it('reports not connected when the factory throws', async () => {
    const r = await runDoctor(launch, fakeFactory({ connectThrows: 'spawn cmd.exe ENOENT' }));
    expect(r.connected).toBe(false);
    expect(r.detail).toMatch(/ENOENT/);
  });

  it('reports proxy up but no Studio when execute_luau isError', async () => {
    const r = await runDoctor(launch, fakeFactory({
      callTool: async () => ({ content: [{ type: 'text', text: 'Unable to find an active Studio instance' }], isError: true }),
    }), { probeAttempts: 2, probeDelayMs: 0 });
    expect(r.connected).toBe(true);
    expect(r.studioAttached).toBe(false);
    expect(r.detail).toMatch(/no Studio attached/i);
  });

  it('retries the probe and reports attached once Studio appears', async () => {
    let calls = 0;
    const r = await runDoctor(launch, fakeFactory({
      callTool: async () => {
        calls += 1;
        return calls < 3
          ? { content: [{ type: 'text', text: 'No active Studio instance' }], isError: true }
          : { content: [{ type: 'text', text: '2' }], isError: false };
      },
    }), { probeAttempts: 5, probeDelayMs: 0 });
    expect(calls).toBe(3);
    expect(r.studioAttached).toBe(true);
    expect(r.detail).toMatch(/-> 2/);
  });

  it('reports Studio attached and echoes the luau result', async () => {
    const r = await runDoctor(launch, fakeFactory({}));
    expect(r.connected).toBe(true);
    expect(r.studioAttached).toBe(true);
    expect(r.toolCount).toBe(1);
    expect(r.detail).toMatch(/-> 2/);
  });

  it('still reports connected when no execute_luau tool is advertised', async () => {
    const r = await runDoctor(launch, fakeFactory({
      listTools: async () => ({ tools: [{ name: 'mcp__Roblox_Studio__script_read' }] }),
    }));
    expect(r.connected).toBe(true);
    expect(r.studioAttached).toBeUndefined();
  });
});

describe('formatDoctorReport', () => {
  it('renders a not-connected report', () => {
    const out = formatDoctorReport({ connected: false, detail: 'cannot reach Studio MCP: boom' });
    expect(out).toMatch(/NOT CONNECTED/);
    expect(out).toMatch(/boom/);
  });

  it('renders an attached report with tool count and latency', () => {
    const out = formatDoctorReport({
      connected: true, serverName: 'RobloxStudio', serverVersion: '0.1.0',
      toolCount: 26, tools: ['execute_luau'], connectLatencyMs: 120,
      studioAttached: true, probeLatencyMs: 2, detail: 'Studio attached; execute_luau -> 2',
    });
    expect(out).toMatch(/RobloxStudio/);
    expect(out).toMatch(/26 tools/);
    expect(out).toMatch(/Studio attached/);
  });
});

import { probeExecuteLuau } from '../src/doctor.js';

describe('probeExecuteLuau', () => {
  it('returns the luau result text when attached first try', async () => {
    const r = await probeExecuteLuau(launch, 'return game.X.Source', fakeFactory({}), { probeAttempts: 3, probeDelayMs: 0 });
    expect(r.attached).toBe(true);
    expect(r.text).toBe('2');
    expect(r.attempts).toBe(1);
  });

  it('retries past "no active studio" then attaches', async () => {
    let n = 0;
    const r = await probeExecuteLuau(launch, 'return 1', fakeFactory({
      callTool: async () => {
        n += 1;
        return n < 2
          ? { content: [{ type: 'text', text: 'No active Studio instance' }], isError: true }
          : { content: [{ type: 'text', text: 'SYNCED' }], isError: false };
      },
    }), { probeAttempts: 4, probeDelayMs: 0 });
    expect(r.attached).toBe(true);
    expect(r.text).toBe('SYNCED');
  });

  it('returns not-attached when no execute_luau tool is advertised', async () => {
    const r = await probeExecuteLuau(launch, 'return 1', fakeFactory({
      listTools: async () => ({ tools: [{ name: 'mcp__Roblox_Studio__script_read' }] }),
    }), { probeAttempts: 2, probeDelayMs: 0 });
    expect(r.attached).toBe(false);
  });

  it('sends the required datamodel_type=Edit arg on the execute_luau probe', async () => {
    let sentArgs: Record<string, unknown> | undefined;
    await probeExecuteLuau(launch, 'return 1+1', fakeFactory({
      callTool: async (req) => {
        sentArgs = req.arguments;
        return { content: [{ type: 'text', text: '2' }], isError: false };
      },
    }), { probeAttempts: 1, probeDelayMs: 0 });
    expect(sentArgs).toEqual({ code: 'return 1+1', datamodel_type: 'Edit' });
  });
});

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
    }));
    expect(r.connected).toBe(true);
    expect(r.studioAttached).toBe(false);
    expect(r.detail).toMatch(/no Studio attached/i);
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

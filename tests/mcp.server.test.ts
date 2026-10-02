import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readEvents } from '../src/state/store.js';
import { dashboardState } from '../src/dashboard/server.js';

// Real stdio MCP round-trip against `blox mcp` (no Studio needed for these tools).
describe('blox mcp (stdio)', () => {
  it('advertises the toolset + workflow instructions and serves a Studio-free tool', async () => {
    const project = mkdtempSync(join(tmpdir(), 'blox-mcp-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/cli.ts'), 'mcp', '--project', project],
      env: { ...process.env, BLOX_AGENT_NAME: 'vitest' } as Record<string, string>,
      stderr: 'ignore',
    });
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      expect(client.getInstructions()).toContain('# Building Roblox games with blox');
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        ['asset', 'design', 'explore', 'kit', 'liveops', 'logs', 'metrics', 'multiplayer', 'play', 'playtest', 'present', 'release', 'run_luau', 'run_tests', 'scaffold', 'screenshot', 'status', 'studio_tool', 'sync', 'task', 'ui'],
      );
      const playtest = tools.find((t) => t.name === 'playtest')!;
      expect(Object.keys((playtest.inputSchema as { properties: object }).properties)).toContain('server_code');
      const set = await client.callTool({ name: 'task', arguments: { action: 'set', goal: 'g', criteria: [{ id: 'c1', text: 'x', tests: ['x'] }] } });
      expect((set.content as { text: string }[])[0].text).toContain('goal: g');
      const bad = await client.callTool({ name: 'play', arguments: { action: 'fly' } });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
    const ev = readEvents(project);
    // The MCP SDK rejects schema-invalid args before our handler runs.
    expect(ev.map((e) => e.tool)).toEqual(['task']);
    expect(ev[0].agent).toBe('vitest');
    const dash = dashboardState(project);
    expect(dash.task?.goal).toBe('g');
    expect(dash.events[0].tool).toBe('task');
  }, 30_000);
});

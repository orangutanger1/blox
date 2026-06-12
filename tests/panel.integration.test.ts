import { describe, it, expect, afterEach } from 'vitest';
import { PanelServer } from '../src/panel/server.js';
import { buildCanUseTool } from '../src/agent/permission.js';
import type { PanelEvent } from '../src/panel/events.js';

let server: PanelServer | null = null;
afterEach(async () => {
  if (server) await server.stop();
  server = null;
});

// Minimal stand-in for the Luau plugin: poll, collect, decide.
async function pollOnce(base: string, cursor: number): Promise<{ events: PanelEvent[]; cursor: number }> {
  return (await fetch(`${base}/events?cursor=${cursor}`)).json() as Promise<{ events: PanelEvent[]; cursor: number }>;
}

describe('panel integration: gated run with a dock client', () => {
  it('approve from the dock resumes the gated tool call', async () => {
    server = new PanelServer({ runId: 'r', project: 'g', port: 0, holdMs: 50 });
    const port = await server.start();
    const base = `http://127.0.0.1:${port}/api/v1`;

    // plugin connects (marks the dock as present for gating)
    let { cursor } = await pollOnce(base, 0);

    // the agent hits a gated tool via the real permission callback
    const cb = buildCanUseTool({
      isConnected: () => server!.isConnected(),
      request: (tool, input) => server!.gates.request(tool, input),
    });
    const pending = cb('mcp__Roblox_Studio__generate_mesh', { prompt: 'rock' }, {} as never);

    // plugin sees the gate request and approves it
    const r = await pollOnce(base, cursor);
    cursor = r.cursor;
    const gate = r.events.find((e) => e.type === 'gate_request');
    expect(gate).toBeDefined();
    if (gate?.type !== 'gate_request') throw new Error('unreachable');
    const post = await fetch(`${base}/gate/${gate.gateId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(post.status).toBe(200);

    // the agent's tool call is now allowed
    expect((await pending).behavior).toBe('allow');

    // reconnect from an old cursor replays the resolution event
    const replay = await pollOnce(base, cursor);
    expect(replay.events.some((e) => e.type === 'gate_resolved' && e.decision === 'allow')).toBe(true);
  });

  it('without a connected dock, gating is the classic deny+stop', async () => {
    server = new PanelServer({ runId: 'r', project: 'g', port: 0, holdMs: 50 });
    await server.start();
    // no poll ever happens — isConnected() is false
    const cb = buildCanUseTool({
      isConnected: () => server!.isConnected(),
      request: (tool, input) => server!.gates.request(tool, input),
    });
    const r = await cb('mcp__Roblox_Studio__generate_mesh', {}, {} as never);
    expect(r.behavior).toBe('deny');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { PanelServer } from '../src/panel/server.js';
import { buildCanUseTool } from '../src/agent/permission.js';
import type { PanelEvent } from '../src/panel/events.js';
import { buildAssetResultHook, GEN_MESH_TOOL } from '../src/agent/hooks.js';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';

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

describe('result gate end-to-end through the panel server', () => {
  it('parks the hook, dock rejects with feedback over HTTP, hook blocks with the reason', async () => {
    const localServer = new PanelServer({ runId: 'r', project: 'g', port: 0, holdMs: 50 });
    const port = await localServer.start();
    const base = `http://127.0.0.1:${port}/api/v1`;
    try {
      // simulate a connected dock (connection = recent poll)
      await fetch(`${base}/events?cursor=0`);
      const hook = buildAssetResultHook({
        isConnected: () => localServer.isConnected(),
        requestResult: (tool, tag, summary) => localServer.gates.requestResult(tool, tag, summary),
      });
      const hookOut = hook(
        {
          hook_event_name: 'PostToolUse',
          tool_name: GEN_MESH_TOOL,
          tool_input: { textPrompt: 'barrel' },
          tool_response: { content: [{ type: 'text', text: '{"tag":"Assistant-MeshGen-12345678-aaaa-4bbb-8ccc-1234567890ab"}' }] },
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '',
          cwd: '/game',
        } as unknown as HookInput,
        't1',
        { signal: new AbortController().signal },
      );

      // Poll until the result_gate_request event appears (bounded: 20 × 25ms).
      let req: { type: string; tag: string; gateId: string } | undefined;
      for (let i = 0; i < 20 && !req; i++) {
        const r = await (await fetch(`${base}/events?cursor=0`)).json() as { events: { type: string; tag: string; gateId: string }[] };
        req = r.events.find((e) => e.type === 'result_gate_request');
        if (!req) await new Promise((r) => setTimeout(r, 25));
      }
      expect(req).toBeDefined();
      expect(req!.tag).toBe('Assistant-MeshGen-12345678-aaaa-4bbb-8ccc-1234567890ab');

      await fetch(`${base}/gate/${req!.gateId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'reject', feedback: 'wrong shape' }),
      });

      const out = (await hookOut) as { decision?: string; reason?: string };
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('wrong shape');
      expect(localServer.gates.resultDecisions()).toEqual([
        {
          tool: GEN_MESH_TOOL,
          decision: 'reject',
          source: 'dock',
          feedback: 'wrong shape',
        },
      ]);
    } finally {
      await localServer.stop();
    }
  });
});

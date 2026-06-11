import { describe, it, expect, afterEach } from 'vitest';
import { PanelServer } from '../src/panel/server.js';
import { PROTOCOL_VERSION } from '../src/panel/events.js';

let server: PanelServer | null = null;
afterEach(async () => {
  if (server) await server.stop();
  server = null;
});

async function start(): Promise<{ s: PanelServer; base: string }> {
  // port 0 = OS-assigned ephemeral port; holdMs kept tiny so tests never hang
  server = new PanelServer({ runId: 'run-1', project: 'game', port: 0, holdMs: 50 });
  const port = await server.start();
  return { s: server, base: `http://127.0.0.1:${port}/api/v1` };
}

describe('PanelServer', () => {
  it('serves the handshake on /info', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/info`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ protocol: PROTOCOL_VERSION, runId: 'run-1', project: 'game' });
  });

  it('returns buffered events immediately when available', async () => {
    const { s, base } = await start();
    s.emit({ type: 'log', text: 'hi' });
    const res = await fetch(`${base}/events?cursor=0`);
    const body = await res.json();
    expect(body.cursor).toBe(1);
    expect(body.events).toEqual([{ type: 'log', text: 'hi' }]);
  });

  it('long-polls: holds, then returns the event appended during the hold', async () => {
    const { s, base } = await start();
    const pending = fetch(`${base}/events?cursor=0`);
    setTimeout(() => s.emit({ type: 'log', text: 'late' }), 10);
    const body = await (await pending).json();
    expect(body.events).toEqual([{ type: 'log', text: 'late' }]);
  });

  it('long-polls: returns empty after the hold expires with no events', async () => {
    const { base } = await start();
    const body = await (await fetch(`${base}/events?cursor=0`)).json();
    expect(body).toEqual({ events: [], cursor: 0 });
  });

  it('resolves gates via POST and 404s unknown ids', async () => {
    const { s, base } = await start();
    const decision = s.gates.request('mcp__Roblox_Studio__generate_mesh', {});
    // the gate_request event carries the id
    const events = (await (await fetch(`${base}/events?cursor=0`)).json()).events;
    const req = events.find((e: { type: string }) => e.type === 'gate_request');
    const ok = await fetch(`${base}/gate/${req.gateId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(ok.status).toBe(200);
    expect(await decision).toEqual({ decision: 'allow', source: 'dock' });
    const missing = await fetch(`${base}/gate/nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(missing.status).toBe(404);
  });

  it('rejects bad gate bodies with 400', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/gate/some-id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });

  it('tracks connection state from event polls', async () => {
    const { s, base } = await start();
    expect(s.isConnected()).toBe(false);
    await fetch(`${base}/events?cursor=0`);
    expect(s.isConnected()).toBe(true);
  });

  it('404s unknown paths', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/bogus`)).status).toBe(404);
  });
});

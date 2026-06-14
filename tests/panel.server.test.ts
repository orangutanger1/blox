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

  it('stays connected across a full long-poll hold (window must exceed holdMs)', async () => {
    // While idle the dock holds a single poll for up to holdMs before re-polling,
    // so lastPollAt legitimately ages by holdMs between polls. If the recency
    // window is shorter than holdMs, an actively-connected dock reads as
    // disconnected mid-hold and the PostToolUse result gate silently skips.
    const clock = { t: 1_000_000 };
    const holdMs = 25_000;
    server = new PanelServer({ runId: 'run-1', project: 'game', port: 0, holdMs, now: () => clock.t });
    const port = await server.start();
    const base = `http://127.0.0.1:${port}/api/v1`;
    // A poll arrives (returns at once — buffer already has an event), stamping lastPollAt = now.
    server.emit({ type: 'log', text: 'x' });
    await fetch(`${base}/events?cursor=0`);
    expect(server.isConnected()).toBe(true);
    // The dock is still holding its next poll: lastPollAt has aged a full holdMs.
    clock.t += holdMs;
    expect(server.isConnected()).toBe(true);
    // But a dock that has truly gone (no re-poll well past the window) reads disconnected.
    clock.t += holdMs + 60_000;
    expect(server.isConnected()).toBe(false);
  });

  it('404s unknown paths', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/bogus`)).status).toBe(404);
  });
});

describe('PanelServer — result gates', () => {
  it('resolves a result gate with approve', async () => {
    const { s, base } = await start();
    const decision = s.gates.requestResult('mcp__Roblox_Studio__generate_mesh', 'Assistant-MeshGen-abc', '{}');
    const events = (await (await fetch(`${base}/events?cursor=0`)).json()).events;
    const req = events.find((e: { type: string }) => e.type === 'result_gate_request');
    const ok = await fetch(`${base}/gate/${req.gateId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(ok.status).toBe(200);
    expect(await decision).toEqual({ decision: 'approve', source: 'dock' });
  });

  it('passes reject feedback through, truncated at 2000 chars', async () => {
    const { s, base } = await start();
    const decision = s.gates.requestResult('mcp__Roblox_Studio__generate_mesh', null, '{}');
    const events = (await (await fetch(`${base}/events?cursor=0`)).json()).events;
    const req = events.find((e: { type: string }) => e.type === 'result_gate_request');
    await fetch(`${base}/gate/${req.gateId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject', feedback: 'x'.repeat(3000) }),
    });
    const d = await decision;
    expect(d.decision).toBe('reject');
    expect(d.feedback?.length).toBe(2000);
  });

  it('400s a kind-mismatched decision on a live gate', async () => {
    const { s, base } = await start();
    void s.gates.request('mcp__Roblox_Studio__generate_mesh', {});
    const events = (await (await fetch(`${base}/events?cursor=0`)).json()).events;
    const req = events.find((e: { type: string }) => e.type === 'gate_request');
    const res = await fetch(`${base}/gate/${req.gateId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(400);
    // gate still pending — the right decision still works
    const ok = await fetch(`${base}/gate/${req.gateId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(ok.status).toBe(200);
  });
});

describe('PanelServer — image upload', () => {
  it('emits image_request and resolves requestImage() from a POST /image', async () => {
    const { s, base } = await start();
    const pending = s.requestImage();
    const events = (await (await fetch(`${base}/events?cursor=0`)).json()).events;
    expect(events.some((e: { type: string }) => e.type === 'image_request')).toBe(true);
    const res = await fetch(`${base}/image`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from([1, 2, 3]),
    });
    expect(res.status).toBe(200);
    expect(await pending).toEqual({ mediaType: 'image/png', base64: Buffer.from([1, 2, 3]).toString('base64') });
  });

  it('409s when no image request is pending', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/image`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from([1]),
    });
    expect(res.status).toBe(409);
  });

  it('400s a non-image content-type, leaving the request open', async () => {
    const { s, base } = await start();
    const pending = s.requestImage();
    const bad = await fetch(`${base}/image`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from([1]),
    });
    expect(bad.status).toBe(400);
    // still open — a good upload then settles it
    await fetch(`${base}/image`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.from([9]),
    });
    expect((await pending).mediaType).toBe('image/jpeg');
  });
});

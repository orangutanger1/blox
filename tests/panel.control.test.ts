// tests/panel.control.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { PanelServer, type PanelController } from '../src/panel/server.js';

let server: PanelServer | null = null;
afterEach(async () => { if (server) await server.stop(); server = null; });

function fakeController(over: Partial<PanelController> = {}): PanelController {
  return {
    listModels: () => ({ provider: 'openrouter', models: ['google/gemini-2.5-pro'], current: 'google/gemini-2.5-pro' }),
    launch: () => ({ ok: true, runId: 'run-1' }),
    cancel: () => ({ ok: false }),
    state: () => 'idle',
    ...over,
  };
}

async function start(controller?: PanelController): Promise<string> {
  server = new PanelServer({ runId: 'idle', project: 'g', port: 0, holdMs: 50 });
  if (controller) server.attachController(controller);
  const port = await server.start();
  return `http://127.0.0.1:${port}/api/v1`;
}

describe('panel control routes', () => {
  it('GET /models returns the controller list', async () => {
    const base = await start(fakeController());
    const r = await fetch(`${base}/models`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ provider: 'openrouter', models: ['google/gemini-2.5-pro'], current: 'google/gemini-2.5-pro' });
  });

  it('POST /run returns 202 and the runId on success', async () => {
    const base = await start(fakeController());
    const r = await fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi', model: 'google/gemini-2.5-pro' }) });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ runId: 'run-1' });
  });

  it('POST /run with empty prompt is 400', async () => {
    const base = await start(fakeController());
    const r = await fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '  ', model: 'google/gemini-2.5-pro' }) });
    expect(r.status).toBe(400);
  });

  it('POST /run surfaces a controller rejection (busy → 409)', async () => {
    const base = await start(fakeController({ launch: () => ({ ok: false, status: 409, error: 'busy' }) }));
    const r = await fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi', model: 'x' }) });
    expect(r.status).toBe(409);
  });

  it('POST /cancel returns 200 when the controller cancels a run', async () => {
    const base = await start(fakeController({ cancel: () => ({ ok: true }) }));
    const r = await fetch(`${base}/cancel`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('POST /cancel returns 409 when no run is active', async () => {
    const base = await start(fakeController());
    const r = await fetch(`${base}/cancel`, { method: 'POST' });
    expect(r.status).toBe(409);
  });

  it('GET /info includes state when a controller is attached', async () => {
    const base = await start(fakeController({ state: () => 'running' }));
    expect((await (await fetch(`${base}/info`)).json()).state).toBe('running');
  });

  it('control routes 404 without a controller (one-shot mode)', async () => {
    const base = await start();
    expect((await fetch(`${base}/models`)).status).toBe(404);
  });

  it('GET /info includes the auth chip when attached, computed once (memoized)', async () => {
    server = new PanelServer({ runId: 'idle', project: 'g', port: 0, holdMs: 50 });
    let calls = 0;
    server.attachAuth(() => { calls++; return { mode: 'apiKey', label: 'API key' }; });
    const port = await server.start();
    const base = `http://127.0.0.1:${port}/api/v1`;
    const first = await (await fetch(`${base}/info`)).json();
    await (await fetch(`${base}/info`)).json();
    expect(first.auth).toEqual({ mode: 'apiKey', label: 'API key' });
    expect(calls).toBe(1);
  });

  it('GET /info omits auth when none is attached', async () => {
    const base = await start();
    expect((await (await fetch(`${base}/info`)).json()).auth).toBeUndefined();
  });
});

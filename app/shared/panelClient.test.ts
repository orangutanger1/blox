import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createPanelClient } from './panelClient.js';

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

// Minimal stand-in for the engine's panel server: the 4 routes the client uses.
function stub(handlers: Record<string, (body: string) => { status: number; json: unknown }>): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const h = handlers[`${req.method} ${req.url?.split('?')[0]}`];
        const r = h ? h(body) : { status: 404, json: { error: 'nf' } };
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server!.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });
}

describe('createPanelClient', () => {
  it('reads /info', async () => {
    const base = await stub({ 'GET /api/v1/info': () => ({ status: 200, json: { protocol: 3, runId: 'r1', project: 'g' } }) });
    const c = createPanelClient(base);
    expect(await c.info()).toEqual({ protocol: 3, runId: 'r1', project: 'g' });
  });

  it('polls events and returns the envelope', async () => {
    const base = await stub({ 'GET /api/v1/events': () => ({ status: 200, json: { events: [{ type: 'log', text: 'hi' }], cursor: 1 } }) });
    const c = createPanelClient(base);
    expect(await c.poll(0)).toEqual({ events: [{ type: 'log', text: 'hi' }], cursor: 1 });
  });

  it('posts a gate decision and returns ok', async () => {
    const base = await stub({ 'POST /api/v1/gate/abc': () => ({ status: 200, json: { ok: true } }) });
    const c = createPanelClient(base);
    expect(await c.resolveGate('abc', 'allow')).toBe(true);
  });

  it('returns null on a network error (server down)', async () => {
    const c = createPanelClient('http://127.0.0.1:1'); // nothing listening
    expect(await c.info()).toBeNull();
  });
});

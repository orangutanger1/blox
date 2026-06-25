import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayServer } from '../src/relay/server.js';
import { addMember } from '../src/relay/members.js';
import { readRelayEntries } from '../src/relay/ledger.js';
import { DEFAULT_PRICING_CONFIG } from '../src/config.js';

let relay: RelayServer | null = null;
let upstream: Server | null = null;
afterEach(async () => { if (relay) await relay.stop(); relay = null; upstream?.close(); upstream = null; });

// Mock api.anthropic.com: echoes a fixed messages response with usage,
// and records the x-api-key it received so the test can assert key-swap.
// Pass statusCode (default 200) to simulate upstream error responses.
function startUpstream(received: { key?: string }, statusCode = 200): Promise<string> {
  return new Promise((resolve) => {
    upstream = createServer((req, res) => {
      received.key = req.headers['x-api-key'] as string;
      let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
        if (statusCode >= 200 && statusCode < 300) {
          res.writeHead(statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'message', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1000, output_tokens: 500 } }));
        } else {
          res.writeHead(statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad request' } }));
        }
      });
    });
    upstream.listen(0, '127.0.0.1', () => {
      const a = upstream!.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });
}

function relayOpts(over: Partial<{ membersPath: string; ledgerPath: string; upstream: string; policy: unknown }> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'blox-'));
  return {
    membersPath: over.membersPath ?? join(dir, 'm.json'),
    ledgerPath: over.ledgerPath ?? join(dir, 'l.jsonl'),
    upstream: over.upstream ?? 'http://127.0.0.1:1',
    policy: over.policy,
  };
}

async function start(o: { membersPath: string; ledgerPath: string; upstream: string; policy?: unknown }) {
  relay = new RelayServer({
    realKey: 'sk-real-team-key',
    policy: o.policy as never,
    relay: {
      port: 0, host: '127.0.0.1', apiKeyEnv: 'X', upstream: o.upstream,
      membersPath: o.membersPath, ledgerPath: o.ledgerPath, pricing: DEFAULT_PRICING_CONFIG,
    },
  });
  const port = await relay.start();
  return `http://127.0.0.1:${port}`;
}

const post = (base: string, key: string, body: unknown) =>
  fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('RelayServer', () => {
  it('401s an unknown member token without proxying', async () => {
    const o = relayOpts();
    const base = await start(o);
    const res = await post(base, 'blx_unknown', { model: 'claude-opus-4-8' });
    expect(res.status).toBe(401);
  });

  it('403s a disallowed model', async () => {
    const o = relayOpts({ policy: { models: ['claude-sonnet-4-6'] } });
    const token = addMember(o.membersPath, 'a@x.com');
    const base = await start(o);
    const res = await post(base, token, { model: 'claude-opus-4-8' });
    expect(res.status).toBe(403);
  });

  it('proxies a valid call with the REAL key, returns the body, and ledgers the cost', async () => {
    const received: { key?: string } = {};
    const up = await startUpstream(received);
    const o = relayOpts({ upstream: up });
    const token = addMember(o.membersPath, 'a@x.com');
    const base = await start(o);
    const res = await post(base, token, { model: 'claude-opus-4-8' });
    expect(res.status).toBe(200);
    expect((await res.json()).content[0].text).toBe('hi');
    expect(received.key).toBe('sk-real-team-key'); // member token swapped for the real key
    const entries = readRelayEntries(o.ledgerPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].user).toBe('a@x.com');
    expect(entries[0].inputTokens).toBe(1000);
    expect(entries[0].costUsd).toBeCloseTo((1000 / 1e6) * 5 + (500 / 1e6) * 25); // 0.005 + 0.0125
  });

  it('relays upstream 4xx status and writes NO ledger entry', async () => {
    const received: { key?: string } = {};
    const up = await startUpstream(received, 400);
    const o = relayOpts({ upstream: up });
    const token = addMember(o.membersPath, 'a@x.com');
    const base = await start(o);
    const res = await post(base, token, { model: 'claude-opus-4-8' });
    expect(res.status).toBe(400);
    const entries = readRelayEntries(o.ledgerPath);
    expect(entries).toHaveLength(0);
  });

  it('GET /api/v1/usage returns 401 with no token', async () => {
    const o = relayOpts();
    const base = await start(o);
    const res = await fetch(`${base}/api/v1/usage`);
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('unknown member token');
  });

  it('GET /api/v1/usage returns 401 with a bogus token', async () => {
    const o = relayOpts();
    const base = await start(o);
    const res = await fetch(`${base}/api/v1/usage`, { headers: { 'x-api-key': 'blx_bogus' } });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('unknown member token');
  });

  it('serves GET /api/v1/usage from the relay ledger (requires valid member token)', async () => {
    const up = await startUpstream({});
    const o = relayOpts({ upstream: up });
    const token = addMember(o.membersPath, 'a@x.com');
    const base = await start(o);
    await post(base, token, { model: 'claude-opus-4-8' });
    const usage = await (await fetch(`${base}/api/v1/usage`, { headers: { 'x-api-key': token } })).json();
    expect(usage.runCount).toBe(1);
    expect(usage.byUser[0].key).toBe('a@x.com');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { RelayServer } from '../src/relay/server.js';
import { addMember } from '../src/relay/members.js';
import { readRelayEntries } from '../src/relay/ledger.js';
import { DEFAULT_PRICING_CONFIG } from '../src/config.js';

let relay: RelayServer | null = null;
let upstream: Server | null = null;
afterEach(async () => { if (relay) await relay.stop(); relay = null; upstream?.closeAllConnections(); upstream?.close(); upstream = null; });

function startUpstream(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((resolve) => {
    upstream = createServer(handler);
    upstream.listen(0, '127.0.0.1', () => {
      const a = upstream!.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });
}

async function startRelay(up: string, extra: { upstreamTimeoutSeconds?: number; tls?: { cert: Buffer; key: Buffer } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'blox-rh-'));
  const membersPath = join(dir, 'm.json');
  const ledgerPath = join(dir, 'l.jsonl');
  const token = addMember(membersPath, 'a@x.com');
  relay = new RelayServer({
    realKey: 'sk-real',
    tls: extra.tls,
    relay: { port: 0, host: '127.0.0.1', apiKeyEnv: 'X', upstream: up, membersPath, ledgerPath, pricing: DEFAULT_PRICING_CONFIG, upstreamTimeoutSeconds: extra.upstreamTimeoutSeconds ?? 600 },
  });
  const port = await relay.start();
  return { base: `${extra.tls ? 'https' : 'http'}://127.0.0.1:${port}`, token, ledgerPath };
}

const SSE = [
  'event: message_start', 'data: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":4000}}}', '',
  'event: content_block_delta', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}', '',
  'event: message_delta', 'data: {"type":"message_delta","usage":{"output_tokens":200}}', '',
  'event: message_stop', 'data: {"type":"message_stop"}', '', '',
].join('\n');

describe('relay hardening', () => {
  it('streams SSE end to end and ledgers its usage', async () => {
    const up = await startUpstream((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
        for (const chunk of SSE.match(/[^]{1,40}/g)!) res.write(chunk);
        res.end();
      });
    });
    const { base, token, ledgerPath } = await startRelay(up);
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-4-8', stream: true }) });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe(SSE);
    await new Promise((r) => setTimeout(r, 50));
    expect(readRelayEntries(ledgerPath)[0]).toMatchObject({ inputTokens: 1000, cacheReadTokens: 4000, outputTokens: 200 });
  });

  it('forwards only API headers to the team account', async () => {
    let seen: IncomingHttpHeaders = {};
    const up = await startUpstream((req, res) => {
      seen = req.headers;
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"usage":{}}'); });
    });
    const { base, token } = await startRelay(up);
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'b1', cookie: 'sid=1', authorization: 'Bearer member', 'x-forwarded-for': '10.0.0.1', 'accept-encoding': 'gzip' },
      body: '{"model":"claude-opus-4-8"}',
    });
    expect(seen['x-api-key']).toBe('sk-real');
    expect(seen['anthropic-version']).toBe('2023-06-01');
    expect(seen['anthropic-beta']).toBe('b1');
    for (const h of ['cookie', 'authorization', 'x-forwarded-for', 'accept-encoding']) expect(seen[h]).toBeUndefined();
  });

  it('answers 504 when upstream stalls past the timeout', async () => {
    const up = await startUpstream(() => { /* never answers */ });
    const { base, token } = await startRelay(up, { upstreamTimeoutSeconds: 0.2 });
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token }, body: '{"model":"claude-opus-4-8"}' });
    expect(res.status).toBe(504);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/upstream timeout/);
  });

  it('serves HTTPS when given a cert and key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    const tls = { cert: readFileSync(join(dir, 'c.pem')), key: readFileSync(join(dir, 'k.pem')) };
    const { base } = await startRelay('http://127.0.0.1:1', { tls });
    const body = await new Promise<string>((resolve, reject) => {
      httpsRequest(`${base}/healthz`, { ca: tls.cert, checkServerIdentity: () => undefined }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve(b)); }).on('error', reject).end();
    });
    expect(JSON.parse(body)).toEqual({ ok: true });
  });
});

import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { PassThrough } from 'node:stream';
import type { Relay, Policy } from '../config.js';
import { loadMembers, authMember } from './members.js';
import { enforceRelay } from './enforce.js';
import { usageFromJson, usageFromSse } from './usage.js';
import { costUsd } from './pricing.js';
import { appendRelayEntry, readRelayEntries, type RelayEntry } from './ledger.js';
import { aggregateUsage } from '../usageReport.js';

export interface RelayServerOptions {
  relay: Relay;
  policy?: Policy;
  realKey: string;
  port?: number;
  now?: () => number;
}

export class RelayServer {
  private server: Server | null = null;
  private opts: RelayServerOptions;
  constructor(opts: RelayServerOptions) { this.opts = opts; }

  start(): Promise<number> {
    const server = createServer((req, res) => void this.route(req, res));
    this.server = server;
    const port = this.opts.port ?? this.opts.relay.port;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.opts.relay.host, () => {
        const a = server.address();
        resolve(typeof a === 'object' && a ? a.port : port);
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/v1/usage') return this.usage(url, res);
    if (req.method === 'POST' && url.pathname === '/v1/messages') return this.messages(req, res);
    return json(res, 404, { error: 'not found' });
  }

  private usage(url: URL, res: ServerResponse): void {
    const sinceRaw = url.searchParams.get('since');
    const n = sinceRaw != null ? Number(sinceRaw.replace(/d$/, '')) : NaN;
    const sinceDays = Number.isInteger(n) && n > 0 ? n : null;
    const rb = this.opts.policy?.rollingBudget;
    const summary = aggregateUsage(readRelayEntries(this.opts.relay.ledgerPath), {
      now: new Date(),
      windowDays: sinceDays ?? rb?.windowDays ?? null,
      capUsd: rb?.maxUsd ?? null,
    });
    json(res, 200, summary);
  }

  private async messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. auth
    const presented = (req.headers['x-api-key'] as string) ?? '';
    const member = authMember(loadMembers(this.opts.relay.membersPath), presented);
    if (!member) return json(res, 401, { error: 'unknown member token' });

    // 2. buffer body + read model
    const body = await readBytes(req);
    let model = '';
    try { model = String((JSON.parse(body.toString('utf8')) as { model?: unknown }).model ?? ''); } catch { /* leave '' */ }

    // 3. enforce
    const reject = enforceRelay({ model, policy: this.opts.policy, ledgerPath: this.opts.relay.ledgerPath });
    if (reject) return json(res, reject.status, { error: reject.error });

    // 4. proxy with the REAL key, tee the response for usage
    const u = new URL('/v1/messages', this.opts.relay.upstream);
    const reqFn = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    headers['x-api-key'] = this.opts.realKey;
    headers['host'] = u.host;
    headers['content-length'] = String(body.length);

    const up = reqFn(u, { method: 'POST', headers }, (upRes: IncomingMessage) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      const tee = new PassThrough();
      const chunks: Buffer[] = [];
      tee.on('data', (c: Buffer) => chunks.push(c));
      upRes.pipe(res);
      upRes.pipe(tee);
      upRes.on('end', () => {
        const code = upRes.statusCode ?? 0;
        if (code < 200 || code >= 300) return; // only ledger successful spend
        const raw = Buffer.concat(chunks).toString('utf8');
        const ct = String(upRes.headers['content-type'] ?? '');
        const usage = ct.includes('text/event-stream') ? usageFromSse(raw) : usageFromJson(safeJson(raw));
        const { usd, unknownPrice } = costUsd(usage, model, this.opts.relay.pricing);
        const entry: RelayEntry = {
          ts: new Date().toISOString(), user: member, model, turns: 1, costUsd: usd,
          status: 'success', commit: null, prompt: '',
          inputTokens: usage.input, outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
          ...(unknownPrice ? { unknownPrice: true } : {}),
        };
        try { appendRelayEntry(this.opts.relay.ledgerPath, entry); } catch { /* never fail a served response */ }
      });
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    up.end(body);
  }
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }
async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

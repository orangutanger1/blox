import { createServer as createHttpsServer } from 'node:https';
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
import { DASHBOARD_HTML } from './dashboard.js';

export interface RelayServerOptions {
  relay: Relay;
  policy?: Policy;
  realKey: string;
  port?: number;
  now?: () => number;
  tls?: { cert: string | Buffer; key: string | Buffer };
}

// Request headers passed to the team's account. Everything else (cookies,
// proxy headers, the member's own auth, accept-encoding so the tee can read
// usage) stays at the relay.
const FORWARD_HEADER = /^(content-type|accept|user-agent|anthropic-[a-z0-9-]+|x-stainless-[a-z0-9-]+|x-app)$/;
// Hop-by-hop response headers (RFC 7230 §6.1); node writes its own framing.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'trailer', 'te', 'proxy-authenticate', 'proxy-authorization']);

export class RelayServer {
  private server: Server | null = null;
  private opts: RelayServerOptions;
  constructor(opts: RelayServerOptions) { this.opts = opts; }

  // Set when upstream rejected the team key (401); cleared by the next success.
  // /check reports it so runs fail before starting.
  private upstreamKeyRejected = false;
  private nowDate(): Date { return new Date(this.opts.now?.() ?? Date.now()); }

  start(): Promise<number> {
    const handler = (req: IncomingMessage, res: ServerResponse) => void this.route(req, res).catch(() => { if (!res.writableEnded) { try { res.writeHead(502); } catch { /**/ } res.end(); } });
    const server: Server = this.opts.tls ? (createHttpsServer(this.opts.tls, handler) as unknown as Server) : createServer(handler);
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
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
      return void res.end(DASHBOARD_HTML);
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/usage') return this.usage(req, url, res);
    if (req.method === 'GET' && url.pathname === '/api/v1/check') return this.check(req, url, res);
    if (req.method === 'POST' && url.pathname === '/v1/messages') return this.messages(req, res);
    return apiError(res, 404, 'not_found_error', 'not found');
  }

  // Client preflight: the same auth + policy decision /v1/messages would make,
  // without spending anything.
  private check(req: IncomingMessage, url: URL, res: ServerResponse): void {
    const presented = (req.headers['x-api-key'] as string) ?? '';
    const member = authMember(loadMembers(this.opts.relay.membersPath), presented);
    if (!member) return apiError(res, 401, 'authentication_error', 'unknown member token');
    const model = url.searchParams.get('model');
    if (model !== null) {
      const reject = enforceRelay({ model, member, policy: this.opts.policy, ledgerPath: this.opts.relay.ledgerPath, now: this.nowDate() });
      if (reject) return apiError(res, reject.status, 'permission_error', reject.error);
    }
    if (this.upstreamKeyRejected) return apiError(res, 503, 'api_error', TEAM_KEY_REJECTED);
    json(res, 200, { ok: true, member });
  }

  private usage(req: IncomingMessage, url: URL, res: ServerResponse): void {
    const presented = (req.headers['x-api-key'] as string) ?? '';
    const member = authMember(loadMembers(this.opts.relay.membersPath), presented);
    if (!member) return apiError(res, 401, 'authentication_error', 'unknown member token');
    const sinceRaw = url.searchParams.get('since');
    const n = sinceRaw != null ? Number(sinceRaw.replace(/d$/, '')) : NaN;
    const sinceDays = Number.isInteger(n) && n > 0 ? n : null;
    const rb = this.opts.policy?.rollingBudget;
    const summary = aggregateUsage(readRelayEntries(this.opts.relay.ledgerPath), {
      now: this.nowDate(),
      windowDays: sinceRaw === 'all' ? null : sinceDays ?? rb?.windowDays ?? null,
      capUsd: rb?.maxUsd ?? null,
    });
    // The relay ledgers one entry per model request, not per blox run.
    json(res, 200, { ...summary, unit: 'requests', source: 'relay', ...(rb?.perMemberUsd ? { memberCapUsd: rb.perMemberUsd } : {}) });
  }

  private async messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. auth
    const presented = (req.headers['x-api-key'] as string) ?? '';
    const member = authMember(loadMembers(this.opts.relay.membersPath), presented);
    // 403, not 401: the Agent SDK retries a 401 silently for minutes but fails
    // fast on 403, and neither can be fixed by retrying.
    if (!member) return apiError(res, 403, 'authentication_error', 'unknown member token');

    // 2. buffer body + read model
    const body = await readBytes(req);
    let model = '';
    try { model = String((JSON.parse(body.toString('utf8')) as { model?: unknown }).model ?? ''); } catch { /* leave '' */ }

    // 3. enforce
    const reject = enforceRelay({ model, member, policy: this.opts.policy, ledgerPath: this.opts.relay.ledgerPath, now: this.nowDate() });
    if (reject) return apiError(res, reject.status, 'permission_error', reject.error);

    // 4. proxy with the REAL key, tee the response for usage
    const u = new URL('/v1/messages', this.opts.relay.upstream);
    const reqFn = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && FORWARD_HEADER.test(k)) headers[k] = v;
    headers['x-api-key'] = this.opts.realKey;
    headers['host'] = u.host;
    headers['content-length'] = String(body.length);

    const up = reqFn(u, { method: 'POST', headers }, (upRes: IncomingMessage) => {
      if (upRes.statusCode === 401) {
        this.upstreamKeyRejected = true;
        upRes.resume();
        return apiError(res, 403, 'authentication_error', TEAM_KEY_REJECTED);
      }
      if ((upRes.statusCode ?? 0) < 400) this.upstreamKeyRejected = false;
      const outHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) outHeaders[k] = v;
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
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
    up.setTimeout((this.opts.relay.upstreamTimeoutSeconds ?? 600) * 1000, () => up.destroy(new Error('upstream timeout')));
    up.on('error', (e) => {
      if (!res.headersSent) return apiError(res, /timeout/.test(e.message) ? 504 : 502, 'api_error', `upstream ${e.message}`);
      res.end();
    });
    up.end(body);
  }
}

const TEAM_KEY_REJECTED = "upstream rejected the team's API key; ask the relay admin to fix it";

function json(res: ServerResponse, status: number, obj: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
// Anthropic's error shape, so Claude clients show the relay's reason verbatim
// instead of an opaque status code.
function apiError(res: ServerResponse, status: number, type: string, message: string): void {
  json(res, status, { type: 'error', error: { type, message: `blox relay: ${message}` } });
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }
async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

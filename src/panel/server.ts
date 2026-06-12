import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventBuffer } from './buffer.js';
import { GateBroker } from './gates.js';
import { PROTOCOL_VERSION, type PanelEvent } from './events.js';

export interface PanelServerOptions {
  runId: string;
  project: string;
  port?: number; // 0 = ephemeral (tests); default 35768
  holdMs?: number; // long-poll hold; default 25_000
  gateTimeoutMs?: number; // default 120_000
  connectedWindowMs?: number; // poll recency window; default 10_000
  now?: () => number; // injectable clock for tests
}

// The CLI-side half of the dock panel (spec §3.1, §4). Binds 127.0.0.1 only —
// the same local trust model as the Rojo plugin. The panel must never block or
// break a run: callers treat start() failures as a warning, not an error.
export class PanelServer {
  readonly gates: GateBroker;
  private buffer = new EventBuffer();
  private server: Server | null = null;
  private lastPollAt = 0;
  private opts: Required<Omit<PanelServerOptions, 'port'>> & { port: number };

  constructor(options: PanelServerOptions) {
    this.opts = {
      runId: options.runId,
      project: options.project,
      port: options.port ?? 35768,
      holdMs: options.holdMs ?? 25_000,
      gateTimeoutMs: options.gateTimeoutMs ?? 120_000,
      connectedWindowMs: options.connectedWindowMs ?? 10_000,
      now: options.now ?? Date.now,
    };
    this.gates = new GateBroker({ emit: (e) => this.emit(e) }, this.opts.gateTimeoutMs);
  }

  emit(event: PanelEvent): void {
    this.buffer.append(event);
  }

  // Connected = the plugin polled within the recency window. Gating uses this
  // to decide interactive-ask vs. the deny+stop fallback (spec §5).
  isConnected(): boolean {
    return this.opts.now() - this.lastPollAt < this.opts.connectedWindowMs;
  }

  start(): Promise<number> {
    const server = createServer((req, res) => void this.route(req, res));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : this.opts.port);
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
    try {
      if (req.method === 'GET' && url.pathname === '/api/v1/info') {
        return json(res, 200, { protocol: PROTOCOL_VERSION, runId: this.opts.runId, project: this.opts.project });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/events') {
        this.lastPollAt = this.opts.now();
        const cursor = Number(url.searchParams.get('cursor') ?? '0') || 0;
        let r = this.buffer.since(cursor);
        if (r.events.length === 0) {
          // Hold until an event lands or the hold expires (empty → re-poll).
          await Promise.race([this.buffer.waitForChange(), sleep(this.opts.holdMs)]);
          r = this.buffer.since(cursor);
        }
        return json(res, 200, r);
      }
      const gateMatch = url.pathname.match(/^\/api\/v1\/gate\/([^/]+)$/);
      if (req.method === 'POST' && gateMatch) {
        const body = (await readJson(req)) as { decision?: unknown; feedback?: unknown } | null;
        const decision = body?.decision;
        if (decision !== 'allow' && decision !== 'deny' && decision !== 'approve' && decision !== 'reject') {
          return json(res, 400, { error: 'decision must be "allow", "deny", "approve" or "reject"' });
        }
        const kind = this.gates.kindOf(gateMatch[1]);
        if (!kind) return json(res, 404, { error: 'unknown gate id' });
        const feedback = typeof body?.feedback === 'string' ? body.feedback.slice(0, 2000) : undefined;
        const ok = this.gates.resolve(gateMatch[1], decision, feedback);
        return ok
          ? json(res, 200, { ok: true })
          : json(res, 400, { error: `decision "${decision}" does not match the gate kind "${kind}"` });
      }
      return json(res, 404, { error: 'not found' });
    } catch {
      return json(res, 400, { error: 'bad request' });
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  try {
    res.end(JSON.stringify(body));
  } catch {
    // swallow errors on connections killed during stop()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

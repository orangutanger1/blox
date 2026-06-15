import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventBuffer } from './buffer.js';
import { GateBroker } from './gates.js';
import { PROTOCOL_VERSION, type PanelEvent } from './events.js';
import { imageFromBytes, type ImageInput } from '../agent/imageInput.js';

export interface PanelServerOptions {
  runId: string;
  project: string;
  port?: number; // 0 = ephemeral (tests); default 35768
  holdMs?: number; // long-poll hold; default 25_000
  gateTimeoutMs?: number; // default 120_000
  connectedWindowMs?: number; // poll recency window; default 10_000
  now?: () => number; // injectable clock for tests
}

export interface PanelController {
  listModels(): { provider: string | null; models: string[]; current: string | null };
  launch(prompt: string, model: string): { ok: true; runId: string } | { ok: false; status: number; error: string };
  cancel(): { ok: boolean };
  state(): 'idle' | 'running';
}

// The CLI-side half of the dock panel (spec §3.1, §4). Binds 127.0.0.1 only —
// the same local trust model as the Rojo plugin. The panel must never block or
// break a run: callers treat start() failures as a warning, not an error.
export class PanelServer {
  readonly gates: GateBroker;
  private buffer = new EventBuffer();
  private server: Server | null = null;
  private lastPollAt = 0;
  private pendingImage: { resolve: (i: ImageInput) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private opts: Required<Omit<PanelServerOptions, 'port'>> & { port: number };
  private controller: PanelController | null = null;
  private currentRunId: string;

  constructor(options: PanelServerOptions) {
    const holdMs = options.holdMs ?? 25_000;
    this.opts = {
      runId: options.runId,
      project: options.project,
      port: options.port ?? 35768,
      holdMs,
      gateTimeoutMs: options.gateTimeoutMs ?? 120_000,
      // The recency window MUST exceed holdMs. While idle the dock sits in a
      // single long-poll for up to holdMs, so lastPollAt ages by holdMs between
      // re-polls; a window < holdMs intermittently misreports a connected dock
      // as disconnected, silently skipping the PostToolUse result gate. The
      // +10s margin absorbs re-poll/network/dock-render latency.
      connectedWindowMs: options.connectedWindowMs ?? holdMs + 10_000,
      now: options.now ?? Date.now,
    };
    this.currentRunId = this.opts.runId;
    this.gates = new GateBroker({ emit: (e) => this.emit(e) }, this.opts.gateTimeoutMs);
  }

  emit(event: PanelEvent): void {
    this.buffer.append(event);
  }

  attachController(controller: PanelController): void {
    this.controller = controller;
  }

  setRunId(runId: string): void {
    this.currentRunId = runId;
  }

  // Connected = the plugin polled within the recency window. Gating uses this
  // to decide interactive-ask vs. the deny+stop fallback (spec §5).
  isConnected(): boolean {
    return this.opts.now() - this.lastPollAt < this.opts.connectedWindowMs;
  }

  // Park until the dock uploads an image (POST /api/v1/image) or the timeout
  // fires. One image per run. Reuses the gate timeout knob.
  requestImage(): Promise<ImageInput> {
    this.emit({ type: 'image_request' });
    return new Promise<ImageInput>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingImage = null;
        reject(new Error('no image uploaded from the dock within the timeout'));
      }, this.opts.gateTimeoutMs);
      this.pendingImage = { resolve, timer };
    });
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
    if (this.pendingImage) {
      clearTimeout(this.pendingImage.timer);
      this.pendingImage = null;
    }
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
        return json(res, 200, {
          protocol: PROTOCOL_VERSION,
          runId: this.currentRunId,
          project: this.opts.project,
          ...(this.controller ? { state: this.controller.state() } : {}),
        });
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
      if (req.method === 'POST' && url.pathname === '/api/v1/image') {
        if (!this.pendingImage) return json(res, 409, { error: 'no image request pending' });
        const bytes = await readBytes(req);
        let image: ImageInput;
        try {
          image = imageFromBytes(req.headers['content-type'], bytes);
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
        const p = this.pendingImage;
        this.pendingImage = null;
        clearTimeout(p.timer);
        p.resolve(image);
        return json(res, 200, { ok: true });
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
      if (req.method === 'GET' && url.pathname === '/api/v1/models') {
        if (!this.controller) return json(res, 404, { error: 'not found' });
        return json(res, 200, this.controller.listModels());
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/run') {
        if (!this.controller) return json(res, 404, { error: 'not found' });
        const body = (await readJson(req)) as { prompt?: unknown; model?: unknown } | null;
        const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
        const model = typeof body?.model === 'string' ? body.model : '';
        if (!prompt) return json(res, 400, { error: 'prompt required' });
        if (!model) return json(res, 400, { error: 'model required' });
        const r = this.controller.launch(prompt, model);
        return r.ok ? json(res, 202, { runId: r.runId }) : json(res, r.status, { error: r.error });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/cancel') {
        if (!this.controller) return json(res, 404, { error: 'not found' });
        const r = this.controller.cancel();
        return r.ok ? json(res, 200, { ok: true }) : json(res, 409, { error: 'no run active' });
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

async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';

// The lane: a localhost job slot the blox dock plugin polls, so blox can run
// plugin-security APIs (StudioTestService) the Studio MCP cannot reach.
// GET /lane/job hands the job out once; POST /lane/result settles it.

export const LANE_PORT = 35769;

export interface LaneJob {
  kind: 'multiplayer';
  clients: number;
}
export interface LaneResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      s += c;
      if (s.length > 16 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });

export function runLaneJob(job: LaneJob, o: { port?: number; pickupMs?: number; timeoutMs: number }): Promise<LaneResult> {
  const id = randomUUID();
  const port = o.port ?? LANE_PORT;
  return new Promise<LaneResult>((resolve, reject) => {
    let taken = false;
    let done = false;
    const timers: NodeJS.Timeout[] = [];
    const server = createServer((req, res) => {
      const send = (code: number, v: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (req.method === 'GET' && req.url === '/lane/job') {
        if (taken || done) return send(200, {});
        taken = true;
        return send(200, { id, ...job });
      }
      if (req.method === 'POST' && req.url === '/lane/result') {
        body(req)
          .then((s) => {
            const r = JSON.parse(s) as LaneResult & { id?: string };
            if (r.id !== id) return send(409, { error: 'unknown job' });
            send(200, { ok: true });
            finish(null, { ok: !!r.ok, ...(r.result !== undefined ? { result: r.result } : {}), ...(r.error ? { error: String(r.error) } : {}) });
          })
          .catch(() => send(400, { error: 'bad result' }));
        return;
      }
      send(404, {});
    });
    const finish = (err: Error | null, r?: LaneResult) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      server.close();
      server.closeAllConnections?.();
      if (err) reject(err);
      else resolve(r!);
    };
    server.on('error', (e: NodeJS.ErrnoException) =>
      finish(new Error(e.code === 'EADDRINUSE' ? `lane port ${port} is in use (another multiplayer run?)` : `lane: ${e.message}`)),
    );
    server.listen(port, '127.0.0.1', () => {
      timers.push(
        setTimeout(() => {
          if (!taken) finish(new Error(`the blox dock plugin did not pick up the job within ${Math.round((o.pickupMs ?? 20_000) / 1000)}s — keep Studio open with the current blox plugin installed (blox panel install) and HTTP requests allowed`));
        }, o.pickupMs ?? 20_000),
        setTimeout(() => finish(new Error(`multiplayer job timed out after ${Math.round(o.timeoutMs / 1000)}s`)), o.timeoutMs),
      );
    });
  });
}

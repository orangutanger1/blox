import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseFlags } from '../cliTools.js';
import { loadConfig } from '../config.js';
import { evaluateCriteria, loadTask, withSyntheticResults, readEvents, readJson, type TestSummaryLike } from '../state/store.js';
import { studioSessionFor } from '../mcp/server.js';
import type { StudioSession } from '../studio/session.js';
import { DASHBOARD_HTML } from './page.js';

// `blox dashboard` — a read-only window onto <project>/.blox/: the same event
// log and result files every agent's tool calls write. It never drives
// Studio beyond a cheap attach/mode probe, and agents never need it.

export function dashboardState(projectPath: string) {
  const lastTests = readJson<TestSummaryLike & { ok: boolean; passed: number; total: number; fileErrors: { file: string; message: string }[]; logErrors: { message: string; context: string }[] }>(projectPath, 'last-tests.json');
  const task = loadTask(projectPath);
  const events = readEvents(projectPath, 400);
  const artDir = join(projectPath, '.blox', 'artifacts');
  const artifacts = existsSync(artDir)
    ? readdirSync(artDir)
        .filter((f) => /\.(png|jpe?g)$/i.test(f))
        .map((f) => ({ name: f, mtime: statSync(join(artDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 12)
    : [];
  // Test pass-rate history from the event log (run_tests summaries "x/y passed").
  const testHistory = events
    .filter((e) => e.tool === 'run_tests')
    .map((e) => {
      const m = /(\d+)\/(\d+) passed/.exec(e.summary);
      return m ? { ts: e.ts, passed: Number(m[1]), total: Number(m[2]) } : null;
    })
    .filter(Boolean);
  return {
    project: { name: basename(projectPath), path: projectPath },
    now: new Date().toISOString(),
    task: task ? { ...task, criteria: evaluateCriteria(task, withSyntheticResults(projectPath, lastTests)) } : null,
    lastTests,
    lastPlaytest: readJson(projectPath, 'last-playtest.json'),
    lastSync: readJson(projectPath, 'last-sync.json'),
    events: events.slice(-200).reverse(),
    testHistory,
    artifacts,
  };
}

function send(res: ServerResponse, code: number, type: string, body: string | Buffer) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

export async function runDashboardCommand(argv: string[]): Promise<void> {
  const f = parseFlags(argv);
  const projectPath = resolve(f.project ?? process.cwd());
  const port = typeof f.opts.port === 'string' ? Number(f.opts.port) : 35780;
  const config = loadConfig(projectPath, { projectPath });
  let session: StudioSession | null = null;
  let studioCache: { at: number; value: unknown } | null = null;

  const probeStudio = async () => {
    if (studioCache && Date.now() - studioCache.at < 10_000) return studioCache.value;
    let value: unknown;
    try {
      session ??= studioSessionFor(config);
      const s = await Promise.race([
        (async () => {
          const studio = await session!.attach();
          const st = await session!.state();
          return { attached: true, name: studio.name, id: studio.id, mode: st.mode };
        })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('probe timed out')), 8000)),
      ]);
      value = s;
    } catch (e) {
      value = { attached: false, error: (e as Error).message };
      await session?.close().catch(() => {});
      session = null;
    }
    studioCache = { at: Date.now(), value };
    return value;
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', DASHBOARD_HTML);
      if (url.pathname === '/api/state') return send(res, 200, 'application/json', JSON.stringify(dashboardState(projectPath)));
      if (url.pathname === '/api/studio') return send(res, 200, 'application/json', JSON.stringify(await probeStudio()));
      if (url.pathname.startsWith('/artifacts/')) {
        const name = basename(decodeURIComponent(url.pathname.slice('/artifacts/'.length)));
        const file = join(projectPath, '.blox', 'artifacts', name);
        if (!existsSync(file)) return send(res, 404, 'text/plain', 'not found');
        return send(res, 200, name.endsWith('.png') ? 'image/png' : 'image/jpeg', readFileSync(file));
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      send(res, 500, 'text/plain', (e as Error).message);
    }
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  console.log(`blox dashboard → http://127.0.0.1:${port}  (project ${projectPath}; Ctrl-C to stop)`);
  await new Promise<void>((r) => {
    process.on('SIGINT', () => r());
    process.on('SIGTERM', () => r());
  });
  server.close();
  await (session as StudioSession | null)?.close();
}

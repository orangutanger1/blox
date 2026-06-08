import { spawn as nodeSpawn } from 'node:child_process';
import { checkRojoServe, type FetchFn } from './serveCheck.js';

// A long-running serve process. Distinct from rojo.ts's one-shot SpawnFn, which
// resolves only AFTER the child exits — wrong shape for a daemon we must keep
// alive and later kill.
export interface ServeHandle {
  pid?: number;
  kill(): void;
  exited: Promise<number>; // resolves with the exit code when the child dies
}
export type ServeSpawnFn = (projectPath: string, port: number) => ServeHandle;

export function rojoServePort(): number {
  const raw = process.env.BLOX_ROJO_SERVE_PORT;
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 34872;
}

// Kept consistent with serveCheck.rojoServeUrl(): an explicit URL override wins;
// otherwise localhost on the chosen port.
export function serveUrl(port: number): string {
  return process.env.BLOX_ROJO_SERVE_URL ?? `http://localhost:${port}`;
}

// Spawns `rojo serve --port <port>` in the project dir (cwd → default.project.json,
// mirroring syncProject). Not detached — killable via the handle for clean teardown.
export const realServeSpawn: ServeSpawnFn = (projectPath, port) => {
  const child = nodeSpawn('rojo', ['serve', '--port', String(port)], { cwd: projectPath });
  const exited = new Promise<number>((res) => {
    child.on('error', () => res(1));
    child.on('close', (code) => res(code ?? 1));
  });
  return { pid: child.pid, kill: () => { child.kill('SIGTERM'); }, exited };
};

export type ServeMode = 'reused' | 'spawned';
export interface ServeSession {
  mode: ServeMode;
  url: string;
  port: number;
  handle: ServeHandle | null; // null when reused
}

export interface EnsureServeOptions {
  spawn?: ServeSpawnFn;            // default realServeSpawn
  fetch?: FetchFn;                 // default checkRojoServe's own default
  port?: number;                   // default rojoServePort()
  attempts?: number;               // readiness poll, default 10
  delayMs?: number;                // readiness poll, default 500
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function ensureServe(projectPath: string, opts: EnsureServeOptions = {}): Promise<ServeSession> {
  const port = opts.port ?? rojoServePort();
  const url = serveUrl(port);
  const spawn = opts.spawn ?? realServeSpawn;
  const attempts = opts.attempts ?? 10;
  const delayMs = opts.delayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;

  const first = await checkRojoServe(url, opts.fetch);
  if (first.reachable) return { mode: 'reused', url, port, handle: null };

  const handle = spawn(projectPath, port);
  let exitCode: number | null = null;
  void handle.exited.then((c) => { exitCode = c; });

  for (let i = 0; i < attempts; i++) {
    if (exitCode !== null) {
      throw new Error(`rojo serve exited with code ${exitCode} before becoming reachable`);
    }
    const r = await checkRojoServe(url, opts.fetch);
    if (r.reachable) return { mode: 'spawned', url, port, handle };
    await sleep(delayMs);
  }
  handle.kill();
  throw new Error(`rojo serve did not become reachable at ${url} after ${attempts} attempts`);
}

export async function stopServe(session: ServeSession): Promise<void> {
  if (session.mode !== 'spawned' || !session.handle) return;
  session.handle.kill();
  await session.handle.exited;
}

export interface SignalLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}
export interface TeardownOptions {
  proc?: SignalLike;
  exit?: (code: number) => void;
}

// Safety net so an interrupted run never orphans a rojo process. Only spawned
// sessions are registered; reused serves are never touched. 'exit' kills sync
// (Node forbids async work there); signals kill then exit 130 (adding a signal
// listener suppresses Node's default exit-on-signal, so we exit explicitly).
export function registerServeTeardown(session: ServeSession, opts: TeardownOptions = {}): void {
  if (session.mode !== 'spawned' || !session.handle) return;
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const handle = session.handle;
  proc.on('exit', () => { handle.kill(); });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    proc.on(sig, () => { handle.kill(); exit(130); });
  }
}

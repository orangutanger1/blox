import { spawn as nodeSpawn } from 'node:child_process';

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

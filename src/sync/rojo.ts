import { spawn as nodeSpawn } from 'node:child_process';

export type SpawnResult = { code: number; stdout: string; stderr: string };
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<SpawnResult>;

export const realSpawn: SpawnFn = (cmd, args, opts) =>
  new Promise((resolveP) => {
    const child = nodeSpawn(cmd, args, { cwd: opts.cwd });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => resolveP({ code: 1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolveP({ code: code ?? 1, stdout, stderr }));
  });

// The rojo binary to invoke. The desktop app sets BLOX_ROJO_BIN to a bundled
// absolute path so it need not mutate PATH; the CLI default stays "rojo".
export function rojoBin(): string {
  return process.env.BLOX_ROJO_BIN || 'rojo';
}

export interface SyncResult {
  ok: boolean;
  detail: string;
}

export async function syncProject(
  projectPath: string,
  spawn: SpawnFn = realSpawn,
): Promise<SyncResult> {
  const res = await spawn(rojoBin(), ['sourcemap'], { cwd: projectPath });
  if (res.code === 0) return { ok: true, detail: 'rojo sourcemap ok' };
  return { ok: false, detail: `rojo sourcemap failed: ${res.stderr.trim() || res.stdout.trim()}` };
}

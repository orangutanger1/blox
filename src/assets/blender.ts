import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Headless Blender normalize step for external meshes (tools/blender/normalize.py).
export const NORMALIZE_SCRIPT = fileURLToPath(new URL('../../tools/blender/normalize.py', import.meta.url));

export const blenderBin = () => process.env.BLOX_BLENDER || 'blender';

export function blenderArgs(input: string, out: string, tris: number, height: number): string[] {
  return ['-b', '--factory-startup', '--python', NORMALIZE_SCRIPT, '--', input, out, String(tris), String(height)];
}

export interface NormalizeResult {
  out: string;
  trisBefore: number;
  trisAfter: number;
  size: [number, number, number];
}

export function parseNormalize(stdout: string, out: string): NormalizeResult | null {
  const m = /BLOX_NORMALIZE tris_before=(\d+) tris_after=(\d+) size=([\d.]+),([\d.]+),([\d.]+)/.exec(stdout);
  return m ? { out, trisBefore: Number(m[1]), trisAfter: Number(m[2]), size: [Number(m[3]), Number(m[4]), Number(m[5])] } : null;
}

export type Spawner = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string; notFound?: boolean }>;

export const defaultSpawn: Spawner = (cmd, args) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e: NodeJS.ErrnoException) => resolve({ code: null, stdout, stderr: e.message, notFound: e.code === 'ENOENT' }));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });

export async function runNormalize(o: { input: string; out: string; tris: number; height: number; spawn?: Spawner }): Promise<NormalizeResult> {
  if (!existsSync(o.input)) throw new Error(`input not found: ${o.input}`);
  const r = await (o.spawn ?? defaultSpawn)(blenderBin(), blenderArgs(o.input, o.out, o.tris, o.height));
  if (r.notFound) throw new Error(`Blender not found ("${blenderBin()}") — install Blender 3.6+ and put it on PATH, or set BLOX_BLENDER`);
  const err = /BLOX_ERROR (.*)/.exec(`${r.stdout}\n${r.stderr}`)?.[1];
  if (err) throw new Error(`normalize: ${err}`);
  if (r.code !== 0) throw new Error(`blender exited ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join(' | ')}`);
  const res = parseNormalize(r.stdout, o.out);
  if (!res) throw new Error('blender finished without a BLOX_NORMALIZE report');
  return res;
}

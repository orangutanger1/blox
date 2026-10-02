import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Lune (standalone Luau runtime) lets pure-logic Luau run inside vitest. Tests
// that need it skip when no binary is found: BLOX_LUNE, else `lune` on PATH.
export function luneBin(): string | null {
  const c = process.env.BLOX_LUNE || 'lune';
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' });
    return c;
  } catch {
    return null;
  }
}

export const LUNE_DIR = fileURLToPath(new URL('../lune/', import.meta.url));

export interface LuneSpecResult {
  results: { file: string; name: string; status: 'pass' | 'fail'; message?: string }[];
  fileErrors: { file: string; message: string }[];
}

export function runLune(script: string, args: string[], input?: string): string {
  const r = spawnSync(luneBin()!, ['run', script, ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`lune ${script} exited ${r.status}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// Runs `edit` specs (paths relative to projectDir) offline.
export function runLuneSpecs(projectDir: string, specs: string[]): LuneSpecResult {
  const out = runLune(`${LUNE_DIR}harness.luau`, [projectDir, ...specs]).trim().split('\n');
  const r = JSON.parse(out[out.length - 1]) as LuneSpecResult;
  // serde encodes empty Luau tables as {}
  return { results: Array.isArray(r.results) ? r.results : [], fileErrors: Array.isArray(r.fileErrors) ? r.fileErrors : [] };
}

// Compile-only syntax check; returns one message per file that fails.
export function luneCheck(files: string[]): string[] {
  const out = runLune(`${LUNE_DIR}check.luau`, files).trim();
  return out ? out.split('\n') : [];
}

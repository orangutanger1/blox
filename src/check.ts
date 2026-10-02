import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { realSpawn, rojoBin, type SpawnFn } from './sync/rojo.js';

// Static checks over a project's Luau, the gate a change passes before it is
// synced: StyLua formatting, a fresh Rojo sourcemap, luau-lsp type + lint
// analysis (vendored packages and Replica skipped) and a Rojo build. A tool
// that is not installed is reported as skipped, never as passed.

export type CheckStepName = 'format' | 'sourcemap' | 'analyze' | 'build';
export interface CheckStep {
  name: CheckStepName;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}
export interface CheckResult {
  ok: boolean;
  steps: CheckStep[];
}

export interface CheckOptions {
  spawn?: SpawnFn;
  fix?: boolean; // format with StyLua instead of only checking
  types?: () => Promise<string>; // path to Roblox globalTypes.d.luau
}

// Third-party code the project vendors: not ours to type-check or reformat.
export const VENDORED_GLOBS = ['**/Packages/**', '**/ServerPackages/**', '**/_Index/**', '**/ReplicaClient.luau', '**/ReplicaServer.luau', '**/ReplicaShared/**'];

const TYPES_URL = 'https://raw.githubusercontent.com/JohnnyMorganz/luau-lsp/main/scripts/globalTypes.d.luau';
const TYPES_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// Roblox API type definitions for luau-lsp, cached for a week under
// ~/.cache/blox (BLOX_LUAU_TYPES points at a local copy instead).
export async function robloxTypes(): Promise<string> {
  if (process.env.BLOX_LUAU_TYPES) return process.env.BLOX_LUAU_TYPES;
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'blox');
  const file = join(dir, 'globalTypes.d.luau');
  const { statSync } = await import('node:fs');
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < TYPES_MAX_AGE_MS) return file;
  try {
    const res = await fetch(TYPES_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, await res.text());
  } catch (e) {
    if (existsSync(file)) return file; // stale beats nothing
    throw new Error(`could not download Roblox type definitions (${(e as Error).message}); set BLOX_LUAU_TYPES to a local globalTypes.d.luau`);
  }
  return file;
}

async function has(spawn: SpawnFn, cmd: string, cwd: string): Promise<boolean> {
  const r = await spawn(cmd, ['--version'], { cwd });
  return r.code === 0;
}

const tail = (s: string, n = 20) => s.trim().split('\n').slice(-n).join('\n');

export async function runCheck(projectPath: string, o: CheckOptions = {}): Promise<CheckResult> {
  const spawn = o.spawn ?? realSpawn;
  const steps: CheckStep[] = [];
  const step = (name: CheckStepName, status: CheckStep['status'], detail: string) => steps.push({ name, status, detail });
  const cwd = projectPath;

  // 1. format
  const styluaConfig = ['.stylua.toml', 'stylua.toml'].some((f) => existsSync(join(projectPath, f)));
  if (!styluaConfig) step('format', 'skip', 'no .stylua.toml in the project');
  else if (!existsSync(join(projectPath, 'src'))) step('format', 'skip', 'no src/');
  else if (!(await has(spawn, 'stylua', cwd))) step('format', 'skip', 'stylua not installed');
  else {
    const globs = VENDORED_GLOBS.flatMap((g) => ['-g', `!${g}`]).concat(['-g', '*.luau', '-g', '*.lua']);
    const r = await spawn('stylua', [...(o.fix ? [] : ['--check']), ...globs, 'src'], { cwd });
    if (r.code === 0) step('format', 'pass', o.fix ? 'formatted src' : 'src is formatted');
    else {
      const files = [...(r.stdout + r.stderr).matchAll(/^Diff in (.+):$/gm)].map((m) => m[1]);
      step('format', 'fail', files.length ? `${files.length} file(s) need formatting (check {fix:true} formats them): ${files.join(', ')}` : tail(r.stderr || r.stdout));
    }
  }

  // 2. sourcemap
  const sm = await spawn(rojoBin(), ['sourcemap', 'default.project.json', '--output', 'sourcemap.json'], { cwd });
  const sourcemapOk = sm.code === 0;
  step('sourcemap', sourcemapOk ? 'pass' : 'fail', sourcemapOk ? 'sourcemap.json written' : tail(sm.stderr || sm.stdout));

  // 3. analyze
  if (!sourcemapOk) step('analyze', 'skip', 'needs a sourcemap');
  else if (!existsSync(join(projectPath, 'src'))) step('analyze', 'skip', 'no src/');
  else if (!(await has(spawn, 'luau-lsp', cwd))) step('analyze', 'skip', 'luau-lsp not installed (github.com/JohnnyMorganz/luau-lsp releases)');
  else {
    let types: string | null = null;
    try {
      types = await (o.types ?? robloxTypes)();
    } catch (e) {
      step('analyze', 'skip', (e as Error).message);
    }
    if (types) {
      const r = await spawn(
        'luau-lsp',
        ['analyze', `--definitions=${types}`, '--sourcemap=sourcemap.json', ...VENDORED_GLOBS.map((g) => `--ignore=${g}`), 'src'],
        { cwd },
      );
      // Paths relative to the project; luau-lsp repeats a diagnostic once per
      // DataModel context a module is required from, so dedupe.
      const prefix = projectPath.replace(/[\\/]+$/, '') + '/';
      const lines = [
        ...new Set(
          (r.stdout + '\n' + r.stderr)
            .split('\n')
            .filter((l) => /\(\d+,\d+\): \w+:/.test(l))
            .map((l) => l.split(prefix).join('').replace(/ \[game\/[^\]]*\]/, '')),
        ),
      ];
      const errors = lines.filter((l) => /\(\d+,\d+\): \w*Error:/.test(l));
      const warnings = lines.length - errors.length;
      if (r.code === 0 && errors.length === 0) step('analyze', 'pass', `no type errors${warnings ? `, ${warnings} lint warning(s)` : ''}`);
      else
        step(
          'analyze',
          'fail',
          `${errors.length} error(s)${warnings ? `, ${warnings} lint warning(s)` : ''}\n${(errors.length ? errors : [tail(r.stderr || r.stdout)]).slice(0, 30).join('\n')}`,
        );
    }
  }

  // 4. build
  const tmp = mkdtempSync(join(tmpdir(), 'blox-check-'));
  try {
    const b = await spawn(rojoBin(), ['build', 'default.project.json', '--output', join(tmp, 'check.rbxlx')], { cwd });
    step('build', b.code === 0 ? 'pass' : 'fail', b.code === 0 ? 'rojo build ok' : tail(b.stderr || b.stdout));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  return { ok: steps.every((s) => s.status !== 'fail'), steps };
}

export function formatCheck(r: CheckResult): string {
  const lines = r.steps.map((s) => `${s.status.toUpperCase()} ${s.name}: ${s.detail}`);
  lines.push(r.ok ? 'check passed' : 'check FAILED — fix the errors above and rerun');
  return lines.join('\n');
}

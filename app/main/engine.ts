// app/main/engine.ts
// Supervises the existing blox CLI as a child. All Electron/OS specifics
// (the fork fn, the engine path, the key loader) are injected so this unit
// tests headless. In production `fork` wraps Electron's utilityProcess.fork.

export interface EngineChild {
  on(event: 'exit', cb: (code: number | null) => void): void;
  kill(): void;
  stdout?: { on(event: 'data', cb: (chunk: Buffer) => void): void };
  stderr?: { on(event: 'data', cb: (chunk: Buffer) => void): void };
}

export interface RunOptions {
  mode?: 'auto' | 'ask';
  maxTurns?: number;
  budgetUsd?: number;
  effort?: 'high' | 'xhigh';
  image?: string;
  model?: string;
}

export interface EngineDeps {
  enginePath: string;
  fork: (entry: string, args: string[], env: NodeJS.ProcessEnv) => EngineChild;
  rojoDir?: string;
  pathSep?: string; // injectable for tests; defaults to the OS delimiter
}

export interface RunHandle {
  cancel(): void;
  done: Promise<{ code: number | null }>;
}

export function buildRunArgs(prompt: string, projectPath: string, o: RunOptions = {}): string[] {
  const args = [prompt, '--project', projectPath, o.mode === 'ask' ? '--ask' : '--auto'];
  if (o.maxTurns != null) args.push('--max-turns', String(o.maxTurns));
  if (o.budgetUsd != null) args.push('--budget', String(o.budgetUsd));
  if (o.effort) args.push('--effort', o.effort);
  if (o.image) args.push('--image', o.image);
  if (o.model) args.push('--model', o.model);
  return args;
}

export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  rojoDir: string | undefined,
  sep: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (rojoDir) env.PATH = `${rojoDir}${sep}${base.PATH ?? ''}`;
  return env;
}

export function createEngineHost(deps: EngineDeps) {
  const sep = deps.pathSep ?? (process.platform === 'win32' ? ';' : ':');
  function spawn(args: string[], collectStdout?: (s: string) => void, collectStderr?: (s: string) => void): RunHandle {
    const env = buildChildEnv(process.env, deps.rojoDir, sep);
    const child = deps.fork(deps.enginePath, args, env);
    if (collectStdout && child.stdout) child.stdout.on('data', (c) => collectStdout(c.toString()));
    if (collectStderr && child.stderr) child.stderr.on('data', (c) => collectStderr(c.toString()));
    const done = new Promise<{ code: number | null }>((resolve) => {
      child.on('exit', (code) => resolve({ code }));
    });
    return { cancel: () => child.kill(), done };
  }
  return {
    run(prompt: string, projectPath: string, opts: RunOptions = {}): RunHandle {
      return spawn(buildRunArgs(prompt, projectPath, opts));
    },
    // Drive a subcommand (doctor / panel install / init) and collect both
    // streams — init prints its real failure + hint to stderr, so callers need
    // it to tell the user *why* a run aborted (e.g. "open Studio, then re-run").
    async runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
      let out = '';
      let err = '';
      const handle = spawn(args, (s) => (out += s), (s) => (err += s));
      const { code } = await handle.done;
      return { code, stdout: out, stderr: err };
    },
  };
}

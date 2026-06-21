import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

export type AuthMode = 'subscription' | 'apiKey';
export interface AuthStore {
  mode?: AuthMode;
  apiKey?: string;
}

// User-level credential store lives outside the project (blox.config.json is
// project-local + read-only, and the API key is a secret). Honor XDG_CONFIG_HOME.
export function authConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
  const base = xdg ? xdg : join(homedir(), '.config');
  return join(base, 'blox');
}

export function authStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(authConfigDir(env), 'auth.json');
}

// Any failure (missing, bad JSON, unexpected shape) degrades to an empty store
// rather than crashing — auth state is best-effort, never load-bearing for reads.
export function loadAuthStore(path: string = authStorePath()): AuthStore {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const r = raw as Record<string, unknown>;
    const store: AuthStore = {};
    if (r.mode === 'subscription' || r.mode === 'apiKey') store.mode = r.mode;
    if (typeof r.apiKey === 'string' && r.apiKey) store.apiKey = r.apiKey;
    return store;
  } catch {
    return {};
  }
}

export function saveAuthStore(store: AuthStore, path: string = authStorePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600); // enforce perms even if the file pre-existed
}

export function setApiKey(key: string, path: string = authStorePath()): void {
  const s = loadAuthStore(path);
  s.apiKey = key;
  saveAuthStore(s, path);
}

export function clearApiKey(path: string = authStorePath()): void {
  const s = loadAuthStore(path);
  delete s.apiKey;
  saveAuthStore(s, path);
}

export function setMode(mode: AuthMode, path: string = authStorePath()): void {
  const s = loadAuthStore(path);
  s.mode = mode;
  saveAuthStore(s, path);
}

// apiKey only takes effect when a key is actually stored; everything else
// resolves to subscription (the engine's stored `claude` login).
export function effectiveAuthMode(store: AuthStore, override?: AuthMode | null): AuthMode {
  const want = override ?? store.mode;
  if (want === 'apiKey' && store.apiKey) return 'apiKey';
  return 'subscription';
}

export interface BuildAuthEnvOpts {
  override?: AuthMode | null;
  store?: AuthStore;
  baseEnv?: NodeJS.ProcessEnv;
}

// Full env replacement for a direct-Anthropic run's Options.env (mirrors
// ccrRunEnv). Returns undefined when subscription mode needs no changes —
// the caller then passes process.env through untouched. Always injects exactly
// one Anthropic credential (the SDK rejects key + token together).
export function buildAuthEnv(opts: BuildAuthEnvOpts = {}): Record<string, string> | undefined {
  const store = opts.store ?? loadAuthStore();
  const baseEnv = opts.baseEnv ?? process.env;
  const mode = effectiveAuthMode(store, opts.override);

  const copy = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(baseEnv)) if (typeof v === 'string') env[k] = v;
    return env;
  };

  if (mode === 'apiKey') {
    const env = copy();
    env.ANTHROPIC_API_KEY = store.apiKey!;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    return env;
  }
  // subscription: pass through, but strip a stray key so the choice is honored.
  if (typeof baseEnv.ANTHROPIC_API_KEY === 'string') {
    const env = copy();
    delete env.ANTHROPIC_API_KEY;
    return env;
  }
  return undefined;
}

export type ClaudeRunner = (
  args: string[],
  opts: { inherit: boolean },
) => { status: number | null; stdout: string; error?: NodeJS.ErrnoException };

const defaultRunner: ClaudeRunner = (args, opts) => {
  const res = spawnSync('claude', args, {
    stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (res.error) return { status: null, stdout: '', error: res.error as NodeJS.ErrnoException };
  return { status: res.status, stdout: res.stdout ?? '' };
};

function claudeError(err: NodeJS.ErrnoException): string {
  if (err.code === 'ENOENT') {
    return 'claude CLI not found on PATH. Install Claude Code: https://claude.com/claude-code';
  }
  return `failed to run claude: ${err.message}`;
}

// Subscription link/unlink is delegated wholesale to Claude Code's own auth
// (browser OAuth + token refresh). blox just spawns it with inherited stdio.
export function runClaudeAuth(
  sub: 'login' | 'logout',
  runner: ClaudeRunner = defaultRunner,
): { ok: boolean; error?: string } {
  const res = runner(['auth', sub], { inherit: true });
  if (res.error) return { ok: false, error: claudeError(res.error) };
  return {
    ok: res.status === 0,
    error: res.status === 0 ? undefined : `claude auth ${sub} exited ${res.status}`,
  };
}

export interface SubscriptionStatus {
  loggedIn: boolean;
  email?: string;
  plan?: string;
  authMethod?: string;
}

export function readSubscriptionStatus(
  runner: ClaudeRunner = defaultRunner,
): SubscriptionStatus | { error: string } {
  const res = runner(['auth', 'status'], { inherit: false });
  if (res.error) return { error: claudeError(res.error) };
  try {
    const j = JSON.parse(res.stdout) as Record<string, unknown>;
    return {
      loggedIn: j.loggedIn === true,
      email: typeof j.email === 'string' ? j.email : undefined,
      plan: typeof j.subscriptionType === 'string' ? j.subscriptionType : undefined,
      authMethod: typeof j.authMethod === 'string' ? j.authMethod : undefined,
    };
  } catch {
    return { loggedIn: false };
  }
}

export function formatAuthStatus(sub: SubscriptionStatus | { error: string }, store: AuthStore): string {
  const lines: string[] = [`active mode: ${effectiveAuthMode(store)}`];
  if ('error' in sub) {
    lines.push(`subscription: unknown (${sub.error})`);
  } else if (sub.loggedIn) {
    const detail = [sub.plan, sub.email].filter(Boolean).join(', ');
    lines.push(`subscription: linked${detail ? ` (${detail})` : ''}`);
  } else {
    lines.push('subscription: not linked — run `blox auth login`');
  }
  lines.push(`api key: ${store.apiKey ? 'stored' : 'not set — run `blox auth key set`'}`);
  if (store.mode === 'apiKey' && !store.apiKey) {
    lines.push('note: mode is apiKey but no key stored — runs fall back to subscription');
  }
  return lines.join('\n');
}

// Interactive hidden input for `blox auth key set`. I/O only — not unit-tested.
export function promptSecret(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    process.stdout.write(label);
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

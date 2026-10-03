import type { UsageSummary } from './usageReport.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

// relay = a team's `blox relay serve`: runs go through it with a per-member
// token; the team's real key never leaves the relay host.
export type AuthMode = 'subscription' | 'apiKey' | 'relay';
export interface RelayLink {
  url: string;
  token: string;
}
export interface AuthStore {
  mode?: AuthMode;
  apiKey?: string;
  relay?: RelayLink;
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
    if (r.mode === 'subscription' || r.mode === 'apiKey' || r.mode === 'relay') store.mode = r.mode;
    if (typeof r.apiKey === 'string' && r.apiKey) store.apiKey = r.apiKey;
    const rl = r.relay as Record<string, unknown> | undefined;
    if (rl && typeof rl.url === 'string' && rl.url && typeof rl.token === 'string' && rl.token) {
      store.relay = { url: rl.url, token: rl.token };
    }
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

export function setRelay(link: RelayLink, path: string = authStorePath()): void {
  const s = loadAuthStore(path);
  s.relay = { url: link.url.replace(/\/+$/, ''), token: link.token };
  s.mode = 'relay';
  saveAuthStore(s, path);
}

export function clearRelay(path: string = authStorePath()): void {
  const s = loadAuthStore(path);
  delete s.relay;
  if (s.mode === 'relay') delete s.mode;
  saveAuthStore(s, path);
}

// apiKey / relay only take effect when their credential is actually stored;
// everything else resolves to subscription (the engine's stored `claude` login).
export function effectiveAuthMode(store: AuthStore, override?: AuthMode | null): AuthMode {
  const want = override ?? store.mode;
  if (want === 'apiKey' && store.apiKey) return 'apiKey';
  if (want === 'relay' && store.relay) return 'relay';
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
  if (mode === 'relay') {
    // The relay authenticates the member token from x-api-key.
    const env = copy();
    env.ANTHROPIC_BASE_URL = store.relay!.url;
    env.ANTHROPIC_API_KEY = store.relay!.token;
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
  // Windows: npm installs `claude.cmd`; plain spawn can't resolve a .cmd. Using
  // `shell: true` works but, with an args array, Node emits DEP0190 ("Passing
  // args to a child process with shell option true…") which leaks into the
  // engine output stream. Instead invoke cmd.exe directly (no shell) and let it
  // resolve claude(.cmd) via PATH. Args are static literals (auth/login/…), no
  // user input. Non-Windows is unchanged: spawn `claude` directly.
  const win = process.platform === 'win32';
  const command = win ? process.env.ComSpec || 'cmd.exe' : 'claude';
  const spawnArgs = win ? ['/d', '/s', '/c', 'claude', ...args] : args;
  const res = spawnSync(command, spawnArgs, {
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
  lines.push(`team relay: ${store.relay ? `linked (${store.relay.url})` : 'not linked — run `blox auth relay <url>`'}`);
  if (store.mode === 'apiKey' && !store.apiKey) {
    lines.push('note: mode is apiKey but no key stored — runs fall back to subscription');
  }
  return lines.join('\n');
}

export interface AuthInfo {
  mode: AuthMode;
  label: string;
}

// Compact active-credential summary for the dock chip. Reads the store (cheap)
// and only shells `claude auth status` when subscription mode is active.
export function authInfo(
  opts: { override?: AuthMode | null; store?: AuthStore; runner?: ClaudeRunner } = {},
): AuthInfo {
  const store = opts.store ?? loadAuthStore();
  const mode = effectiveAuthMode(store, opts.override);
  if (mode === 'apiKey') return { mode, label: 'API key' };
  if (mode === 'relay') return { mode, label: 'Team relay' };
  const sub = readSubscriptionStatus(opts.runner ?? defaultRunner);
  if ('error' in sub || !sub.loggedIn) return { mode: 'subscription', label: 'Subscription — not linked' };
  return { mode: 'subscription', label: sub.plan ? `Subscription (${sub.plan})` : 'Subscription' };
}

export type RelayCheck =
  | { ok: true; member?: string }
  | { ok: false; reason: 'unreachable' | 'token' | 'policy'; message: string };

// Ask the relay, before any model call, whether this member may run this model
// now (token valid, model allowed, team budget not spent). The relay answers
// with the same rules it enforces on /v1/messages.
export async function checkRelay(link: RelayLink, model: string | null, fetchImpl: typeof fetch = fetch): Promise<RelayCheck> {
  const url = `${link.url}/api/v1/check${model ? `?model=${encodeURIComponent(model)}` : ''}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { 'x-api-key': link.token }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    return { ok: false, reason: 'unreachable', message: `team relay unreachable at ${link.url} (${(e as Error).message})` };
  }
  let body: { member?: string; error?: { message?: string } | string } = {};
  try { body = (await res.json()) as typeof body; } catch { /* non-JSON */ }
  const msg = typeof body.error === 'string' ? body.error : body.error?.message ?? `HTTP ${res.status}`;
  if (res.status === 401) return { ok: false, reason: 'token', message: `team relay rejected your member token (${msg}); ask your admin for a new one, then \`blox auth relay ${link.url}\`` };
  if (res.status === 403) return { ok: false, reason: 'policy', message: `team relay policy: ${msg}` };
  if (res.status === 404) return { ok: false, reason: 'unreachable', message: `${link.url} is not a blox relay (or is older than this client)` };
  if (!res.ok) return { ok: false, reason: 'unreachable', message: `team relay error at ${link.url}: ${msg}` };
  return { ok: true, member: body.member };
}

// The team relay's usage summary (member-auth'd). Throws a user-facing error.
export async function fetchRelayUsage(link: RelayLink, sinceDays: number | null, fetchImpl: typeof fetch = fetch): Promise<UsageSummary> {
  const url = `${link.url}/api/v1/usage${sinceDays ? `?since=${sinceDays}d` : ''}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { 'x-api-key': link.token }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new Error(`team relay unreachable at ${link.url} (${(e as Error).message})`);
  }
  const body = (await res.json().catch(() => ({}))) as UsageSummary & { error?: { message?: string } };
  if (!res.ok) throw new Error(`team relay usage: ${body.error?.message ?? `HTTP ${res.status}`}`);
  return { ...body, source: 'relay' };
}

// Run-start credential gate: null when the run may proceed, else the
// user-facing reason. The Agent SDK retries a rejected credential (401) silently
// for minutes, so check it first. Relay mode asks the relay (token, model,
// budget); API-key mode asks Anthropic's free model list. A check that can't
// reach the server lets the run proceed.
export async function authPreflight(
  opts: { override?: AuthMode | null; model: string; runner: 'claude' | 'openai' | 'codex'; store?: AuthStore; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv },
): Promise<string | null> {
  const store = opts.store ?? loadAuthStore();
  const mode = effectiveAuthMode(store, opts.override);
  if (mode === 'apiKey') {
    if (opts.runner !== 'claude' || opts.model.includes(',')) return null; // the key isn't used
    const base = ((opts.env ?? process.env).ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
    try {
      const res = await (opts.fetchImpl ?? fetch)(`${base}/v1/models?limit=1`, {
        headers: { 'x-api-key': store.apiKey!, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401) return 'the stored Anthropic API key was rejected (401); set a new one with `blox auth key set`, or `blox auth use subscription`';
    } catch {
      /* unreachable: let the run report its own error */
    }
    return null;
  }
  if (mode !== 'relay') return null;
  if (opts.runner !== 'claude') return `team relay mode routes Claude runs only; --runner ${opts.runner} would bypass it (switch with \`blox auth use subscription|key\`)`;
  if (opts.model.includes(',')) return `team relay mode routes Claude runs only; the routed model "${opts.model}" would bypass it`;
  const r = await checkRelay(store.relay!, opts.model, opts.fetchImpl);
  return r.ok ? null : r.message;
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

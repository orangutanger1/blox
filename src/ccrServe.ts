import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { ccrEndpoint, readCcrModels } from './ccr.js';

// Probe CCR's inbound endpoint. Any HTTP response (even a 404) means the router
// is up; only a refused connection / timeout throws. `ccr status` is unreliable
// (reports "Not Running" while the port is live), so we check the port directly.
export type CcrFetchFn = (url: string) => Promise<unknown>;
const defaultFetch: CcrFetchFn = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });

export async function ccrReachable(baseUrl: string, fetchFn: CcrFetchFn = defaultFetch): Promise<boolean> {
  try {
    await fetchFn(baseUrl);
    return true;
  } catch {
    return false;
  }
}

// Fire-and-forget launcher for the CCR service. Detached + unref'd so the router
// outlives this run (it's a shared process). Injected for tests.
export type CcrSpawnFn = () => void;
const realCcrSpawn: CcrSpawnFn = () => {
  // windowsHide: the engine is forked from a GUI Electron app with no console,
  // so a console-subsystem child flashes a cmd window unless suppressed.
  // shell on win32: npm installs `ccr.cmd`, which Node's spawn won't resolve
  // without a shell → silent ENOENT, CCR never starts, routed runs exit 1.
  // Args are static literals, so shell injection isn't a concern (cf. PR #5).
  const child = nodeSpawn('ccr', ['start'], {
    detached: true, stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32',
  });
  // Swallow spawn errors (e.g. ENOENT when ccr isn't installed) — an unhandled
  // child 'error' would throw and crash the daemon. The poll loop times out and
  // reports failure instead.
  child.on('error', () => {});
  child.unref();
};

export interface EnsureCcrOptions {
  fetchFn?: CcrFetchFn;
  spawn?: CcrSpawnFn;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Ensure CCR is up before a routed run: reachable → done; otherwise spawn
// `ccr start` and poll until the port answers (~10s). Returns false if it never
// comes up — the caller logs and proceeds (the run will surface the real error).
// `log` mirrors progress to the dock so the user sees why launch is paused.
export async function ensureCcr(log: (msg: string) => void = () => {}, opts: EnsureCcrOptions = {}): Promise<boolean> {
  const ep = ccrEndpoint();
  const fetchFn = opts.fetchFn ?? defaultFetch;
  if (await ccrReachable(ep.baseUrl, fetchFn)) return true;

  log(`CCR router down at ${ep.baseUrl} — starting it…`);
  (opts.spawn ?? realCcrSpawn)();

  const attempts = opts.attempts ?? 20;
  const delayMs = opts.delayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  for (let i = 0; i < attempts; i++) {
    if (await ccrReachable(ep.baseUrl, fetchFn)) {
      log('CCR router ready.');
      return true;
    }
    await sleep(delayMs);
  }
  log('CCR router did not come up — is claude-code-router installed (npm i -g @musistudio/claude-code-router)?');
  return false;
}

// Doctor snapshot of CCR: is it reachable, and what does its config advertise.
export interface CcrStatus {
  reachable: boolean;
  baseUrl: string;
  provider: string | null;
  modelCount: number;
  current: string | null;
}

export async function ccrStatus(fetchFn: CcrFetchFn = defaultFetch): Promise<CcrStatus> {
  const ep = ccrEndpoint();
  const models = readCcrModels();
  return {
    reachable: await ccrReachable(ep.baseUrl, fetchFn),
    baseUrl: ep.baseUrl,
    provider: models.provider,
    modelCount: models.models.length,
    current: models.current,
  };
}

export function formatCcrStatus(s: CcrStatus): string {
  // No provider configured → blox runs native Claude; CCR is irrelevant.
  if (!s.provider && s.modelCount === 0) {
    return [
      `  router:  NO CCR CONFIG (${s.baseUrl})`,
      '  detail:  native Claude only (no ~/.claude-code-router provider) — fine unless you want BYO models',
    ].join('\n');
  }
  const head = s.reachable
    ? `  router:  CCR REACHABLE (${s.baseUrl})`
    : `  router:  CCR CONFIGURED, DOWN (${s.baseUrl})`;
  return [
    head,
    `  provider: ${s.provider ?? '?'}`,
    `  models:   ${s.modelCount} (default ${s.current ?? '?'})`,
    s.reachable
      ? '  detail:  routed runs ready'
      : '  detail:  the daemon auto-starts it on a routed run (ensureCcr); or `ccr start`',
  ].join('\n');
}

// Env for a routed run's model call. For a CCR-routed model, point the Agent SDK
// at CCR (ANTHROPIC_BASE_URL) with the x-api-key path and no competing bearer
// token. For a bare model return undefined so the run uses inherited env unchanged.
export function ccrRunEnv(useCcr: boolean): Record<string, string> | undefined {
  if (!useCcr) return undefined;
  const ep = ccrEndpoint();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.ANTHROPIC_BASE_URL = ep.baseUrl;
  env.ANTHROPIC_API_KEY = ep.apiKey;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export interface InstallDeps {
  probe?: (bin: string) => boolean; // is `bin` resolvable on PATH
  install?: () => boolean; // run the one-time global install, return success
}

// Install-on-first-use for CCR: present on PATH → done; otherwise `npm i -g
// @musistudio/claude-code-router` once. Returns whether ccr is available after.
// Both effects injected so this unit tests without touching the machine.
export function ensureCcrInstalled(log: (m: string) => void = () => {}, deps: InstallDeps = {}): boolean {
  // windowsHide on both spawns: from a GUI-forked engine each console child
  // (where/npm via cmd) flashes a window otherwise — the popup users hit on add.
  const probe = deps.probe ?? ((bin: string) =>
    spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore', windowsHide: true }).status === 0);
  if (probe('ccr')) return true;

  log('Installing claude-code-router (one-time)…');
  const install = deps.install ?? (() =>
    spawnSync('npm', ['i', '-g', '@musistudio/claude-code-router'],
      { stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true }).status === 0);
  if (install()) { log('claude-code-router installed.'); return true; }

  log('Could not auto-install. Install it manually: npm i -g @musistudio/claude-code-router');
  return false;
}

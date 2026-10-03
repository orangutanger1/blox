import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

// JSON-RPC client for `codex app-server` (stdio, newline-delimited JSON).
// The ChatGPT sign-in stays inside Codex; blox never sees a token.
//
// Codex runs with a CODEX_HOME blox owns (~/.config/blox/codex), so the user's
// own Codex config (MCP servers, plugins, hooks, instructions) never loads in
// a blox run, and with its own acting features off: every action must go
// through blox's tools, gates and guardrails. The runner also stops any turn
// that starts a built-in item anyway (see codexRunner.ts).

type Json = Record<string, unknown>;
export interface Notification { method: string; params: Json }
export interface ServerRequest extends Notification { id: number | string }
export type RequestHandler = (r: ServerRequest) => Promise<unknown | undefined>;

// `-c features.<x>=false` rather than `--disable`: Codex rejects an unknown
// --disable but ignores an unknown features key, so older/newer Codex starts.
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external',
  'computer_use', 'in_app_browser', 'image_generation', 'multi_agent', 'multi_agent_v2', 'hooks', 'memories',
  'tool_suggest', 'skill_mcp_dependency_install', 'web_search_request',
];

export function codexArgs(): string[] {
  return ['app-server', ...DISABLED_FEATURES.flatMap((f) => ['-c', `features.${f}=false`]), '--stdio'];
}

export function bloxCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.BLOX_CODEX_HOME ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'blox', 'codex');
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface AppServerOptions {
  executable?: string;
  cwd?: string;
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  // Tests: a fake server process.
  spawnProcess?: () => ChildProcessWithoutNullStreams;
}

export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 0;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(n: Notification) => void>();
  private readonly handlers = new Set<RequestHandler>();
  private readonly closeListeners = new Set<(e: Error) => void>();
  private stderrTail = '';

  constructor(private readonly o: AppServerOptions = {}) {}

  start(): Promise<void> {
    this.starting ??= this.startInternal().catch((e: Error) => {
      this.stop(e);
      throw e;
    });
    return this.starting;
  }

  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    await this.start();
    return this.send<T>(method, params);
  }

  subscribe(l: (n: Notification) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  handleRequests(h: RequestHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  onClose(l: (e: Error) => void): () => void {
    this.closeListeners.add(l);
    return () => this.closeListeners.delete(l);
  }

  // { email, planType } when signed in with ChatGPT, else null.
  async account(): Promise<{ email?: string; planType?: string } | null> {
    const r = await this.request<Json>('account/read', { refreshToken: false });
    const a = isObj(r) ? r.account : null;
    if (!isObj(a) || a.type !== 'chatgpt') return null;
    return { ...(typeof a.email === 'string' ? { email: a.email } : {}), ...(typeof a.planType === 'string' ? { planType: a.planType } : {}) };
  }

  close(): void {
    this.stop(new Error('Codex app-server closed.'));
  }

  private async startInternal(): Promise<void> {
    const home = this.o.codexHome ?? bloxCodexHome(this.o.env);
    let child: ChildProcessWithoutNullStreams;
    if (this.o.spawnProcess) child = this.o.spawnProcess();
    else {
      mkdirSync(home, { recursive: true }); // Codex refuses a missing CODEX_HOME
      const env = { ...(this.o.env ?? process.env), CODEX_HOME: home };
      child = spawn(this.o.executable ?? 'codex', codexArgs(), {
        cwd: this.o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        // npm's codex is a .cmd shim on native Windows (see blox-windows-spawn-bugs)
        shell: process.platform === 'win32',
      });
    }
    this.child = child;
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => this.receive(l));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (this.stderrTail = (this.stderrTail + c).slice(-2000)));
    child.stdin.on('error', (e) => this.stop(e));
    child.once('exit', (code, sig) => this.stop(new Error(`Codex app-server exited (${sig ?? code}).${this.stderrTail.trim() ? ` ${this.stderrTail.trim()}` : ''}`)));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (e: NodeJS.ErrnoException) =>
        reject(e.code === 'ENOENT' ? new Error('codex not found: install it with `npm i -g @openai/codex`, then `blox auth codex`') : e));
    });
    await this.send('initialize', { clientInfo: { name: 'blox', title: 'blox', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.write({ jsonrpc: '2.0', method: 'initialized', params: {} });
  }

  private receive(line: string): void {
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObj(m)) return;
    const id = m.id as number | string | undefined;
    if (id !== undefined && typeof m.method === 'string') {
      void this.dispatch({ id, method: m.method, params: isObj(m.params) ? m.params : {} });
    } else if (id !== undefined) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (m.error !== undefined) p.reject(new Error(isObj(m.error) && typeof m.error.message === 'string' ? m.error.message : 'Codex app-server error'));
      else p.resolve(m.result);
    } else if (typeof m.method === 'string') {
      const n = { method: m.method, params: isObj(m.params) ? m.params : {} };
      for (const l of this.listeners) l(n);
    }
  }

  private async dispatch(r: ServerRequest): Promise<void> {
    for (const h of this.handlers) {
      try {
        const result = await h(r);
        if (result !== undefined) return this.reply({ id: r.id, result });
      } catch (e) {
        return this.reply({ id: r.id, error: { code: -32000, message: (e as Error).message } });
      }
    }
    this.reply({ id: r.id, error: { code: -32601, message: `unsupported request: ${r.method}` } });
  }

  private reply(m: Json): void {
    try {
      this.write({ jsonrpc: '2.0', ...m });
    } catch {
      /* server gone; its close already failed the run */
    }
  }

  private send<T>(method: string, params: unknown): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private write(m: Json): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex app-server is not running.');
    this.child.stdin.write(`${JSON.stringify(m)}\n`);
  }

  private stop(e: Error): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.starting = null;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    child.stdin.destroy();
    child.kill();
    for (const l of this.closeListeners) l(e);
  }
}

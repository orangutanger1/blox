import { isSessionLocked, pressStudioPlay, restoreStudioWindow } from './host.js';
import type { StudioLaunch } from '../bridge/types.js';
import { resolveStudioLaunch } from './launcher.js';

// One long-lived connection to Roblox Studio's MCP proxy, shared by every blox
// capability (sync, tests, playtest, passthrough tools). Owns the three things
// that made raw Studio MCP brittle for agents:
//   1. attach race — the proxy answers instantly but Studio's websocket attaches
//      every ~5s, so a cold call gets "no studio". We poll list_roblox_studios.
//   2. studio_id — since the Aug 2026 Studio MCP update every tool requires a
//      studio_id. The session picks the target once and injects it.
//   3. transient "no studio"/disconnect errors — retried once after re-attach.

export interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface RawToolResult {
  content?: ContentBlock[];
  isError?: boolean;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
}

export interface McpClientLike {
  listTools(): Promise<{ tools: ToolInfo[] }>;
  callTool(req: { name: string; arguments: Record<string, unknown> }, timeoutMs: number): Promise<RawToolResult>;
  close(): Promise<void>;
}

export type McpConnector = (launch: StudioLaunch) => Promise<McpClientLike>;

export const realConnector: McpConnector = async (launch) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    ...(launch.cwd ? { cwd: launch.cwd } : {}),
    stderr: 'ignore',
  });
  const client = new Client({ name: 'blox', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    listTools: () => client.listTools() as Promise<{ tools: ToolInfo[] }>,
    callTool: (req, timeoutMs) =>
      client.callTool(req, undefined, { timeout: timeoutMs }) as Promise<RawToolResult>,
    close: () => client.close(),
  };
};

export interface StudioInfo {
  id: string;
  name: string | null;
}

export type DataModelContext = 'edit' | 'server' | 'client';

export interface StudioState {
  mode: 'Edit' | 'Play' | 'Run' | 'Unknown';
  dataModels: string[];
  raw: string;
}

export class StudioError extends Error {
  constructor(
    readonly code: 'not_connected' | 'no_studio' | 'ambiguous_studio' | 'tool_error' | 'wrong_mode' | 'timeout' | 'play_blocked',
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const NO_STUDIO_RE =
  /no active studio|unable to find an active studio|no studio available|no (roblox )?studio instance|studio .*not (found|connected)|not connected to studio|invalid studio/i;

export interface StudioSessionOptions {
  launch?: StudioLaunch;
  connector?: McpConnector;
  // Pick a Studio whose name contains this (case-insensitive) or whose id equals it.
  match?: string;
  // Route server/client runLuau through the dock plugin's eval bridge
  // (blox.config.json bridge.eval).
  evalBridge?: boolean;
  attachTimeoutMs?: number;
  callTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function selectStudio(studios: StudioInfo[], match?: string): StudioInfo {
  if (studios.length === 0) {
    throw new StudioError(
      'no_studio',
      'No Roblox Studio instance is attached to the MCP server.',
      'Open Roblox Studio with a place, and enable Assistant → Settings → "Studio as MCP server". Studio re-attaches every ~5s. Still nothing? `blox doctor` checks for a process blocking Studio\'s MCP port.',
    );
  }
  if (match) {
    const m = match.toLowerCase();
    const hit = studios.find((s) => s.id === match || (s.name ?? '').toLowerCase().includes(m));
    if (hit) return hit;
    throw new StudioError(
      'ambiguous_studio',
      `No attached Studio matches "${match}". Attached: ${studios.map((s) => `${s.name ?? '(unnamed)'} [${s.id}]`).join(', ')}`,
      'Fix studio.match in blox.config.json or BLOX_STUDIO.',
    );
  }
  if (studios.length > 1) {
    throw new StudioError(
      'ambiguous_studio',
      `${studios.length} Studio instances attached: ${studios.map((s) => `${s.name ?? '(unnamed)'} [${s.id}]`).join(', ')}`,
      'Set studio.match in blox.config.json (or BLOX_STUDIO) to a name substring or id.',
    );
  }
  return studios[0];
}

export function parseStudioState(text: string): StudioState {
  const mode = /Current Studio Mode:\s*(\w+)/i.exec(text)?.[1] ?? 'Unknown';
  const dms = /Available DataModels:\s*([^\n]+)/i.exec(text)?.[1] ?? '';
  return {
    mode: (['Edit', 'Play', 'Run'].includes(mode) ? mode : 'Unknown') as StudioState['mode'],
    dataModels: dms.split(',').map((s) => s.trim()).filter(Boolean),
    raw: text,
  };
}

export function resultText(r: RawToolResult): string {
  return (r.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
}

export class StudioSession {
  private client: McpClientLike | null = null;
  private connecting: Promise<McpClientLike> | null = null;
  private tools: ToolInfo[] = [];
  private studio: StudioInfo | null = null;
  private needsStudioId = true;
  private readonly opts: Required<Omit<StudioSessionOptions, 'match' | 'launch' | 'evalBridge'>> & Pick<StudioSessionOptions, 'match'>;
  readonly launch: StudioLaunch;
  readonly evalBridge: boolean;
  // Windows host probes (locked PC, minimised window, wedged Play); fakes leave them out.
  readonly host = { locked: () => isSessionLocked(), restore: () => restoreStudioWindow(), pressPlay: () => pressStudioPlay(this.studio?.name ?? null) };

  constructor(options: StudioSessionOptions = {}) {
    this.launch = options.launch ?? resolveStudioLaunch();
    this.evalBridge = options.evalBridge === true;
    this.opts = {
      connector: options.connector ?? realConnector,
      match: options.match ?? (process.env.BLOX_STUDIO || undefined),
      attachTimeoutMs: options.attachTimeoutMs ?? 20_000,
      callTimeoutMs: options.callTimeoutMs ?? 120_000,
      sleep: options.sleep ?? defaultSleep,
    };
  }

  private async connect(): Promise<McpClientLike> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        try {
          const c = await this.opts.connector(this.launch);
          const listed = await c.listTools();
          this.tools = listed.tools;
          // Older Studio builds (pre Aug 2026) take no studio_id; only inject it
          // when the live schema asks for it.
          const luau = this.tools.find((t) => t.name === 'execute_luau');
          this.needsStudioId = !!luau?.inputSchema?.properties && 'studio_id' in (luau.inputSchema.properties ?? {});
          this.client = c;
          return c;
        } catch (e) {
          throw new StudioError(
            'not_connected',
            `Cannot start the Studio MCP proxy (${this.launch.command}): ${(e as Error)?.message ?? String(e)}`,
            'Is Roblox Studio installed? Set BLOX_STUDIO_MCP_CMD to the StudioMCP executable to override.',
          );
        } finally {
          this.connecting = null;
        }
      })();
    }
    return this.connecting;
  }

  async listTools(): Promise<ToolInfo[]> {
    await this.connect();
    return this.tools;
  }

  async listStudios(): Promise<StudioInfo[]> {
    const c = await this.connect();
    const tool = this.tools.find((t) => t.name === 'list_roblox_studios');
    if (!tool) return [{ id: '', name: null }]; // pre-routing Studio: single implicit target
    const r = await c.callTool({ name: 'list_roblox_studios', arguments: {} }, 10_000);
    try {
      const j = JSON.parse(resultText(r)) as { studios?: { id: string; name?: string | null }[] };
      return (j.studios ?? []).map((s) => ({ id: s.id, name: s.name ?? null }));
    } catch {
      return [];
    }
  }

  // Wait for a Studio to attach (polling), then select one. Cached.
  async attach(): Promise<StudioInfo> {
    if (this.studio) return this.studio;
    const deadline = Date.now() + this.opts.attachTimeoutMs;
    let studios: StudioInfo[] = [];
    for (;;) {
      studios = await this.listStudios();
      if (studios.length > 0) break;
      if (Date.now() >= deadline) break;
      await this.opts.sleep(1000);
    }
    this.studio = selectStudio(studios, this.opts.match);
    return this.studio;
  }

  get attachedStudio(): StudioInfo | null {
    return this.studio;
  }

  // Call a raw Studio MCP tool, injecting studio_id and retrying once past a
  // "no studio" error (Studio restarted / re-attached with a new id).
  async call(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<RawToolResult> {
    const c = await this.connect();
    for (let attempt = 0; attempt < 2; attempt++) {
      const studio = await this.attach();
      const fullArgs = this.needsStudioId ? { ...args, studio_id: studio.id } : args;
      let r: RawToolResult;
      try {
        r = await c.callTool({ name, arguments: fullArgs }, timeoutMs ?? this.opts.callTimeoutMs);
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (/timed? ?out/i.test(msg)) throw new StudioError('timeout', `${name} timed out: ${msg}`);
        throw new StudioError('tool_error', `${name} failed: ${msg}`);
      }
      if (r.isError && NO_STUDIO_RE.test(resultText(r)) && attempt === 0) {
        this.studio = null; // re-select on the next loop
        continue;
      }
      return r;
    }
    throw new StudioError('no_studio', `${name}: Studio detached and did not re-attach`);
  }

  async state(): Promise<StudioState> {
    const r = await this.call('get_studio_state', {}, 15_000);
    return parseStudioState(resultText(r));
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.studio = null;
    await c?.close().catch(() => {});
  }
}

export function contextToDataModel(ctx: DataModelContext): 'Edit' | 'Server' | 'Client' {
  return ctx === 'edit' ? 'Edit' : ctx === 'server' ? 'Server' : 'Client';
}

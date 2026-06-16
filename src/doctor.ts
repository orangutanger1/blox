import type { StudioLaunch } from './bridge/types.js';

export interface CallToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

export interface DoctorClient {
  serverInfo(): { name?: string; version?: string } | undefined;
  listTools(): Promise<{ tools: { name: string }[] }>;
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type McpClientFactory = (launch: StudioLaunch) => Promise<DoctorClient>;

export interface DoctorReport {
  connected: boolean;
  serverName?: string;
  serverVersion?: string;
  toolCount?: number;
  tools?: string[];
  connectLatencyMs?: number;
  studioAttached?: boolean;
  probeLatencyMs?: number;
  detail: string;
}

// Default factory: real MCP stdio client over the launcher's cmd.exe->mcp.bat hop.
export const defaultClientFactory: McpClientFactory = async (launch) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    ...(launch.cwd ? { cwd: launch.cwd } : {}),
    // Silence the proxy's cmd.exe/mcp.bat chatter ("'else' is not recognized",
    // StudioMCP.exe lines, "No studio available" WARNs) — pure noise that made
    // a healthy `blox doctor` look broken. Real connect failures still surface
    // via the connect() rejection.
    stderr: 'ignore',
  });
  const client = new Client({ name: 'blox-doctor', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    serverInfo: () => client.getServerVersion() as { name?: string; version?: string } | undefined,
    listTools: () => client.listTools(),
    callTool: (req) => client.callTool(req) as Promise<CallToolResult>,
    close: () => client.close(),
  };
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

const NO_STUDIO = /no active studio|unable to find an active studio|no studio available/i;

export interface DoctorOptions {
  timeoutMs?: number;
  // The proxy answers instantly, but Studio attaches a beat later; retry the
  // execute_luau probe so a slow attach still registers as ATTACHED.
  probeAttempts?: number;
  probeDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LuauProbeResult {
  text: string;
  isError: boolean;
  attempts: number;
  attached: boolean;
}

// Run one execute_luau on an already-connected client, retrying past the
// proxy->Studio attach race ("no active studio") until attached or out of tries.
async function execLuauWithRetry(
  client: DoctorClient,
  luauTool: string,
  code: string,
  timeoutMs: number,
  probeAttempts: number,
  probeDelayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<LuauProbeResult> {
  let text = '';
  let isError = false;
  let attached = false;
  let attempt = 0;
  for (attempt = 1; attempt <= probeAttempts; attempt++) {
    const res = await withTimeout(
      // execute_luau requires a datamodel_type (Edit|Client|Server); the attach
      // probe runs in edit mode, so target the Edit datamodel.
      client.callTool({ name: luauTool, arguments: { code, datamodel_type: 'Edit' } }),
      timeoutMs, 'execute_luau',
    );
    text = (res.content ?? []).map((c) => c.text ?? '').join('').trim();
    isError = res.isError === true;
    attached = !isError && !NO_STUDIO.test(text);
    if (attached) break;
    if (attempt < probeAttempts) await sleep(probeDelayMs);
  }
  return { text, isError, attempts: attached ? attempt : probeAttempts, attached };
}

// Connect, run one execute_luau with attach-retry, close. Used by the live sync
// test to read a script's .Source; runDoctor uses execLuauWithRetry directly.
export async function probeExecuteLuau(
  launch: StudioLaunch,
  code: string,
  factory: McpClientFactory = defaultClientFactory,
  opts: DoctorOptions = {},
): Promise<LuauProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const probeAttempts = opts.probeAttempts ?? 8;
  const probeDelayMs = opts.probeDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  let client: DoctorClient | undefined;
  try {
    client = await withTimeout(factory(launch), timeoutMs, 'connect');
    const listed = await withTimeout(client.listTools(), timeoutMs, 'listTools');
    const luau = listed.tools.map((t) => t.name).find((n) => n.endsWith('execute_luau'));
    if (!luau) return { text: 'no execute_luau tool advertised', isError: true, attempts: 0, attached: false };
    return await execLuauWithRetry(client, luau, code, timeoutMs, probeAttempts, probeDelayMs, sleep);
  } catch (err) {
    return { text: `connect failed: ${(err as Error)?.message ?? String(err)}`, isError: true, attempts: 0, attached: false };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runDoctor(
  launch: StudioLaunch,
  factory: McpClientFactory = defaultClientFactory,
  opts: DoctorOptions = {},
): Promise<DoctorReport> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const probeAttempts = opts.probeAttempts ?? 8;
  const probeDelayMs = opts.probeDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;

  const t0 = Date.now();
  let client: DoctorClient | undefined;
  try {
    client = await withTimeout(factory(launch), timeoutMs, 'connect');
    const connectLatencyMs = Date.now() - t0;
    const info = client.serverInfo();
    const listed = await withTimeout(client.listTools(), timeoutMs, 'listTools');
    const tools = listed.tools.map((t) => t.name);

    const luau = tools.find((n) => n.endsWith('execute_luau'));
    if (!luau) {
      return {
        connected: true, serverName: info?.name, serverVersion: info?.version,
        toolCount: tools.length, tools, connectLatencyMs,
        detail: `proxy up: ${info?.name ?? '?'} v${info?.version ?? '?'}, ${tools.length} tools (no execute_luau advertised)`,
      };
    }

    const t1 = Date.now();
    const probe = await execLuauWithRetry(client, luau, 'return 1 + 1', timeoutMs, probeAttempts, probeDelayMs, sleep);
    const probeLatencyMs = Date.now() - t1;
    const studioAttached = probe.attached;
    const detail = studioAttached
      ? `Studio attached; execute_luau -> ${probe.text}`
      : `proxy up but no Studio attached after ${probe.attempts} probe(s): ${probe.text || '(isError)'}`;

    return {
      connected: true, serverName: info?.name, serverVersion: info?.version,
      toolCount: tools.length, tools, connectLatencyMs, studioAttached, probeLatencyMs, detail,
    };
  } catch (err) {
    return { connected: false, detail: `cannot reach Studio MCP: ${(err as Error)?.message ?? String(err)}` };
  } finally {
    await client?.close().catch(() => {});
  }
}

export function formatDoctorReport(r: DoctorReport): string {
  if (!r.connected) {
    return ['blox doctor', '  status:  NOT CONNECTED', `  detail:  ${r.detail}`].join('\n');
  }
  const lines = [
    'blox doctor',
    '  status:  CONNECTED (proxy)',
    `  server:  ${r.serverName ?? '?'} v${r.serverVersion ?? '?'}`,
    `  tools:   ${r.toolCount ?? 0} tools`,
    `  connect: ${r.connectLatencyMs ?? '?'}ms`,
  ];
  if (r.studioAttached !== undefined) {
    lines.push(`  studio:  ${r.studioAttached ? 'ATTACHED' : 'NOT ATTACHED'}`);
    if (r.probeLatencyMs !== undefined) lines.push(`  probe:   ${r.probeLatencyMs}ms`);
  }
  lines.push(`  detail:  ${r.detail}`);
  return lines.join('\n');
}

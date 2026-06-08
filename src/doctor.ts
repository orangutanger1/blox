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

export async function runDoctor(
  launch: StudioLaunch,
  factory: McpClientFactory = defaultClientFactory,
  timeoutMs = 20_000,
): Promise<DoctorReport> {
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
    const res = await withTimeout(
      client.callTool({ name: luau, arguments: { code: 'return 1 + 1' } }),
      timeoutMs, 'execute_luau',
    );
    const probeLatencyMs = Date.now() - t1;
    const text = (res.content ?? []).map((c) => c.text ?? '').join('').trim();
    const studioAttached = res.isError !== true && !NO_STUDIO.test(text);
    const detail = studioAttached
      ? `Studio attached; execute_luau -> ${text}`
      : `proxy up but no Studio attached: ${text || '(isError)'}`;

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

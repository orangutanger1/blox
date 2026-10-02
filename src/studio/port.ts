import { execFile } from 'node:child_process';

// Studio's MCP channel: StudioMCP.exe listens on this port and Studio's plugin
// connects to it (Studio registers once per boot). Two failure modes are silent
// and look like "proxy up, 0 tools / no Studio attached":
//   - squatter: a non-Roblox process listens here, so Studio registers with it.
//   - orphan:   a StudioMCP.exe left over from a crash listens here with no
//               Studio running; Studio's next boot registers with the leftover.
// Windows-only (also reachable from WSL via the .exe interop).
export const STUDIO_MCP_PORT = 13469;

export type Exec = (cmd: string, args: string[]) => Promise<string>;

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (_err, stdout) => resolve(String(stdout ?? '')));
  });

// PIDs LISTENING on `port` in `netstat -ano` output (IPv4 and IPv6 rows).
export function parseNetstatListeners(out: string, port: number): string[] {
  const pids = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[3] !== 'LISTENING') continue;
    if (!cols[1].endsWith(`:${port}`)) continue;
    if (/^\d+$/.test(cols[4])) pids.add(cols[4]);
  }
  return [...pids];
}

// Image names from `tasklist /FO CSV /NH` output, keyed by PID.
export function parseTasklist(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const cells = [...line.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    if (cells.length >= 2 && /^\d+$/.test(cells[1])) m.set(cells[1], cells[0]);
  }
  return m;
}

export interface PortOwner {
  pid: string;
  name: string;
}

export interface PortReport {
  checked: boolean;
  owners: PortOwner[];
  studioRunning: boolean;
  issue: 'none' | 'squatter' | 'orphan';
  detail: string;
}

export function classifyPort(owners: PortOwner[], studioRunning: boolean): Pick<PortReport, 'issue' | 'detail'> {
  const squatter = owners.find((o) => !/^(studiomcp|robloxstudio)/i.test(o.name));
  if (squatter) {
    return {
      issue: 'squatter',
      detail:
        `port ${STUDIO_MCP_PORT} is held by a non-Roblox process: ${squatter.name} (pid ${squatter.pid}). ` +
        'Studio registers with it instead of StudioMCP, so no tools work. Close it, then toggle ' +
        'Assistant → Settings → "Studio as MCP server" off and on.',
    };
  }
  const proxy = owners.find((o) => /^studiomcp/i.test(o.name));
  if (proxy && !studioRunning) {
    return {
      issue: 'orphan',
      detail:
        `leftover StudioMCP.exe (pid ${proxy.pid}) holds port ${STUDIO_MCP_PORT} with no Studio running. ` +
        'The next Studio boot would register with it. Run `blox doctor --fix` to kill it.',
    };
  }
  return { issue: 'none', detail: owners.length ? `port ${STUDIO_MCP_PORT}: ${owners.map((o) => o.name).join(', ')}` : `port ${STUDIO_MCP_PORT}: no listener (normal while no MCP proxy runs)` };
}

const isWindowsHost = (platform: NodeJS.Platform) => platform === 'win32' || platform === 'linux';

export async function checkStudioPort(
  opts: { platform?: NodeJS.Platform; exec?: Exec } = {},
): Promise<PortReport> {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? defaultExec;
  const suffix = platform === 'win32' ? '' : '.exe';
  if (!isWindowsHost(platform)) {
    return { checked: false, owners: [], studioRunning: false, issue: 'none', detail: 'port check skipped (not Windows)' };
  }
  const netstat = await exec(`netstat${suffix}`, ['-ano']);
  if (!netstat) {
    return { checked: false, owners: [], studioRunning: false, issue: 'none', detail: 'port check skipped (netstat unavailable)' };
  }
  const names = parseTasklist(await exec(`tasklist${suffix}`, ['/FO', 'CSV', '/NH']));
  const owners = parseNetstatListeners(netstat, STUDIO_MCP_PORT).map((pid) => ({ pid, name: names.get(pid) ?? '?' }));
  const studioRunning = [...names.values()].some((n) => /^robloxstudio(beta)?\.exe$/i.test(n));
  return { checked: true, owners, studioRunning, ...classifyPort(owners, studioRunning) };
}

// Kill an orphaned StudioMCP.exe. Only ever acts on the orphan case (no Studio
// running), where the proxy cannot be serving anyone's live session.
export async function fixOrphanProxy(
  report: PortReport,
  opts: { platform?: NodeJS.Platform; exec?: Exec } = {},
): Promise<string | null> {
  if (report.issue !== 'orphan') return null;
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? defaultExec;
  const suffix = platform === 'win32' ? '' : '.exe';
  const killed: string[] = [];
  for (const o of report.owners.filter((x) => /^studiomcp/i.test(x.name))) {
    await exec(`taskkill${suffix}`, ['/F', '/PID', o.pid]);
    killed.push(o.pid);
  }
  return `killed leftover StudioMCP.exe (pid ${killed.join(', ')})`;
}

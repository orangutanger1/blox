import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { StudioLaunch } from '../bridge/types.js';

// Resolve how to launch Roblox's StudioMCP proxy.
//
// Why not just `%LOCALAPPDATA%\Roblox\mcp.bat`? Studio writes that batch file
// with a hardcoded version directory and does not always rewrite it when it
// auto-updates. Observed 2026-09-30: after an update the bat (and the
// ContentFolder registry key its fallback branch reads) pointed at a deleted
// version dir, so every MCP connection died with "Connection closed". The
// StudioMCP.exe inside the newest Versions/<hash>/ dir is always the right one,
// so resolve that directly and keep mcp.bat only as a last resort.

export interface LauncherEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  // Injected for tests: list candidate Roblox data dirs (each has a Versions/).
  robloxDirs?: () => string[];
}

function defaultRobloxDirs(platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  if (env.BLOX_ROBLOX_DIR) return [env.BLOX_ROBLOX_DIR];
  if (platform === 'win32') return env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Roblox')] : [];
  if (platform === 'linux') {
    // WSL: the Windows user profile lives under /mnt/c/Users/<name>.
    const users = '/mnt/c/Users';
    if (!existsSync(users)) return [];
    try {
      return readdirSync(users)
        .map((u) => join(users, u, 'AppData', 'Local', 'Roblox'))
        .filter((d) => existsSync(join(d, 'Versions')));
    } catch {
      return [];
    }
  }
  return [];
}

const STUDIO_EXES = ['RobloxStudioBeta.exe', 'RobloxStudio.exe'];

// Newest (by mtime) Versions/<hash>/StudioMCP.exe across the candidate dirs.
// Studio updates can leave "zombie" version dirs that still hold StudioMCP.exe
// but no Studio exe; that proxy launches fine yet never sees a Studio (0 tools).
// Prefer dirs that also contain a Studio exe; zombies are a last resort.
export function findStudioMcpExe(dirs: string[]): string | null {
  let paired: { path: string; mtime: number } | null = null;
  let orphan: { path: string; mtime: number } | null = null;
  for (const dir of dirs) {
    const versions = join(dir, 'Versions');
    let entries: string[] = [];
    try {
      entries = readdirSync(versions);
    } catch {
      continue;
    }
    for (const v of entries) {
      const exe = join(versions, v, 'StudioMCP.exe');
      try {
        const st = statSync(exe);
        const live = STUDIO_EXES.some((n) => existsSync(join(versions, v, n)));
        const best = live ? paired : orphan;
        if (!best || st.mtimeMs > best.mtime) {
          if (live) paired = { path: exe, mtime: st.mtimeMs };
          else orphan = { path: exe, mtime: st.mtimeMs };
        }
      } catch {
        /* no proxy in this version dir */
      }
    }
  }
  return (paired ?? orphan)?.path ?? null;
}

export function resolveStudioLaunch(le: LauncherEnv = { platform: process.platform, env: process.env }): StudioLaunch {
  const { platform, env } = le;
  if (env.BLOX_STUDIO_MCP_CMD) {
    const args = (env.BLOX_STUDIO_MCP_ARGS ?? '').split(' ').filter(Boolean);
    return { command: env.BLOX_STUDIO_MCP_CMD, args };
  }
  if (platform === 'darwin') {
    return { command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP', args: [] };
  }
  const dirs = le.robloxDirs ? le.robloxDirs() : defaultRobloxDirs(platform, env);
  const exe = findStudioMcpExe(dirs);
  // A Windows-side cwd: spawning a Windows exe from a \\wsl.localhost cwd makes
  // cmd/Windows tooling warn about UNC paths; native win32 has no /mnt/c.
  const cwd = env.BLOX_STUDIO_MCP_CWD ?? (platform === 'win32' ? env.SystemRoot ?? 'C:\\' : '/mnt/c');
  if (exe) return { command: exe, args: [], cwd };
  return { command: 'cmd.exe', args: ['/c', '%LOCALAPPDATA%\\Roblox\\mcp.bat'], cwd };
}

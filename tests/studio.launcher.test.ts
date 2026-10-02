import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findStudioMcpExe, resolveStudioLaunch } from '../src/studio/launcher.js';

// Each version dir gets StudioMCP.exe (mtime given; null = none) plus
// RobloxStudioBeta.exe unless listed in `zombies` (update left the proxy behind).
function robloxDir(versions: Record<string, number | null>, zombies: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'blox-roblox-'));
  for (const [v, mtime] of Object.entries(versions)) {
    const d = join(root, 'Versions', v);
    mkdirSync(d, { recursive: true });
    if (mtime !== null) {
      const exe = join(d, 'StudioMCP.exe');
      writeFileSync(exe, '');
      utimesSync(exe, mtime, mtime);
    }
    if (!zombies.includes(v)) writeFileSync(join(d, 'RobloxStudioBeta.exe'), '');
  }
  return root;
}

describe('findStudioMcpExe', () => {
  it('picks the newest StudioMCP.exe across version dirs (stale mcp.bat case)', () => {
    const dir = robloxDir({ 'version-old': 1000, 'version-new': 2000, 'version-noexe': null });
    expect(findStudioMcpExe([dir])).toBe(join(dir, 'Versions', 'version-new', 'StudioMCP.exe'));
  });
  it('skips a newer zombie version dir that has no Studio exe', () => {
    const dir = robloxDir({ 'version-live': 1000, 'version-zombie': 2000 }, ['version-zombie']);
    expect(findStudioMcpExe([dir])).toBe(join(dir, 'Versions', 'version-live', 'StudioMCP.exe'));
  });
  it('falls back to a zombie proxy when no paired install exists', () => {
    const dir = robloxDir({ 'version-zombie': 2000 }, ['version-zombie']);
    expect(findStudioMcpExe([dir])).toBe(join(dir, 'Versions', 'version-zombie', 'StudioMCP.exe'));
  });
  it('returns null when nothing is installed', () => {
    expect(findStudioMcpExe([join(tmpdir(), 'definitely-missing-blox')])).toBeNull();
  });
});

describe('resolveStudioLaunch', () => {
  it('honors BLOX_STUDIO_MCP_CMD + args', () => {
    const l = resolveStudioLaunch({ platform: 'linux', env: { BLOX_STUDIO_MCP_CMD: 'x', BLOX_STUDIO_MCP_ARGS: 'a b' } });
    expect(l).toEqual({ command: 'x', args: ['a', 'b'] });
  });
  it('uses the resolved exe with a Windows-side cwd on WSL', () => {
    const dir = robloxDir({ v1: 5000 });
    const l = resolveStudioLaunch({ platform: 'linux', env: {}, robloxDirs: () => [dir] });
    expect(l.command).toBe(join(dir, 'Versions', 'v1', 'StudioMCP.exe'));
    expect(l.cwd).toBe('/mnt/c');
  });
  it('falls back to mcp.bat when no exe is found', () => {
    const l = resolveStudioLaunch({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, robloxDirs: () => [] });
    expect(l.command).toBe('cmd.exe');
    expect(l.args.join(' ')).toContain('mcp.bat');
    expect(l.cwd).toBe('C:\\Windows');
  });
  it('uses the fixed macOS path', () => {
    expect(resolveStudioLaunch({ platform: 'darwin', env: {} }).command).toContain('StudioMCP');
  });
});

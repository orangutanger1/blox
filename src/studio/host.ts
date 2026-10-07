import { execFile } from 'node:child_process';
import { release } from 'node:os';

// Windows-side facts about the PC Studio runs on, read through PowerShell
// (from WSL or native Windows). A probe that fails or times out answers
// "unknown", which callers treat as the harmless case.

export type PsRun = (script: string, timeoutMs: number) => Promise<string | null>;

export function hostKind(h: { platform: string; release: string } = { platform: process.platform, release: release() }): 'wsl' | 'win32' | 'other' {
  if (h.platform === 'win32') return 'win32';
  if (h.platform === 'linux' && /microsoft/i.test(h.release)) return 'wsl';
  return 'other';
}

// BLOX_HOST_PROBES=0 turns the probes off (the test suite sets it).
export const runPowerShell: PsRun = (script, timeoutMs) =>
  hostKind() === 'other' || process.env.BLOX_HOST_PROBES === '0'
    ? Promise.resolve(null)
    : new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeoutMs, windowsHide: true }, (err, stdout) =>
          resolve(err ? null : String(stdout).trim()),
        );
      });

const LOCK_PS = 'if (Get-Process LogonUI -ErrorAction SilentlyContinue) { "LOCKED" }';

// LogonUI runs while the session is locked or at the sign-in screen; Studio
// cannot enter Play then.
export async function isSessionLocked(run: PsRun = runPowerShell): Promise<boolean> {
  try {
    return (await run(LOCK_PS, 5000))?.includes('LOCKED') ?? false;
  } catch {
    return false;
  }
}

const RESTORE_PS = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class BloxW { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); }
"@
Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { if ([BloxW]::IsIconic($_.MainWindowHandle)) { [BloxW]::ShowWindow($_.MainWindowHandle, 9) | Out-Null; "restored" } else { "ok" } }`;

// A minimised Studio renders nothing: captures come back blank and Play can stall.
export async function restoreStudioWindow(run: PsRun = runPowerShell): Promise<'restored' | 'ok' | 'none'> {
  try {
    const out = (await run(RESTORE_PS, 8000)) ?? '';
    return /restored/.test(out) ? 'restored' : /ok/.test(out) ? 'ok' : 'none';
  } catch {
    return 'none';
  }
}

// Un-minimise Studio through the session's probes (fake sessions have none).
export async function restoreFor(session: unknown): Promise<void> {
  await (session as { host?: { restore(): Promise<unknown> } }).host?.restore().catch(() => {});
}

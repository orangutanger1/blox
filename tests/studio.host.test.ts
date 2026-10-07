import { describe, expect, it } from 'vitest';
import { hostKind, isSessionLocked, restoreStudioWindow, type PsRun } from '../src/studio/host.js';

const ps = (out: string | null): PsRun => async () => out;

describe('host probes', () => {
  it('detects WSL from the kernel release', () => {
    expect(hostKind({ platform: 'linux', release: '5.15.167.4-microsoft-standard-WSL2' })).toBe('wsl');
    expect(hostKind({ platform: 'win32', release: '10.0' })).toBe('win32');
    expect(hostKind({ platform: 'linux', release: '6.8.0-generic' })).toBe('other');
  });
  it('reads a locked session from LogonUI', async () => {
    expect(await isSessionLocked(ps('LOCKED'))).toBe(true);
    expect(await isSessionLocked(ps(''))).toBe(false);
  });
  it('treats a failed or timed-out probe as not locked', async () => {
    expect(await isSessionLocked(ps(null))).toBe(false);
    expect(await isSessionLocked(async () => { throw new Error('boom'); })).toBe(false);
  });
  it('reports whether a minimised Studio window was restored', async () => {
    expect(await restoreStudioWindow(ps('restored\nok'))).toBe('restored');
    expect(await restoreStudioWindow(ps('ok'))).toBe('ok');
    expect(await restoreStudioWindow(ps(''))).toBe('none');
    expect(await restoreStudioWindow(ps(null))).toBe('none');
  });
});

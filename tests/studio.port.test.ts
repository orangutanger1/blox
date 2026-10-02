import { describe, it, expect } from 'vitest';
import {
  parseNetstatListeners, parseTasklist, classifyPort, checkStudioPort, fixOrphanProxy, type Exec,
} from '../src/studio/port.js';

const NETSTAT = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:13469        0.0.0.0:0              LISTENING       4100
  TCP    [::1]:13469            [::]:0                 LISTENING       4100
  TCP    127.0.0.1:52656        127.0.0.1:13469        SYN_SENT        26852
  TCP    0.0.0.0:134690         0.0.0.0:0              LISTENING       9
`;
const TASKS = `"RobloxStudioBeta.exe","26852","Console","22","700,996 K"\r\n"StudioMCP.exe","4100","Console","22","9,000 K"\r\n`;

describe('parsers', () => {
  it('finds listeners on the port only (not clients, not prefix ports)', () => {
    expect(parseNetstatListeners(NETSTAT, 13469)).toEqual(['4100']);
  });
  it('maps tasklist CSV rows by pid', () => {
    expect(parseTasklist(TASKS).get('4100')).toBe('StudioMCP.exe');
  });
});

describe('classifyPort', () => {
  it('flags a non-Roblox squatter', () => {
    expect(classifyPort([{ pid: '7', name: 'ropilot.exe' }], true).issue).toBe('squatter');
  });
  it('flags a StudioMCP orphan only when no Studio runs', () => {
    expect(classifyPort([{ pid: '7', name: 'StudioMCP.exe' }], false).issue).toBe('orphan');
    expect(classifyPort([{ pid: '7', name: 'StudioMCP.exe' }], true).issue).toBe('none');
  });
  it('free port is fine', () => {
    expect(classifyPort([], true).issue).toBe('none');
  });
});

describe('checkStudioPort / fixOrphanProxy', () => {
  const fake = (netstat: string, tasks: string, calls: string[][] = []): Exec => async (cmd, args) => {
    calls.push([cmd, ...args]);
    return cmd.startsWith('netstat') ? netstat : cmd.startsWith('tasklist') ? tasks : '';
  };
  it('reports healthy proxy with Studio running', async () => {
    const r = await checkStudioPort({ platform: 'linux', exec: fake(NETSTAT, TASKS) });
    expect(r).toMatchObject({ checked: true, studioRunning: true, issue: 'none' });
  });
  it('kills only the orphan StudioMCP', async () => {
    const calls: string[][] = [];
    const exec = fake(NETSTAT, `"StudioMCP.exe","4100","Console","22","9,000 K"`, calls);
    const r = await checkStudioPort({ platform: 'win32', exec });
    expect(r.issue).toBe('orphan');
    expect(await fixOrphanProxy(r, { platform: 'win32', exec })).toContain('4100');
    expect(calls.at(-1)).toEqual(['taskkill', '/F', '/PID', '4100']);
  });
  it('fix is a no-op when nothing is wrong', async () => {
    expect(await fixOrphanProxy({ checked: true, owners: [], studioRunning: true, issue: 'none', detail: '' })).toBeNull();
  });
  it('skips on macOS', async () => {
    expect((await checkStudioPort({ platform: 'darwin' })).checked).toBe(false);
  });
});

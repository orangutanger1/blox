import { describe, it, expect } from 'vitest';
import { studioPluginsDir, installPanel } from '../src/panel/install.js';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('studioPluginsDir', () => {
  it('honors the env override', async () => {
    const dir = await studioPluginsDir({ env: { BLOX_STUDIO_PLUGINS_DIR: '/x/plugins' }, platform: 'linux' });
    expect(dir).toBe('/x/plugins');
  });

  it('uses LOCALAPPDATA on native Windows', async () => {
    const dir = await studioPluginsDir({ env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, platform: 'win32' });
    expect(dir).toBe(join('C:\\Users\\me\\AppData\\Local', 'Roblox', 'Plugins'));
  });

  it('asks Windows + wslpath on WSL', async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'cmd.exe') return 'C:\\Users\\me\\AppData\\Local\r\n';
      if (cmd === 'wslpath') return '/mnt/c/Users/me/AppData/Local\n';
      throw new Error(`unexpected ${cmd}`);
    };
    const dir = await studioPluginsDir({ env: {}, platform: 'linux', exec });
    expect(dir).toBe('/mnt/c/Users/me/AppData/Local/Roblox/Plugins');
    expect(calls[0][0]).toBe('cmd.exe');
  });

  it('throws when LOCALAPPDATA is unset on native Windows', async () => {
    await expect(studioPluginsDir({ env: {}, platform: 'win32' })).rejects.toThrow('LOCALAPPDATA is not set');
  });
});

describe('installPanel', () => {
  it('builds via rojo and copies the rbxm into the plugins dir', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blox-install-'));
    const pluginsDir = join(work, 'plugins');
    mkdirSync(pluginsDir);
    let builtTo: string | null = null;
    const exec = async (cmd: string, args: string[]) => {
      if (cmd === 'rojo') {
        builtTo = args[args.indexOf('-o') + 1];
        writeFileSync(builtTo!, 'rbxm-bytes');
        return '';
      }
      throw new Error(`unexpected ${cmd}`);
    };
    const dest = await installPanel({
      pluginsDir,
      pluginProjectDir: work, // any dir; rojo is faked
      exec,
    });
    expect(builtTo).not.toBeNull();
    expect(dest).toBe(join(pluginsDir, 'blox-panel.rbxm'));
    expect(existsSync(dest)).toBe(true);
  });

  it('creates the plugins dir when it does not exist yet', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blox-install-'));
    const pluginsDir = join(work, 'Roblox', 'Plugins'); // fresh machine: never created
    const exec = async (cmd: string, args: string[]) => {
      if (cmd === 'rojo') {
        writeFileSync(args[args.indexOf('-o') + 1], 'rbxm-bytes');
        return '';
      }
      throw new Error(`unexpected ${cmd}`);
    };
    const dest = await installPanel({ pluginsDir, pluginProjectDir: work, exec });
    expect(existsSync(dest)).toBe(true);
  });
});

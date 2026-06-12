import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ExecFn = (cmd: string, args: string[]) => Promise<string>;

const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

export interface PluginsDirOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exec?: ExecFn;
}

// Resolve the local Studio plugins folder. Order: explicit env override →
// native Windows %LOCALAPPDATA% → WSL (Studio runs on the Windows side, so ask
// Windows where LOCALAPPDATA is and convert to a /mnt path).
export async function studioPluginsDir(opts: PluginsDirOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? defaultExec;

  if (env.BLOX_STUDIO_PLUGINS_DIR) return env.BLOX_STUDIO_PLUGINS_DIR;
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is not set');
    return join(env.LOCALAPPDATA, 'Roblox', 'Plugins');
  }
  // WSL path: cmd.exe prints the Windows value; wslpath converts it.
  const winLocalAppData = (await exec('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'])).trim();
  const unixPath = (await exec('wslpath', ['-u', winLocalAppData])).trim();
  return `${unixPath}/Roblox/Plugins`;
}

export interface InstallOptions {
  pluginsDir: string;
  pluginProjectDir?: string; // dir containing default.project.json
  exec?: ExecFn;
}

// repoRoot/plugin, resolved relative to this module (works from dist/ too:
// dist/panel/install.js → repoRoot/plugin).
export function defaultPluginProjectDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin');
}

// Build the plugin rbxm with rojo and copy it into the Studio plugins folder.
// Returns the destination path.
export async function installPanel(opts: InstallOptions): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  const projectDir = opts.pluginProjectDir ?? defaultPluginProjectDir();
  const out = join(mkdtempSync(join(tmpdir(), 'blox-panel-')), 'blox-panel.rbxm');
  await exec('rojo', ['build', join(projectDir, 'default.project.json'), '-o', out]);
  const dest = join(opts.pluginsDir, 'blox-panel.rbxm');
  copyFileSync(out, dest);
  return dest;
}

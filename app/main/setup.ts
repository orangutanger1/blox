// app/main/setup.ts
import type { StepResult } from '../shared/ipc.js';

export interface SetupDeps {
  // Forks the engine CLI with args → exit code + stdout (engine.runCli).
  runCli: (args: string[]) => Promise<{ code: number | null; stdout: string }>;
  // Resolve a binary on PATH (null = not found).
  which: (bin: string) => Promise<string | null>;
  // Download a URL to a destination path.
  download: (url: string, dest: string) => Promise<void>;
  // Where the bundled/downloaded rojo binary should live.
  rojoBinPath: string;
}

// Pinned rojo release the app installs when rojo is absent (matches the
// version the engine was validated against).
export const ROJO_VERSION = '7.6.1';
export const ROJO_WIN_URL = `https://github.com/rojo-rbx/rojo/releases/download/v${ROJO_VERSION}/rojo-${ROJO_VERSION}-windows-x86_64.zip`;

export function createSetup(deps: SetupDeps) {
  return {
    async detectRojo(): Promise<StepResult> {
      const found = await deps.which('rojo');
      return found
        ? { status: 'ok', detail: `rojo found at ${found}` }
        : { status: 'missing', detail: 'rojo not on PATH' };
    },
    async installRojo(): Promise<StepResult> {
      try {
        await deps.download(ROJO_WIN_URL, deps.rojoBinPath);
        return { status: 'ok', detail: `rojo ${ROJO_VERSION} installed` };
      } catch (e) {
        return { status: 'error', detail: (e as Error).message };
      }
    },
    async installPlugin(): Promise<StepResult> {
      const { code, stdout } = await deps.runCli(['panel', 'install']);
      return code === 0
        ? { status: 'ok', detail: 'dock plugin installed into Studio' }
        : { status: 'error', detail: stdout || 'panel install failed' };
    },
    async checkStudio(): Promise<StepResult> {
      const { code, stdout } = await deps.runCli(['doctor']);
      return code === 0
        ? { status: 'ok', detail: 'Studio connected' }
        : { status: 'missing', detail: stdout || 'Studio not attached' };
    },
  };
}

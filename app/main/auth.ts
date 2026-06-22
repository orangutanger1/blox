// app/main/auth.ts
// Desktop credential store. Reads/writes the SAME file the engine reads
// (src/auth.ts), so a key saved here reaches the forked engine's buildAuthEnv.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export type AuthMode = 'subscription' | 'apiKey';
export interface AuthStore { mode?: AuthMode; apiKey?: string }

// Mirror src/auth.ts:authConfigDir — same machine/user → same path.
export function credStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
  const base = xdg || join(homedir(), '.config');
  return join(base, 'blox', 'auth.json');
}

export function createCredStore(filePath: string = credStorePath()) {
  const load = (): AuthStore => {
    if (!existsSync(filePath)) return {};
    try {
      const r = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const s: AuthStore = {};
      if (r.mode === 'subscription' || r.mode === 'apiKey') s.mode = r.mode;
      if (typeof r.apiKey === 'string' && r.apiKey) s.apiKey = r.apiKey;
      return s;
    } catch {
      return {};
    }
  };
  const save = (s: AuthStore): void => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    chmodSync(filePath, 0o600); // enforce perms even if the file pre-existed
  };
  return {
    saveApiKey(key: string): void { const s = load(); s.apiKey = key; s.mode = 'apiKey'; save(s); },
    hasApiKey(): boolean { return !!load().apiKey; },
    useSubscription(): void { const s = load(); s.mode = 'subscription'; save(s); },
    load,
  };
}

// Parse `blox auth status` formatted output (src/auth.ts:formatAuthStatus).
export function parseSubscriptionLinked(stdout: string): { linked: boolean; detail?: string } {
  const m = stdout.match(/subscription:\s*linked(?:\s*\(([^)]*)\))?/i);
  return m ? { linked: true, detail: m[1] || undefined } : { linked: false };
}

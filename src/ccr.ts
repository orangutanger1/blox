import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CcrModels {
  provider: string | null;
  models: string[];
  current: string | null;
}

export function ccrConfigPath(): string {
  return process.env.CCR_CONFIG ?? join(homedir(), '.claude-code-router', 'config.json');
}

// Read the first provider's model list + the Router.default slug. Any failure
// (missing file, bad JSON, unexpected shape) degrades to empties — the daemon
// surfaces "no models" rather than crashing.
export function readCcrModels(path: string = ccrConfigPath()): CcrModels {
  const empty: CcrModels = { provider: null, models: [], current: null };
  if (!existsSync(path)) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return empty;
  }
  const cfg = raw as {
    Providers?: { name?: unknown; models?: unknown }[];
    Router?: { default?: unknown };
  };
  const p = cfg.Providers?.[0];
  const provider = typeof p?.name === 'string' ? p.name : null;
  const models = Array.isArray(p?.models)
    ? (p!.models as unknown[]).filter((m): m is string => typeof m === 'string')
    : [];
  const def = typeof cfg.Router?.default === 'string' ? cfg.Router.default : null;
  // Router.default is "provider,slug"; the slug is everything after the first comma.
  const current = def ? (def.includes(',') ? def.slice(def.indexOf(',') + 1) : def) : null;
  return { provider, models, current };
}

// The model string blox sends so CCR routes per-request (bypassing Router.default).
export function resolveModel(provider: string | null, slug: string): string {
  return provider ? `${provider},${slug}` : slug;
}

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

export interface CcrEndpoint {
  baseUrl: string;
  apiKey: string;
}

// CCR's own inbound endpoint — where the Agent SDK must send requests
// (ANTHROPIC_BASE_URL) so CCR routes them per-request to the chosen provider.
// Without this the SDK hits api.anthropic.com and a `provider,slug` model 404s.
// Defaults match CCR's own defaults; HOST/PORT/APIKEY in the config override. A
// 0.0.0.0 bind host is rewritten to 127.0.0.1 (you can't connect TO 0.0.0.0).
// When no APIKEY is set CCR accepts any non-empty token, so we send a placeholder.
export function ccrEndpoint(path: string = ccrConfigPath()): CcrEndpoint {
  let cfg: { HOST?: unknown; PORT?: unknown; APIKEY?: unknown } = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, 'utf8')) as typeof cfg;
    } catch {
      /* fall through to defaults */
    }
  }
  const rawHost = typeof cfg.HOST === 'string' && cfg.HOST ? cfg.HOST : '127.0.0.1';
  const host = rawHost === '0.0.0.0' ? '127.0.0.1' : rawHost;
  const port = typeof cfg.PORT === 'number' ? cfg.PORT : 3456;
  const apiKey = typeof cfg.APIKEY === 'string' && cfg.APIKEY ? cfg.APIKEY : 'sk-blox-ccr';
  return { baseUrl: `http://${host}:${port}`, apiKey };
}

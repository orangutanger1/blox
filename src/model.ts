// src/model.ts — friendly writer for ~/.claude-code-router/config.json. blox owns
// CCR's config so the user never hand-edits it; CCR still does the translation.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { ccrConfigPath } from './ccr.js';

export type ProviderKind = 'openrouter' | 'local';
export interface AddProviderOpts { apiKey?: string; baseUrl?: string; models: string[] }

const DEFAULTS: Record<ProviderKind, { baseUrl: string; transformer?: { use: string[] } }> = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1/chat/completions', transformer: { use: ['openrouter'] } },
  local: { baseUrl: 'http://localhost:11434/v1/chat/completions' },
};

interface CcrProvider { name: string; api_base_url: string; api_key: string; models: string[]; transformer?: { use: string[] } }
interface CcrConfig { Providers?: CcrProvider[]; Router?: { default?: string; [k: string]: unknown }; [k: string]: unknown }

// Upsert one provider block per kind: accumulate its models (append + dedupe)
// rather than replacing, and point Router.default at the just-added model.
// Other providers and unrelated config keys are preserved.
export function writeProvider(kind: ProviderKind, opts: AddProviderOpts, path: string = ccrConfigPath()): void {
  if (opts.models.length === 0) throw new Error(`${kind}: at least one model is required`);

  let cfg: CcrConfig = {};
  if (existsSync(path)) {
    try { cfg = JSON.parse(readFileSync(path, 'utf8')) as CcrConfig; } catch { cfg = {}; }
  }
  const providers = Array.isArray(cfg.Providers) ? cfg.Providers : [];
  const existing = providers.find((p) => p.name === kind);

  // openrouter needs a key, but only on the first add — reuse the stored one after.
  const apiKey = opts.apiKey || existing?.api_key;
  if (kind === 'openrouter' && !apiKey) throw new Error('openrouter: an API key is required');

  const def = DEFAULTS[kind];
  const block: CcrProvider = {
    name: kind,
    api_base_url: opts.baseUrl || existing?.api_base_url || def.baseUrl,
    api_key: apiKey || 'local', // CCR wants a non-empty key; local servers ignore it
    models: [...new Set([...(existing?.models ?? []), ...opts.models])],
    ...(def.transformer ? { transformer: def.transformer } : {}),
  };
  cfg.Providers = [...providers.filter((p) => p.name !== kind), block];
  cfg.Router = { ...(cfg.Router ?? {}), default: `${kind},${opts.models[0]}` };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600); // config holds the OpenRouter key — keep it user-only
}

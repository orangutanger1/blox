// src/model.ts — friendly writer for ~/.claude-code-router/config.json. blox owns
// CCR's config so the user never hand-edits it; CCR still does the translation.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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

// Upsert one provider block per kind and point Router.default at its first model.
// Other providers and unrelated config keys are preserved.
export function writeProvider(kind: ProviderKind, opts: AddProviderOpts, path: string = ccrConfigPath()): void {
  if (opts.models.length === 0) throw new Error(`${kind}: at least one model is required`);
  if (kind === 'openrouter' && !opts.apiKey) throw new Error('openrouter: an API key is required');

  let cfg: CcrConfig = {};
  if (existsSync(path)) {
    try { cfg = JSON.parse(readFileSync(path, 'utf8')) as CcrConfig; } catch { cfg = {}; }
  }
  const def = DEFAULTS[kind];
  const block: CcrProvider = {
    name: kind,
    api_base_url: opts.baseUrl || def.baseUrl,
    api_key: opts.apiKey || 'local', // CCR wants a non-empty key; local servers ignore it
    models: opts.models,
    ...(def.transformer ? { transformer: def.transformer } : {}),
  };
  const others = Array.isArray(cfg.Providers) ? cfg.Providers.filter((p) => p.name !== kind) : [];
  cfg.Providers = [...others, block];
  cfg.Router = { ...(cfg.Router ?? {}), default: `${kind},${opts.models[0]}` };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}

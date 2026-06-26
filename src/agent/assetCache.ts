import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Prompt-hash dedupe for slow asset-generation tools. The cache is ADVISORY:
// it records "this prompt produced asset <tag>" so a later identical request can
// be told to reuse the prior asset instead of paying for another multi-second
// generation. It does NOT re-insert the asset — that's the agent's job, and the
// recorded tag may be stale if the prior asset was rejected/deleted from the
// DataModel.
//
// ponytail: generate_mesh only (sync — prompt and tag arrive in one tool call).
// procedural_model → wait_job_finished is a two-call chain whose prompt and tag
// live in different calls; linking them needs job-id tracking — deferred until
// there's evidence it matters.
export interface AssetCacheEntry {
  tag: string;
  tool: string;
  prompt: string;
  ts?: string; // stamped by recordAsset
}

type AssetCacheFile = Record<string, AssetCacheEntry>;

export function assetCachePath(projectPath: string): string {
  return join(projectPath, '.blox', 'asset-cache.json');
}

// Stable key for an asset prompt: whitespace-collapsed, lowercased, sha256.
// Reads `textPrompt` (generate_mesh) or `prompt` (procedural), whichever is a
// string. Returns null when neither carries a usable prompt.
export function assetCacheKey(input: Record<string, unknown>): string | null {
  const raw = typeof input?.textPrompt === 'string' ? input.textPrompt : input?.prompt;
  if (typeof raw !== 'string') return null;
  const norm = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!norm) return null;
  return createHash('sha256').update(norm).digest('hex');
}

function load(projectPath: string): AssetCacheFile {
  const path = assetCachePath(projectPath);
  if (!existsSync(path)) return {};
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return j && typeof j === 'object' ? (j as AssetCacheFile) : {};
  } catch {
    return {}; // corrupt cache is non-fatal — treated as empty, repaired on next write
  }
}

export function lookupAsset(projectPath: string, key: string): AssetCacheEntry | null {
  return load(projectPath)[key] ?? null;
}

export function recordAsset(projectPath: string, key: string, entry: AssetCacheEntry): void {
  const cache = load(projectPath);
  cache[key] = { ...entry, ts: new Date().toISOString() };
  const path = assetCachePath(projectPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2) + '\n');
}

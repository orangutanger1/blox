import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetCacheKey, recordAsset, lookupAsset, assetCachePath } from '../src/agent/assetCache.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blox-assetcache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('assetCacheKey', () => {
  it('is stable for the same prompt regardless of surrounding whitespace/case', () => {
    expect(assetCacheKey({ prompt: 'A Small Gray Rock' })).toBe(
      assetCacheKey({ prompt: '  a small   gray rock ' }),
    );
  });

  it('differs for different prompts', () => {
    expect(assetCacheKey({ prompt: 'rock' })).not.toBe(assetCacheKey({ prompt: 'tree' }));
  });

  it('reads textPrompt (generate_mesh) the same as prompt (procedural)', () => {
    expect(assetCacheKey({ textPrompt: 'a barrel' })).toBe(assetCacheKey({ prompt: 'a barrel' }));
  });

  it('returns null when there is no usable prompt string', () => {
    expect(assetCacheKey({})).toBeNull();
    expect(assetCacheKey({ prompt: '   ' })).toBeNull();
    expect(assetCacheKey({ prompt: 42 } as never)).toBeNull();
  });
});

describe('recordAsset / lookupAsset', () => {
  it('returns null for an unseen key', () => {
    expect(lookupAsset(dir, 'nope')).toBeNull();
  });

  it('round-trips a recorded asset and writes the cache file under .blox', () => {
    const key = assetCacheKey({ prompt: 'rock' })!;
    recordAsset(dir, key, { tag: 'Assistant-MeshGen-1', tool: 'generate_mesh', prompt: 'rock' });
    expect(existsSync(assetCachePath(dir))).toBe(true);
    const hit = lookupAsset(dir, key);
    expect(hit?.tag).toBe('Assistant-MeshGen-1');
    expect(hit?.prompt).toBe('rock');
    expect(typeof hit?.ts).toBe('string'); // recordAsset stamps it
  });

  it('overwrites a prior entry for the same key (latest tag wins)', () => {
    const key = assetCacheKey({ prompt: 'rock' })!;
    recordAsset(dir, key, { tag: 'old', tool: 'generate_mesh', prompt: 'rock' });
    recordAsset(dir, key, { tag: 'new', tool: 'generate_mesh', prompt: 'rock' });
    expect(lookupAsset(dir, key)?.tag).toBe('new');
  });

  it('survives a corrupt cache file (treats it as empty, then repairs on write)', () => {
    const path = assetCachePath(dir);
    recordAsset(dir, 'seed', { tag: 't', tool: 'generate_mesh', prompt: 'x' }); // create .blox + file
    // clobber with junk
    writeFileSync(path, '{not json');
    expect(lookupAsset(dir, 'seed')).toBeNull();
    recordAsset(dir, 'k', { tag: 't2', tool: 'generate_mesh', prompt: 'y' });
    expect(lookupAsset(dir, 'k')?.tag).toBe('t2');
    JSON.parse(readFileSync(path, 'utf8')); // must be valid JSON again
  });
});

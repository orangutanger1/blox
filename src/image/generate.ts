import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { addAsset, loadManifest, saveManifest } from '../assets/manifest.js';
import { cutout } from './post.js';
import { KaggleUnavailable, runKaggleBatch, type BatchResult } from './kaggle.js';
import { runFluxBatch } from './cloudflare.js';
import type { KernelItem } from './kaggleScripts.js';

// `blox image generate`: prompts → transparent square PNGs in assets/icons,
// each recorded in .blox/assets.json. Backends are pluggable; the default is
// Qwen-Image-2.1 on a Kaggle T4 x2 batch, then Cloudflare FLUX.1-schnell.

export const STYLES = {
  icon: 'game UI icon, one single centred object, bold dark outline, flat cel shading, bright saturated colours, soft top-left highlight, plain pure white background, no text, no border, no shadow on the ground',
  item: 'game item render, one single centred object, three-quarter view, clean cel shading, bright saturated colours, plain pure white background, no text',
  badge: 'round game badge emblem, centred, bold outline, bright saturated colours, plain pure white background, no text',
} as const;
export type StyleName = keyof typeof STYLES;

export interface ImageItem {
  name: string; // file-safe id → assets/icons/<name>.png, manifest id icon-<name>
  prompt: string;
  seed?: number;
}
export interface GenerateInput {
  items: ImageItem[];
  style?: StyleName | string; // preset name, or a raw style string ('' for none)
  size?: number; // output px (default 512)
  overwrite?: boolean;
  fresh?: boolean; // skip the image cache (new art for the same prompt)
  dir?: string; // default assets/icons
}
export type BackendName = 'kaggle-qwen' | 'cloudflare-flux';
export interface ImageBackend {
  name: BackendName;
  model: string;
  licence: 'qwen-research' | 'apache-2.0';
  run(items: KernelItem[], o: { size: number; onStatus?: (s: string) => void }): Promise<BatchResult[]>;
}

export function defaultBackends(): ImageBackend[] {
  return [
    { name: 'kaggle-qwen', model: 'Qwen-Image-2.1 (int8 ConvRot, Comfy-Org ace0ede)', licence: 'qwen-research', run: (items, o) => runKaggleBatch(items, { size: o.size <= 512 ? 512 : 1024, workDir: mkdtempSync(join(tmpdir(), 'blox-kaggle-')), onStatus: o.onStatus }) },
    { name: 'cloudflare-flux', model: 'FLUX.1-schnell (Cloudflare Workers AI)', licence: 'apache-2.0', run: (items) => runFluxBatch(items) },
  ];
}

export interface GenerateResult {
  backend: BackendName;
  written: { name: string; file: string; seed?: number }[];
  failed: { name: string; error: string }[];
  notes: string[];
  cached?: string[]; // names reused from the image cache (no backend run)
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;

// ~/.cache/blox/images/<sha256 of prompt+style+size+backend(+seed)>.png (+ .json meta):
// icons repeat across projects and re-runs, and a Kaggle batch costs minutes of weekly GPU quota.
export function imageCacheDir(): string {
  return process.env.BLOX_IMAGE_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'blox', 'images');
}
export function cacheKey(k: { prompt: string; style: string; size: number; backend: BackendName; seed?: number }): string {
  return createHash('sha256').update(JSON.stringify([k.prompt, k.style, k.size, k.backend, k.seed ?? null])).digest('hex').slice(0, 32);
}
interface CacheMeta { backend: BackendName; model: string; licence: ImageBackend['licence']; seed?: number; prompt: string }

export async function generateImages(P: string, input: GenerateInput, o: { backends?: ImageBackend[]; onStatus?: (s: string) => void; cacheDir?: string | null } = {}): Promise<GenerateResult> {
  if (!input.items?.length) throw new Error('image generate: give at least one item {name, prompt}');
  const dir = input.dir ?? 'assets/icons';
  const seen = new Set<string>();
  for (const it of input.items) {
    if (!NAME.test(it.name)) throw new Error(`image name "${it.name}": use lower-case letters, digits, - and _ (it becomes the file name)`);
    if (seen.has(it.name)) throw new Error(`duplicate image name "${it.name}"`);
    seen.add(it.name);
    if (!input.overwrite && existsSync(join(P, dir, `${it.name}.png`))) throw new Error(`${dir}/${it.name}.png exists — pass overwrite: true to replace it`);
  }
  const style = input.style === undefined ? STYLES.icon : (STYLES as Record<string, string>)[input.style] ?? input.style;
  const size = input.size ?? 512;
  const notes: string[] = [];
  const backends = o.backends ?? defaultBackends();
  const cache = o.cacheDir ?? null;
  const key = (it: ImageItem, b: BackendName) => cacheKey({ prompt: it.prompt, style, size, backend: b, seed: it.seed });
  const m = loadManifest(P);
  const out: GenerateResult = { backend: backends[0]?.name ?? 'kaggle-qwen', written: [], failed: [], notes, cached: [] };
  const write = (it: ImageItem, png: Buffer, meta: CacheMeta) => {
    mkdirSync(join(P, dir), { recursive: true });
    const file = `${dir}/${it.name}.png`;
    writeFileSync(join(P, file), png);
    const id = `icon-${it.name}`;
    const provenance = { tool: 'blox image', model: meta.model, backend: meta.backend, prompt: it.prompt, seed: meta.seed, createdAt: new Date().toISOString() };
    const prev = m.assets.find((a) => a.id === id);
    if (prev) {
      // regenerated: new art needs a fresh human look
      Object.assign(prev, { licence: meta.licence, provenance, status: 'candidate', ref: { ...prev.ref, file } });
      delete prev.uploaded;
      saveManifest(P, m);
    } else {
      const a = addAsset(P, { id, kind: 'image', source: 'generated', licence: meta.licence, ref: { file }, provenance });
      if (!a.ok) throw new Error(`manifest: ${a.errors.join('; ')}`);
      m.assets.push(a.entry);
    }
    out.written.push({ name: it.name, file, seed: meta.seed });
  };

  let todo = input.items;
  if (cache && !input.fresh) {
    todo = [];
    for (const it of input.items) {
      const hit = backends.map((b) => join(cache, key(it, b.name))).find((f) => existsSync(`${f}.png`) && existsSync(`${f}.json`));
      if (!hit) { todo.push(it); continue; }
      const meta = JSON.parse(readFileSync(`${hit}.json`, 'utf8')) as CacheMeta;
      write(it, readFileSync(`${hit}.png`), meta);
      out.cached!.push(it.name);
      out.backend = meta.backend;
    }
    if (!todo.length) return out;
  }
  const kitems: KernelItem[] = todo.map((it) => ({ file: `${it.name}.png`, prompt: style ? `${it.prompt}. ${style}` : it.prompt, seed: it.seed ?? Math.floor(Math.random() * 2 ** 31) }));
  for (let b = 0; b < backends.length; b++) {
    const be = backends[b];
    let results: BatchResult[];
    try {
      results = await be.run(kitems, { size, onStatus: o.onStatus });
    } catch (e) {
      if (e instanceof KaggleUnavailable && b < backends.length - 1) {
        notes.push(`${be.name} unavailable (${(e as Error).message.split('\n')[0]}); used ${backends[b + 1].name}`);
        continue;
      }
      throw e;
    }
    out.backend = be.name;
    for (const it of todo) {
      const r = results.find((x) => x.file === `${it.name}.png`);
      if (!r?.data) {
        out.failed.push({ name: it.name, error: r?.error ?? 'no image returned' });
        continue;
      }
      let png: Buffer;
      try {
        png = cutout(r.data, { size });
      } catch (e) {
        out.failed.push({ name: it.name, error: `post-process: ${(e as Error).message}` });
        continue;
      }
      const meta: CacheMeta = { backend: be.name, model: be.model, licence: be.licence, seed: 'seed' in r ? r.seed : kitems.find((k) => k.file === r.file)!.seed, prompt: it.prompt }; // FLUX ignores seeds: none recorded
      if (cache) {
        try {
          mkdirSync(cache, { recursive: true });
          const f = join(cache, key(it, be.name));
          writeFileSync(`${f}.png`, png);
          writeFileSync(`${f}.json`, JSON.stringify(meta));
        } catch (e) {
          notes.push(`cache write failed: ${(e as Error).message}`);
        }
      }
      write(it, png, meta);
    }
    return out;
  }
  throw new Error('image generate: no backend available');
}

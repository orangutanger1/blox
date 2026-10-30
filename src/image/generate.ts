import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { addAsset, loadManifest, saveManifest } from '../assets/manifest.js';
import { cutout } from './post.js';
import { KieError, imageInput, kieDownload, kieRun, kieUpload, withRefsModel, type KieOptions } from './kie.js';

// `blox image generate`: prompts → transparent square PNGs in assets/icons,
// each recorded in .blox/assets.json. Backends are kie.ai models, tried in
// order: GPT Image 2 (native transparent background), then Nano Banana 2.1.

export const STYLES = {
  icon: 'game UI icon, one single centred object, bold dark outline, flat cel shading, bright saturated colours, soft top-left highlight, plain pure white background, no text, no border, no shadow on the ground',
  item: 'game item render, one single centred object, three-quarter view, clean cel shading, bright saturated colours, plain pure white background, no text',
  // HUD buttons/badges read at 32 px: one silhouette, few colours, no props (Dog Attack Plan 9 lesson)
  hud: 'simple mobile game HUD icon, one single object with a bold readable silhouette, at most three flat colours, thick even dark outline, large simple shapes, no small details, no extra objects, no sparkles, no glow, no motion lines, no text, no numbers, front view, centred, fills the frame, plain pure white background',
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
  refs?: string[]; // project-relative reference images: same style/character/palette
}
export type BackendName = string; // the kie.ai model id
export interface BatchItem {
  file: string;
  prompt: string;
  seed?: number;
}
export interface BatchResult {
  file: string;
  seed?: number;
  data?: Buffer;
  error?: string;
  model?: string; // the model that actually ran, when it differs (refs → image-to-image)
}
export interface ImageBackend {
  name: BackendName;
  model: string;
  licence: 'ai-output' | 'apache-2.0' | 'qwen-research';
  run(items: BatchItem[], o: { size: number; refs?: string[]; aspect?: string; onStatus?: (s: string) => void }): Promise<BatchResult[]>;
}

export const DEFAULT_MODELS = ['gpt-image-2-text-to-image', 'nano-banana-2-1'];

// One kie.ai model as a backend: refs (local files) are uploaded once, items run
// 4 at a time (createTask allows 20 per 10 s), each result downloaded.
export function kieBackend(model: string, k: KieOptions = {}): ImageBackend {
  return {
    name: model,
    model: `${model} (kie.ai)`,
    licence: 'ai-output',
    async run(items, o) {
      const refs = o.refs?.length ? await Promise.all(o.refs.map((f) => kieUpload(f, k))) : undefined;
      const m = refs ? withRefsModel(model) : model;
      const out: BatchResult[] = new Array(items.length);
      let next = 0, done = 0;
      const worker = async () => {
        while (next < items.length) {
          const i = next++, it = items[i];
          try {
            const r = await kieRun(m, imageInput(m, it.prompt, { refs, aspect: o.aspect, transparent: true }), k);
            if (!r.urls[0]) throw new KieError('no image returned');
            out[i] = { file: it.file, data: await kieDownload(r.urls[0], k), model: `${m} (kie.ai)` };
          } catch (e) {
            // The whole model is out (no key, no credits, rate-limited): let the next backend try.
            if (e instanceof KieError && (e.code === undefined ? /no kie\.ai key/.test(e.message) : [401, 402, 429, 455].includes(e.code))) throw e;
            out[i] = { file: it.file, error: (e as Error).message };
          }
          o.onStatus?.(`${++done}/${items.length} done`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
      return out;
    },
  };
}

export function defaultBackends(model?: string): ImageBackend[] {
  return (model ? [model] : DEFAULT_MODELS).map((m) => kieBackend(m));
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
// icons repeat across projects and re-runs, and every generation costs kie.ai credits.
export function imageCacheDir(): string {
  return process.env.BLOX_IMAGE_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'blox', 'images');
}
export function cacheKey(k: { prompt: string; style: string; size: number; backend: BackendName; seed?: number; refs?: string }): string {
  return createHash('sha256').update(JSON.stringify([k.prompt, k.style, k.size, k.backend, k.seed ?? null, ...(k.refs ? [k.refs] : [])])).digest('hex').slice(0, 32);
}
// Reference images change the output: their bytes are part of the cache key.
export function refsDigest(P: string, refs?: string[]): string | undefined {
  if (!refs?.length) return undefined;
  const h = createHash('sha256');
  for (const r of refs) h.update(readFileSync(join(P, r)));
  return h.digest('hex').slice(0, 16);
}

// Input errors surface before any backend (or background job) starts.
export function validateImages(P: string, input: GenerateInput): void {
  if (!input.items?.length) throw new Error('image generate: give at least one item {name, prompt}');
  const dir = input.dir ?? 'assets/icons';
  const seen = new Set<string>();
  for (const it of input.items) {
    if (!NAME.test(it.name)) throw new Error(`image name "${it.name}": use lower-case letters, digits, - and _ (it becomes the file name)`);
    if (seen.has(it.name)) throw new Error(`duplicate image name "${it.name}"`);
    seen.add(it.name);
    if (!input.overwrite && existsSync(join(P, dir, `${it.name}.png`))) throw new Error(`${dir}/${it.name}.png exists — pass overwrite: true to replace it`);
  }
  for (const r of input.refs ?? []) if (!existsSync(join(P, r))) throw new Error(`reference image ${r} not found (paths are relative to the project)`);
}

const styleOf = (input: GenerateInput) => (input.style === undefined ? STYLES.icon : (STYLES as Record<string, string>)[input.style] ?? input.style);

// The cache file (without extension) holding this item from any of the backends, or null.
function cached(P: string, input: GenerateInput, it: ImageItem, backends: ImageBackend[], cache: string | null): string | null {
  if (!cache || input.fresh) return null;
  const style = styleOf(input), size = input.size ?? 512, refs = refsDigest(P, input.refs);
  return backends.map((b) => join(cache, cacheKey({ prompt: it.prompt, style, size, backend: b.name, seed: it.seed, refs }))).find((f) => existsSync(`${f}.png`) && existsSync(`${f}.json`)) ?? null;
}
export const cacheMisses = (P: string, input: GenerateInput, backends: ImageBackend[], cache: string | null): ImageItem[] => input.items.filter((it) => !cached(P, input, it, backends, cache));

export interface ImageMeta { backend: BackendName; model: string; licence: ImageBackend['licence']; seed?: number; prompt: string }

// Write one finished icon and record it in the manifest as a candidate.
export function recordImage(P: string, dir: string, name: string, png: Buffer, meta: ImageMeta, extra: Record<string, unknown> = {}): string {
  mkdirSync(join(P, dir), { recursive: true });
  const file = `${dir}/${name}.png`;
  writeFileSync(join(P, file), png);
  const id = `icon-${name}`;
  const provenance = { tool: 'blox image', model: meta.model, backend: meta.backend, prompt: meta.prompt, seed: meta.seed, ...extra, createdAt: new Date().toISOString() };
  // Re-read every time: a generation can run for minutes and other commands (asset sheet,
  // upload) write the manifest meanwhile; saving a copy loaded before the await would undo them.
  const m = loadManifest(P);
  const prev = m.assets.find((a) => a.id === id);
  if (prev) {
    // regenerated: new art needs a fresh human look
    Object.assign(prev, { licence: meta.licence, provenance, status: 'candidate', ref: { ...prev.ref, file } });
    delete prev.uploaded;
    saveManifest(P, m);
  } else {
    const a = addAsset(P, { id, kind: 'image', source: 'generated', licence: meta.licence, ref: { file }, provenance });
    if (!a.ok) throw new Error(`manifest: ${a.errors.join('; ')}`);
  }
  return file;
}

export async function generateImages(P: string, input: GenerateInput, o: { backends?: ImageBackend[]; onStatus?: (s: string) => void; cacheDir?: string | null } = {}): Promise<GenerateResult> {
  validateImages(P, input);
  const dir = input.dir ?? 'assets/icons';
  const style = styleOf(input);
  const size = input.size ?? 512;
  const notes: string[] = [];
  const backends = o.backends ?? defaultBackends();
  const cache = o.cacheDir ?? null;
  const refs = refsDigest(P, input.refs);
  const key = (it: ImageItem, b: BackendName) => cacheKey({ prompt: it.prompt, style, size, backend: b, seed: it.seed, refs });
  const out: GenerateResult = { backend: backends[0]?.name ?? DEFAULT_MODELS[0], written: [], failed: [], notes, cached: [] };
  const write = (it: ImageItem, png: Buffer, meta: ImageMeta) => {
    const file = recordImage(P, dir, it.name, png, { ...meta, prompt: it.prompt }, input.refs?.length ? { refs: input.refs } : {});
    out.written.push({ name: it.name, file, seed: meta.seed });
  };

  let todo = input.items;
  if (cache && !input.fresh) {
    todo = [];
    for (const it of input.items) {
      const hit = cached(P, input, it, backends, cache);
      if (!hit) { todo.push(it); continue; }
      const meta = JSON.parse(readFileSync(`${hit}.json`, 'utf8')) as ImageMeta;
      write(it, readFileSync(`${hit}.png`), meta);
      out.cached!.push(it.name);
      out.backend = meta.backend;
    }
    if (!todo.length) return out;
  }
  const kitems: BatchItem[] = todo.map((it) => ({ file: `${it.name}.png`, prompt: style ? `${it.prompt}. ${style}` : it.prompt, seed: it.seed }));
  const refFiles = input.refs?.map((r) => join(P, r));
  for (let b = 0; b < backends.length; b++) {
    const be = backends[b];
    let results: BatchResult[];
    try {
      results = await be.run(kitems, { size, refs: refFiles, onStatus: o.onStatus });
    } catch (e) {
      if (e instanceof KieError && b < backends.length - 1 && e.code !== 402 && e.code !== 401 && !/no kie\.ai key/.test(e.message)) {
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
      const meta: ImageMeta = { backend: be.name, model: r.model ?? be.model, licence: be.licence, seed: r.seed, prompt: it.prompt };
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

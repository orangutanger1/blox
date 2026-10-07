import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export async function generateImages(P: string, input: GenerateInput, o: { backends?: ImageBackend[]; onStatus?: (s: string) => void } = {}): Promise<GenerateResult> {
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
  const kitems: KernelItem[] = input.items.map((it) => ({ file: `${it.name}.png`, prompt: style ? `${it.prompt}. ${style}` : it.prompt, seed: it.seed ?? Math.floor(Math.random() * 2 ** 31) }));
  const notes: string[] = [];
  const backends = o.backends ?? defaultBackends();
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
    mkdirSync(join(P, dir), { recursive: true });
    const out: GenerateResult = { backend: be.name, written: [], failed: [], notes };
    const m = loadManifest(P);
    for (const it of input.items) {
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
      const file = `${dir}/${it.name}.png`;
      writeFileSync(join(P, file), png);
      const id = `icon-${it.name}`;
      const provenance = { tool: 'blox image', model: be.model, backend: be.name, prompt: it.prompt, seed: r.seed ?? kitems.find((k) => k.file === r.file)!.seed, createdAt: new Date().toISOString() };
      const prev = m.assets.find((a) => a.id === id);
      if (prev) {
        // regenerated: new art needs a fresh human look
        Object.assign(prev, { licence: be.licence, provenance, status: 'candidate', ref: { ...prev.ref, file } });
        delete prev.uploaded;
        saveManifest(P, m);
      } else {
        const a = addAsset(P, { id, kind: 'image', source: 'generated', licence: be.licence, ref: { file }, provenance });
        if (!a.ok) throw new Error(`manifest: ${a.errors.join('; ')}`);
        m.assets.push(a.entry);
      }
      out.written.push({ name: it.name, file, seed: provenance.seed });
    }
    return out;
  }
  throw new Error('image generate: no backend available');
}

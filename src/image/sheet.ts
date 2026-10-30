import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { bloxDir } from '../state/store.js';
import { cutout, sliceSheet } from './post.js';
import { cacheKey, DEFAULT_MODELS, defaultBackends, recordImage, refsDigest, STYLES, validateImages, type GenerateResult, type ImageBackend, type ImageItem } from './generate.js';
import { imageInput, kieDownload, kieRun, kieUpload, withRefsModel, type KieOptions } from './kie.js';

// Asset sheets: N items generated as ONE image on a grid (one style, one palette,
// one call's credits), then cut into transparent icons. References: turnaround,
// style or concept sheets the agent looks at before building and compares
// against after. Run: any other kie.ai model (video, audio, upscale, ...).

const RATIOS: [string, number][] = [['1:1', 1], ['3:2', 1.5], ['2:3', 2 / 3], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['2:1', 2], ['1:2', 0.5]];
export const aspectFor = (cols: number, rows: number) => RATIOS.reduce((a, b) => (Math.abs(Math.log(b[1] / (cols / rows))) < Math.abs(Math.log(a[1] / (cols / rows))) ? b : a))[0];

export function gridFor(n: number, cols?: number): { cols: number; rows: number } {
  const c = cols ?? Math.ceil(Math.sqrt(n));
  return { cols: c, rows: Math.ceil(n / c) };
}

export function sheetPrompt(items: ImageItem[], cols: number, rows: number, style: string): string {
  return [
    `An asset sheet of ${items.length} separate game assets in one consistent art style, laid out in a grid of ${cols} columns and ${rows} rows.`,
    'Each asset is centred in its own cell with wide empty space around it; nothing overlaps or touches, no grid lines, no labels, no text, no numbers.',
    `In reading order (left to right, top to bottom): ${items.map((it, i) => `${i + 1}. ${it.prompt}`).join('; ')}.`,
    style ? `Style for every asset: ${style}` : '',
  ].filter(Boolean).join(' ');
}

export interface SheetInput {
  name: string; // the sheet → assets/sheets/<name>.png
  items: ImageItem[]; // each cell → assets/icons/<item>.png
  style?: string;
  cols?: number;
  size?: number;
  refs?: string[];
  overwrite?: boolean;
  fresh?: boolean;
  dir?: string;
}
export interface SheetResult extends GenerateResult {
  sheet: string;
  grid: { cols: number; rows: number };
}

export async function generateSheet(P: string, input: SheetInput, o: { backends?: ImageBackend[]; cacheDir?: string | null; onStatus?: (s: string) => void } = {}): Promise<SheetResult> {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(input.name)) throw new Error(`sheet name "${input.name}": use lower-case letters, digits, - and _`);
  if (input.items.length < 2 || input.items.length > 16) throw new Error('image sheet: give 2–16 items (more gets too small to cut cleanly; split into several sheets)');
  validateImages(P, { items: input.items, overwrite: input.overwrite, dir: input.dir, refs: input.refs });
  const style = input.style === undefined ? STYLES.icon : (STYLES as Record<string, string>)[input.style] ?? input.style;
  const grid = gridFor(input.items.length, input.cols);
  const prompt = sheetPrompt(input.items, grid.cols, grid.rows, style);
  const backends = o.backends ?? defaultBackends();
  const sheet = `assets/sheets/${input.name}.png`;
  const out: SheetResult = { backend: backends[0]?.name ?? DEFAULT_MODELS[0], written: [], failed: [], notes: [], cached: [], sheet, grid };
  const cache = o.cacheDir ?? null;
  const refs = refsDigest(P, input.refs);
  let data: Buffer | undefined, be: ImageBackend | undefined, ran: string | undefined;
  for (const b of backends) {
    const f = cache && join(cache, cacheKey({ prompt, style: 'sheet', size: 0, backend: b.name, refs }));
    if (f && !input.fresh && existsSync(`${f}.png`)) {
      (data = readFileSync(`${f}.png`)), (be = b), out.cached!.push(input.name);
      break;
    }
  }
  if (!data) {
    for (const b of backends) {
      try {
        const [r] = await b.run([{ file: `${input.name}.png`, prompt }], { size: 0, refs: input.refs?.map((r) => join(P, r)), aspect: aspectFor(grid.cols, grid.rows), onStatus: o.onStatus });
        if (!r?.data) throw new Error(r?.error ?? 'no image returned');
        (data = r.data), (be = b), (ran = r.model);
        break;
      } catch (e) {
        out.notes.push(`${b.name}: ${(e as Error).message}`);
      }
    }
    if (!data || !be) throw new Error(`image sheet: no backend produced the sheet (${out.notes.join('; ')})`);
    if (cache) {
      mkdirSync(cache, { recursive: true });
      writeFileSync(`${join(cache, cacheKey({ prompt, style: 'sheet', size: 0, backend: be.name, refs }))}.png`, data);
    }
  }
  out.backend = be!.name;
  mkdirSync(join(P, 'assets/sheets'), { recursive: true });
  writeFileSync(join(P, sheet), data);
  const pieces = sliceSheet(data, grid.cols, grid.rows);
  const extra = pieces.slice(input.items.length).filter(Boolean).length;
  if (extra) out.notes.push(`${extra} extra cell(s) had art the sheet didn't ask for — ignored`);
  input.items.forEach((it, i) => {
    const piece = pieces[i];
    if (!piece) return void out.failed.push({ name: it.name, error: `cell ${i + 1} came back empty — look at ${sheet}; regenerate with fresh:true or fewer items` });
    const png = cutout(piece, { size: input.size ?? 512 });
    const file = recordImage(P, input.dir ?? 'assets/icons', it.name, png, { backend: be!.name, model: ran ?? be!.model, licence: be!.licence, prompt: it.prompt }, { sheet, cell: i + 1, ...(input.refs?.length ? { refs: input.refs } : {}) });
    out.written.push({ name: it.name, file });
  });
  return out;
}

export const REF_KINDS = {
  turnaround: { aspect: '16:9', text: (p: string) => `Character/model turnaround reference sheet of ${p}: front, right side, back and three-quarter views side by side, same scale and pose (neutral A-pose for characters), flat even lighting, plain light grey background, no text, no labels.` },
  style: { aspect: '16:9', text: (p: string) => `Art-direction style sheet for a Roblox game: ${p}. Colour palette swatches, a few sample props and materials, a sample UI button, panel and icon, all in one consistent style, plain light background, no text labels.` },
  concept: { aspect: '16:9', text: (p: string) => `Game concept art: ${p}. Clear readable shapes and colours, the way a Roblox game would look in play.` },
  ui: { aspect: '16:9', text: (p: string) => `Mobile game UI mockup, full screen, landscape: ${p}. Readable buttons and panels, consistent style, Roblox game.` },
} as const;

export interface RefInput {
  name: string;
  prompt: string;
  kind?: keyof typeof REF_KINDS | 'raw';
  refs?: string[];
  model?: string;
  aspect?: string;
}

// → .blox/refs/<name>.png: an opaque reference image for the agent, not a game asset.
export async function generateRef(P: string, input: RefInput, k: KieOptions = {}): Promise<{ file: string; model: string; credits?: number }> {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(input.name)) throw new Error(`ref name "${input.name}": use lower-case letters, digits, - and _`);
  for (const r of input.refs ?? []) if (!existsSync(join(P, r))) throw new Error(`reference image ${r} not found (paths are relative to the project)`);
  const kind = input.kind ?? 'concept';
  const prompt = kind === 'raw' ? input.prompt : REF_KINDS[kind].text(input.prompt);
  const refs = input.refs?.length ? await Promise.all(input.refs.map((r) => kieUpload(join(P, r), k))) : undefined;
  const base = input.model ?? DEFAULT_MODELS[0];
  const model = refs ? withRefsModel(base) : base;
  const r = await kieRun(model, imageInput(model, prompt, { refs, aspect: input.aspect ?? (kind === 'raw' ? '1:1' : REF_KINDS[kind].aspect) }), k);
  if (!r.urls[0]) throw new Error(`${model}: no image returned`);
  const file = `.blox/refs/${input.name}.png`;
  mkdirSync(join(bloxDir(P), 'refs'), { recursive: true });
  writeFileSync(join(P, file), await kieDownload(r.urls[0], k));
  writeFileSync(join(P, `.blox/refs/${input.name}.json`), JSON.stringify({ model, prompt, refs: input.refs ?? [], credits: r.credits, createdAt: new Date().toISOString() }, null, 2));
  return { file, model, credits: r.credits };
}

// Any kie.ai model. String values in `input` that name a project file are
// uploaded first (24 h KIE URLs), so image-to-video etc. take local paths.
export async function runModel(P: string, a: { model: string; input: Record<string, unknown>; name: string; timeoutSec?: number }, k: KieOptions = {}): Promise<{ files: string[]; response: Record<string, unknown>; credits?: number }> {
  const up = async (v: unknown): Promise<unknown> => {
    if (typeof v === 'string' && !/^https?:/.test(v) && /\.\w{2,4}$/.test(v) && existsSync(join(P, v))) return kieUpload(join(P, v), k);
    if (Array.isArray(v)) return Promise.all(v.map(up));
    return v;
  };
  const input: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(a.input)) input[key] = await up(v);
  const r = await kieRun(a.model, input, { ...k, timeoutSec: a.timeoutSec ?? 900 });
  const files: string[] = [];
  mkdirSync(join(P, 'assets/media'), { recursive: true });
  for (const [i, url] of r.urls.entries()) {
    const ext = extname(new URL(url).pathname) || '.bin';
    const file = `assets/media/${a.name}${r.urls.length > 1 ? `-${i + 1}` : ''}${ext}`;
    writeFileSync(join(P, file), await kieDownload(url, k));
    files.push(file);
  }
  return { files, response: r.response, credits: r.credits };
}

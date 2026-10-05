import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { decodePngRgba } from '../present/pixels.js';
import { encodePng } from '../present/square.js';

// Icon sheets: many small PNGs packed into one image, so a UI needs one upload
// (one moderation wait, one id) and code picks icons by ImageRectOffset.
// Writes the sheet PNG, a sidecar map (<sheet>.sheet.json) and a Luau module
// with the map; asset upload fills the module's image id in.

// Roblox downsizes uploads past 1024 px on a side.
const MAX_SIDE = 1024;

export interface SheetMap {
  image: string; // project-relative PNG
  module: string; // project-relative Luau module
  cell: number;
  icons: Record<string, [number, number]>;
}

export interface SheetInput {
  id: string;
  files: string[]; // project-relative PNGs (a directory expands to its PNGs)
  cell?: number; // px per icon (default 128); bigger icons are scaled down
  pad?: number; // transparent px around each icon inside its cell (default 2)
  out?: string; // sheet PNG path (default assets/ui/<id>.png)
  module?: string; // Luau module path (default <ReplicatedStorage dir>/Sheets/<id>.luau)
  imageId?: number; // uploaded image id to keep when the packed pixels and layout are unchanged
}

export function expandPngs(P: string, files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const full = join(P, f);
    if (!existsSync(full)) throw new Error(`no file ${f}`);
    if (statSync(full).isDirectory()) out.push(...readdirSync(full).filter((n) => /\.png$/i.test(n)).sort().map((n) => relative(P, join(full, n))));
    else out.push(relative(P, full));
  }
  return out.map((f) => f.split('\\').join('/'));
}

// Area-average resize of premultiplied RGBA so edges do not pick up dark fringes.
function fit(src: { w: number; h: number; rgba: Uint8Array }, box: number): { w: number; h: number; rgba: Uint8Array } {
  const k = Math.min(1, box / Math.max(src.w, src.h));
  if (k === 1) return src;
  const w = Math.max(1, Math.round(src.w * k)), h = Math.max(1, Math.round(src.h * k));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = (y * src.h) / h, y1 = ((y + 1) * src.h) / h;
    for (let x = 0; x < w; x++) {
      const x0 = (x * src.w) / w, x1 = ((x + 1) * src.w) / w;
      let r = 0, g = 0, b = 0, a = 0, area = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wgt = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          const i = (sy * src.w + sx) * 4;
          const al = src.rgba[i + 3] / 255;
          r += src.rgba[i] * al * wgt;
          g += src.rgba[i + 1] * al * wgt;
          b += src.rgba[i + 2] * al * wgt;
          a += al * wgt;
          area += wgt;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / area) * 255);
    }
  }
  return { w, h, rgba: out };
}

const iconName = (file: string) => basename(file, extname(file));

export function buildSheet(P: string, files: string[], cell = 128, pad = 2): { png: Buffer; w: number; h: number; icons: Record<string, [number, number]> } {
  if (!files.length) throw new Error('no PNGs to pack');
  if (cell < 8 || cell > MAX_SIDE) throw new Error(`cell must be 8..${MAX_SIDE}`);
  const names = files.map(iconName);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`two icons are named "${dup}" — rename one file`);
  const cols = Math.min(files.length, Math.floor(MAX_SIDE / cell));
  const rows = Math.ceil(files.length / cols);
  if (rows * cell > MAX_SIDE) throw new Error(`${files.length} icons at ${cell}px do not fit in ${MAX_SIDE}×${MAX_SIDE} (max ${Math.floor(MAX_SIDE / cell) ** 2}) — use a smaller cell or two sheets`);
  const w = cols * cell, h = rows * cell;
  const rgba = new Uint8Array(w * h * 4);
  const icons: Record<string, [number, number]> = {};
  files.forEach((f, i) => {
    const img = decodePngRgba(readFileSync(join(P, f)));
    if (!img) throw new Error(`${f}: not an 8-bit non-interlaced PNG (re-save it as one)`);
    const s = fit(img, cell - 2 * pad);
    const cx = (i % cols) * cell, cy = Math.floor(i / cols) * cell;
    const ox = cx + Math.floor((cell - s.w) / 2), oy = cy + Math.floor((cell - s.h) / 2);
    for (let y = 0; y < s.h; y++) rgba.set(s.rgba.subarray(y * s.w * 4, (y + 1) * s.w * 4), ((oy + y) * w + ox) * 4);
    icons[names[i]] = [cx, cy];
  });
  return { png: encodePng(w, h, rgba), w, h, icons };
}

export function sheetModule(id: string, map: SheetMap, imageId?: number): string {
  const keys = Object.entries(map.icons).map(([n, [x, y]]) => `\t[${JSON.stringify(n)}] = Vector2.new(${x}, ${y}),`);
  return [
    `-- Generated by blox asset sheet "${id}" from ${map.image}. Do not edit by hand:`,
    `-- re-run asset sheet to change the icons; asset upload fills in the image id.`,
    'local Sheet = {}',
    `Sheet.image = "rbxassetid://${imageId ?? 0}"${imageId ? '' : ' -- not uploaded yet'}`,
    `Sheet.cell = Vector2.new(${map.cell}, ${map.cell})`,
    'Sheet.icons = {',
    ...keys,
    '}',
    '',
    '-- Show icon `name` on an ImageLabel/ImageButton.',
    'function Sheet.apply(img: ImageLabel | ImageButton, name: string)',
    '\tlocal at = Sheet.icons[name]',
    '\tassert(at, "no icon " .. name .. " in sheet ' + id + '")',
    '\t-- one cast: luau cannot write a property through an ImageLabel | ImageButton union',
    '\tlocal i = img :: any',
    '\ti.Image = Sheet.image',
    '\ti.ImageRectOffset = at',
    '\ti.ImageRectSize = Sheet.cell',
    'end',
    '',
    'return Sheet',
    '',
  ].join('\n');
}

export function defaultModuleDir(P: string): string {
  try {
    const proj = JSON.parse(readFileSync(join(P, 'default.project.json'), 'utf8')) as { tree?: Record<string, { $path?: string }> };
    const rs = proj.tree?.ReplicatedStorage?.$path;
    if (rs) return rs;
  } catch {
    // no project file: fall back below
  }
  return 'src/ReplicatedStorage';
}

const sidecar = (image: string) => image.replace(/\.png$/i, '.sheet.json');

// unchanged: the sheet PNG and icon layout are byte-identical to what was on disk,
// so an earlier upload (input.imageId) still describes it and is kept in the module.
export function writeSheet(P: string, input: SheetInput): { map: SheetMap; w: number; h: number; files: string[]; unchanged: boolean } {
  const files = expandPngs(P, input.files);
  const cell = input.cell ?? 128;
  const built = buildSheet(P, files, cell, input.pad ?? 2);
  const image = input.out ?? `assets/ui/${input.id}.png`;
  const module = input.module ?? `${defaultModuleDir(P)}/Sheets/${input.id}.luau`;
  const map: SheetMap = { image, module, cell, icons: built.icons };
  const sideJson = JSON.stringify(map, null, 2) + '\n';
  const unchanged =
    existsSync(join(P, image)) && readFileSync(join(P, image)).equals(built.png) && existsSync(join(P, sidecar(image))) && readFileSync(join(P, sidecar(image)), 'utf8') === sideJson;
  const keepId = unchanged ? input.imageId : undefined;
  for (const [f, data] of [[image, built.png], [sidecar(image), sideJson], [module, sheetModule(input.id, map, keepId)]] as const) {
    mkdirSync(dirname(join(P, f)), { recursive: true });
    writeFileSync(join(P, f), data);
  }
  return { map, w: built.w, h: built.h, files, unchanged };
}

// After an upload resolves the sheet's image id, point the module at it.
export function setSheetImage(P: string, id: string, image: string | undefined, imageId: number): string | null {
  if (!image) return null;
  const side = join(P, sidecar(image));
  if (!existsSync(side)) return null;
  const map = JSON.parse(readFileSync(side, 'utf8')) as SheetMap;
  writeFileSync(join(P, map.module), sheetModule(id, map, imageId));
  return map.module;
}

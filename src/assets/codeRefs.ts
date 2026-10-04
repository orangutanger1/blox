import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Asset ids the game's own code references. Sounds, images and animations are
// often played straight from an id (`SoundId = "rbxassetid://…"`, an id table),
// so the place scan never sees them in use.
//   explicit: ids written as an asset url — unambiguously an asset.
//   numbers:  every integer literal long enough to be an asset id; only good for
//             matching against known ids (product, place and user ids look alike).

export interface CodeAssetRefs {
  explicit: Map<number, string[]>;
  numbers: Set<number>;
  files: Map<number, string[]>;
}

const URL_ID = /rbxassetid:\/\/(\d+)|roblox\.com\/asset\/?\?id=(\d+)|rbxthumb:\/\/[^"'\s]*?\bid=(\d+)/gi;
const NUMBER = /(?<![\w.])\d{6,}(?![\w.])/g;

// Specs under the top-level tests/ never ship, so their ids are not "in use".
function walk(dir: string, top = true): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.') || (top && entry === 'tests')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, false));
    else if (entry.endsWith('.luau') || entry.endsWith('.lua')) out.push(full);
  }
  return out;
}

// Source with comments blanked out; strings are kept (that is where urls live).
export function stripLuauComments(src: string): string {
  let out = '';
  let i = 0;
  const longClose = (at: number): string | null => {
    const m = /^\[(=*)\[/.exec(src.slice(at, at + 64));
    return m ? `]${m[1]}]` : null;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') {
      const close = longClose(i + 2);
      const end = close ? src.indexOf(close, i + 2) : src.indexOf('\n', i);
      i = end < 0 ? src.length : close ? end + close.length : end;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const close = c === '[' ? longClose(i) : null;
    if (close) {
      const end = src.indexOf(close, i);
      const stop = end < 0 ? src.length : end + close.length;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function codeAssetRefs(projectPath: string): CodeAssetRefs {
  const explicit = new Map<number, string[]>();
  const files = new Map<number, string[]>();
  const numbers = new Set<number>();
  const note = (map: Map<number, string[]>, id: number, file: string) => {
    const list = map.get(id) ?? [];
    if (!list.includes(file)) list.push(file);
    map.set(id, list);
  };
  for (const full of walk(projectPath)) {
    const file = relative(projectPath, full).split('\\').join('/');
    const src = stripLuauComments(readFileSync(full, 'utf8'));
    for (const m of src.matchAll(URL_ID)) note(explicit, Number(m[1] ?? m[2] ?? m[3]), file);
    for (const m of src.matchAll(NUMBER)) {
      const id = Number(m[0]);
      if (!Number.isSafeInteger(id)) continue;
      numbers.add(id);
      note(files, id, file);
    }
  }
  return { explicit, numbers, files };
}

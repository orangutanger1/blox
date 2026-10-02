import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldProject } from './scaffold.js';
import { readJson, writeJson } from './state/store.js';
import { formatErrors, validateDesign } from './design/schema.js';
import { renderTunables, TUNABLES_PATH } from './design/codegen.js';

// Format kits: proven-loop reference implementations (kits/<name>/) an agent
// drops into a project and then reskins/tunes. Same path from src/ and dist/.
export const KITS_ROOT = fileURLToPath(new URL('../kits/', import.meta.url));

export interface KitInfo {
  name: string;
  title: string;
  format: string;
  description: string;
  next: string[];
  // Kit whose files lay underneath this one (kit files win on conflicts).
  base?: string;
  // kits/_common (telemetry, BloxUI, economy) ships with the kit; default true.
  common?: boolean;
}

export function listKits(): KitInfo[] {
  if (!existsSync(KITS_ROOT)) return [];
  return readdirSync(KITS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(KITS_ROOT, e.name, 'kit.json')))
    .map((e) => JSON.parse(readFileSync(join(KITS_ROOT, e.name, 'kit.json'), 'utf8')) as KitInfo)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ApplyResult {
  kit: KitInfo;
  created: string[];
  kept: string[];
  designWritten: boolean;
  tunables: string | null; // error text when the project's design is invalid
  tunablesWritten: boolean;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

// Non-destructive: scaffolds what is missing, copies kit files that do not
// exist yet (the kit's own first, then kits/_common, then its base kit's, so
// the most specific file wins), writes .blox/design.json only when absent and
// the kit has one, then regenerates Tunables from whatever design the project has.
export function applyKit(projectPath: string, name: string): ApplyResult {
  const kits = listKits();
  const kit = kits.find((k) => k.name === name);
  if (!kit) throw new Error(`unknown kit "${name}" — available: ${kits.map((k) => k.name).join(', ') || '(none)'}`);
  const layers = [join(KITS_ROOT, name, 'files')];
  if (kit.common !== false) layers.push(join(KITS_ROOT, '_common', 'files'));
  for (let b = kit.base, seen = new Set([name]); b; ) {
    const base = kits.find((k) => k.name === b);
    if (!base || seen.has(b)) throw new Error(`kit "${name}": bad base "${b}"`);
    seen.add(b);
    layers.push(join(KITS_ROOT, b, 'files'));
    b = base.base;
  }
  const sc = scaffoldProject(projectPath);
  const created = [...sc.created];
  const kept: string[] = [];
  for (const files of layers) {
    if (!existsSync(files)) continue;
    for (const src of walk(files)) {
      const rel = relative(files, src).replace(/\\/g, '/');
      const dest = join(projectPath, rel);
      if (existsSync(dest)) {
        if (!created.includes(rel) && !kept.includes(rel)) kept.push(rel);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      created.push(rel);
    }
  }
  let designWritten = false;
  const kitDesign = join(KITS_ROOT, name, 'design.json');
  if (readJson(projectPath, 'design.json') === null && existsSync(kitDesign)) {
    writeJson(projectPath, 'design.json', JSON.parse(readFileSync(kitDesign, 'utf8')));
    designWritten = true;
  }
  let tunables: string | null = null;
  let tunablesWritten = false;
  const design = readJson(projectPath, 'design.json');
  if (design !== null) {
    const v = validateDesign(design);
    if (v.ok) {
      const f = join(projectPath, TUNABLES_PATH);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, renderTunables(v.doc));
      tunablesWritten = true;
    } else tunables = `design.json is invalid, Tunables not regenerated:\n${formatErrors(v.errors)}`;
  }
  return { kit, created, kept, designWritten, tunables, tunablesWritten };
}

export function formatApply(r: ApplyResult): string {
  const lines = [
    `kit ${r.kit.name}: ${r.created.length} file(s) created, ${r.kept.length} kept (existing files are never overwritten)`,
    r.designWritten ? 'wrote .blox/design.json (kit defaults)' : r.tunablesWritten || r.tunables ? 'kept existing .blox/design.json' : 'no design.json (framework only)',
    ...(r.tunables ? [r.tunables] : r.tunablesWritten ? [`regenerated ${TUNABLES_PATH}`] : []),
    'Next:',
    ...r.kit.next.map((n, i) => `  ${i + 1}. ${n}`),
  ];
  return lines.join('\n');
}

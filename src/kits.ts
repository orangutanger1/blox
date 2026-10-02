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
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

// Non-destructive: scaffolds what is missing, copies kit files that do not
// exist yet, writes .blox/design.json only when absent, then regenerates
// Tunables from whatever design the project has.
export function applyKit(projectPath: string, name: string): ApplyResult {
  const kit = listKits().find((k) => k.name === name);
  if (!kit) throw new Error(`unknown kit "${name}" — available: ${listKits().map((k) => k.name).join(', ') || '(none)'}`);
  const root = join(KITS_ROOT, name);
  const sc = scaffoldProject(projectPath);
  const created = [...sc.created];
  const kept: string[] = [];
  const files = join(root, 'files');
  for (const src of walk(files)) {
    const rel = relative(files, src).replace(/\\/g, '/');
    const dest = join(projectPath, rel);
    if (existsSync(dest)) {
      kept.push(rel);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    created.push(rel);
  }
  let designWritten = false;
  if (readJson(projectPath, 'design.json') === null) {
    writeJson(projectPath, 'design.json', JSON.parse(readFileSync(join(root, 'design.json'), 'utf8')));
    designWritten = true;
  }
  let tunables: string | null = null;
  const v = validateDesign(readJson(projectPath, 'design.json'));
  if (v.ok) {
    const f = join(projectPath, TUNABLES_PATH);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, renderTunables(v.doc));
  } else tunables = `design.json is invalid, Tunables not regenerated:\n${formatErrors(v.errors)}`;
  return { kit, created, kept, designWritten, tunables };
}

export function formatApply(r: ApplyResult): string {
  const lines = [
    `kit ${r.kit.name}: ${r.created.length} file(s) created, ${r.kept.length} kept (existing files are never overwritten)`,
    r.designWritten ? 'wrote .blox/design.json (kit defaults)' : 'kept existing .blox/design.json',
    r.tunables ?? `regenerated ${TUNABLES_PATH}`,
    'Next:',
    ...r.kit.next.map((n, i) => `  ${i + 1}. ${n}`),
  ];
  return lines.join('\n');
}

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

export type ScriptKind = 'Script (server)' | 'LocalScript (client)' | 'ModuleScript';

export interface ScriptEntry {
  path: string; // project-relative, as today
  kind: ScriptKind;
}

export interface ScriptGroup {
  service: string;        // e.g. 'ReplicatedStorage', or ROOT_GROUP
  scripts: ScriptEntry[]; // sorted by path; truncated to MAX_PER_GROUP
  total: number;          // true count before truncation
}

export interface ProjectDigest {
  name: string;
  tree: string[];
  scripts: string[];     // retained flat path list (back-compat)
  groups: ScriptGroup[]; // grouped, type-tagged, bounded
}

// Max scripts listed per service group; the overflow is summarized.
export const MAX_PER_GROUP = 30;

// Group name for scripts matching no service $path mapping.
export const ROOT_GROUP = '(root)';

// Classify a script by its Rojo filename suffix (case-insensitive extension).
export function classifyKind(path: string): ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.server.luau') || lower.endsWith('.server.lua')) return 'Script (server)';
  if (lower.endsWith('.client.luau') || lower.endsWith('.client.lua')) return 'LocalScript (client)';
  return 'ModuleScript';
}

export interface ServicePath {
  service: string;
  prefix: string; // a file path (exact match) or a directory (prefix match)
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

// Recursively collect every $path in the project tree, each tagged with its
// top-level service ancestor (the DataModel child key it lives under).
export function collectServicePaths(tree: Record<string, unknown>): ServicePath[] {
  const out: ServicePath[] = [];
  for (const [key, val] of Object.entries(tree)) {
    if (key.startsWith('$')) continue;
    walkService(key, val, out);
  }
  return out;
}

function walkService(service: string, node: unknown, out: ServicePath[]): void {
  if (node === null || typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;
  const p = rec['$path'];
  if (typeof p === 'string') out.push({ service, prefix: normalizePath(p) });
  for (const [k, v] of Object.entries(rec)) {
    if (k.startsWith('$')) continue;
    walkService(service, v, out);
  }
}

function walkLuau(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkLuau(full));
    else if (entry.endsWith('.luau') || entry.endsWith('.lua')) out.push(full);
  }
  return out;
}

export function buildDigest(projectPath: string): ProjectDigest {
  const projFile = resolve(projectPath, 'default.project.json');
  if (!existsSync(projFile)) {
    throw new Error(`No default.project.json in ${projectPath}`);
  }
  const proj = JSON.parse(readFileSync(projFile, 'utf8')) as {
    name?: string;
    tree?: Record<string, unknown>;
  };
  const tree = Object.keys(proj.tree ?? {}).filter((k) => !k.startsWith('$'));
  const scripts = walkLuau(projectPath)
    .map((p) => relative(projectPath, p))
    .sort();
  return { name: proj.name ?? 'unnamed', tree, scripts };
}

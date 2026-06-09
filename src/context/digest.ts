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

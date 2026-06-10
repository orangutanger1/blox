// src/onboard/layout.ts
import type { PulledScript } from './pull.js';

export type ConflictStrategy = 'abort' | 'suffix';

export interface WriteFile {
  path: string; // project-relative, POSIX separators
  source: string;
}
export interface Conflict {
  fullName: string;
  path: string;
  reason: 'duplicate-path';
}
export interface Renamed {
  fullName: string;
  from: string;
  to: string;
}
export interface ProjectJson {
  name: string;
  tree: Record<string, unknown>;
}
export interface LayoutPlan {
  files: WriteFile[];
  project: ProjectJson;
  conflicts: Conflict[];
  renamed: Renamed[];
}

export function classToSuffix(className: PulledScript['className']): string {
  if (className === 'Script') return '.server.luau';
  if (className === 'LocalScript') return '.client.luau';
  return '.luau';
}

const ILLEGAL = /[/\\:*?"<>|\x00-\x1f]/g;
export function sanitizeName(name: string): string {
  return name.replace(ILLEGAL, '_');
}

function stripGamePrefix(fullName: string): string {
  return fullName.replace(/^game\./i, '');
}

// Build the POSIX file path for a script. A script that is itself an ancestor of
// another script becomes a directory holding init<suffix>.luau (Rojo convention).
function filePathFor(script: PulledScript, allFullNames: Set<string>): string {
  const full = stripGamePrefix(script.fullName);
  const parts = full.split('.');
  const suffix = classToSuffix(script.className);
  const dirSegs = parts.slice(0, -1).map(sanitizeName); // service + ancestor dirs
  const leaf = sanitizeName(parts[parts.length - 1]);
  const isContainer = [...allFullNames].some((n) => stripGamePrefix(n).startsWith(full + '.'));
  if (isContainer) {
    return ['src', ...dirSegs, leaf, `init${suffix}`].join('/');
  }
  return ['src', ...dirSegs, `${leaf}${suffix}`].join('/');
}

export function planLayout(
  scripts: PulledScript[],
  strategy: ConflictStrategy,
  name: string,
): LayoutPlan {
  const allFullNames = new Set(scripts.map((s) => s.fullName));
  // Pair each script with its desired path, in stable input order.
  const desired = scripts.map((s) => ({ script: s, path: filePathFor(s, allFullNames) }));

  // Group by path to find collisions.
  const byPath = new Map<string, typeof desired>();
  for (const d of desired) {
    const arr = byPath.get(d.path);
    if (arr) arr.push(d);
    else byPath.set(d.path, [d]);
  }

  const files: WriteFile[] = [];
  const conflicts: Conflict[] = [];
  const renamed: Renamed[] = [];

  for (const d of desired) {
    const group = byPath.get(d.path)!;
    if (group.length === 1) {
      files.push({ path: d.path, source: d.script.source });
      continue;
    }
    // Collision.
    if (strategy === 'abort') {
      conflicts.push({ fullName: d.script.fullName, path: d.path, reason: 'duplicate-path' });
      continue;
    }
    // suffix: first occurrence keeps the path; later ones get _2, _3, ... inserted
    // before the Rojo suffix (.server.luau / .client.luau / .luau).
    const idx = group.indexOf(d);
    if (idx === 0) {
      files.push({ path: d.path, source: d.script.source });
    } else {
      const m = d.path.match(/^(.*?)(\.(?:server|client)\.luau|\.luau)$/)!;
      const to = `${m[1]}_${idx + 1}${m[2]}`;
      files.push({ path: to, source: d.script.source });
      renamed.push({ fullName: d.script.fullName, from: d.path, to });
    }
  }

  // project.json: one entry per service that contributed at least one written file.
  // On an abort-with-conflicts plan, `files` is empty, so only the DataModel root
  // is emitted (the writer writes nothing anyway).
  const writtenServices = new Set(files.map((f) => f.path.split('/')[1]));
  const tree: Record<string, unknown> = { $className: 'DataModel' };
  for (const svc of [...writtenServices].sort()) {
    tree[svc] = { $path: `src/${svc}` };
  }

  return { files, project: { name, tree }, conflicts, renamed };
}

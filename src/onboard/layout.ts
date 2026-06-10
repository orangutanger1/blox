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

  if (strategy === 'abort') {
    for (const d of desired) {
      const group = byPath.get(d.path)!;
      if (group.length === 1) {
        files.push({ path: d.path, source: d.script.source });
      } else {
        conflicts.push({ fullName: d.script.fullName, path: d.path, reason: 'duplicate-path' });
      }
    }
  } else {
    // suffix: every script gets a unique path. The first claimant keeps its
    // natural path; any later script whose path is already taken gets _2, _3, ...
    // inserted before the Rojo suffix, bumping until free. The free-path check is
    // against ALL claimed paths, so a generated _N never silently overwrites a
    // real _N-named sibling.
    const taken = new Set<string>();
    for (const d of desired) {
      let candidate = d.path;
      if (taken.has(candidate)) {
        const m = d.path.match(/^(.*?)(\.(?:server|client)\.luau|\.luau)$/)!;
        let n = 2;
        do {
          candidate = `${m[1]}_${n}${m[2]}`;
          n++;
        } while (taken.has(candidate));
        renamed.push({ fullName: d.script.fullName, from: d.path, to: candidate });
      }
      taken.add(candidate);
      files.push({ path: candidate, source: d.script.source });
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

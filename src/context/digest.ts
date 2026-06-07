import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

export interface ProjectDigest {
  name: string;
  tree: string[];
  scripts: string[];
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

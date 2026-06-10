// src/onboard/write.ts
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realSpawn, type SpawnFn } from '../sync/rojo.js';
import { commitChanges } from '../git/commit.js';
import type { LayoutPlan } from './layout.js';

export interface WriteOptions {
  force: boolean;
  spawn?: SpawnFn;
}
export interface WriteResult {
  written: string[];
  baselineSha: string | null;
  refused?: boolean;
  conflictsAborted?: boolean;
}

export async function writePlan(
  projectPath: string,
  plan: LayoutPlan,
  opts: WriteOptions,
): Promise<WriteResult> {
  const spawn = opts.spawn ?? realSpawn;

  if (plan.conflicts.length > 0) {
    return { written: [], baselineSha: null, conflictsAborted: true };
  }
  if (plan.files.length === 0) {
    // Empty DataModel: nothing to onboard. Write nothing (no project file, no
    // baseline commit); the caller reports "nothing to onboard".
    return { written: [], baselineSha: null };
  }
  if (existsSync(join(projectPath, 'default.project.json')) && !opts.force) {
    return { written: [], baselineSha: null, refused: true };
  }

  const written: string[] = [];
  for (const f of plan.files) {
    const abs = join(projectPath, ...f.path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.source, 'utf8');
    written.push(f.path);
  }
  writeFileSync(
    join(projectPath, 'default.project.json'),
    JSON.stringify(plan.project, null, 2) + '\n',
    'utf8',
  );

  // git baseline: init (idempotent) then commit the pulled state.
  await spawn('git', ['init'], { cwd: projectPath });
  const commit = await commitChanges(projectPath, `blox: onboard ${plan.project.name} from Studio`, spawn);
  return { written, baselineSha: commit.sha };
}

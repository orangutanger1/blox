import { realSpawn, type SpawnFn } from '../sync/rojo.js';

export interface CommitResult {
  sha: string | null;
  files: string[];
}

export async function commitChanges(
  projectPath: string,
  message: string,
  spawn: SpawnFn = realSpawn,
): Promise<CommitResult> {
  const status = await spawn('git', ['status', '--porcelain'], { cwd: projectPath });
  const files = status.stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  if (files.length === 0) return { sha: null, files: [] };

  await spawn('git', ['add', '-A'], { cwd: projectPath });
  const commit = await spawn('git', ['commit', '-m', message], { cwd: projectPath });
  if (commit.code !== 0) return { sha: null, files };

  const rev = await spawn('git', ['rev-parse', 'HEAD'], { cwd: projectPath });
  return { sha: rev.stdout.trim() || null, files };
}

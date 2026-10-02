import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { bloxDir, readJson, writeJson } from '../state/store.js';
import { NO_KEY, OpenCloud, openCloudKey } from '../opencloud/client.js';
import { defaultSpawn, type Spawner } from '../assets/blender.js';
import { releaseCheck } from './check.js';

// Build → human approval bound to the build hash → publish (confirm + key).

export const BUILD_REL = '.blox/build/place.rbxl';

const Target = z.object({ universeId: z.number().int().positive(), placeId: z.number().int().positive() }).strict();
export type ReleaseTarget = z.infer<typeof Target>;

export function loadTarget(projectPath: string): ReleaseTarget {
  const raw = readJson<unknown>(projectPath, 'release.json');
  const v = Target.safeParse(raw);
  if (!v.success) throw new Error('set .blox/release.json to {"universeId": N, "placeId": N} (from Creator Hub; a human decides which experience this ships to)');
  return v.data;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export async function buildPlace(projectPath: string, o: { spawn?: Spawner } = {}): Promise<{ file: string; sha256: string; notes: string[] }> {
  const out = join(projectPath, BUILD_REL);
  mkdirSync(join(projectPath, '.blox/build'), { recursive: true });
  const r = await (o.spawn ?? defaultSpawn)(process.env.BLOX_ROJO || 'rojo', ['build', projectPath, '--output', out]);
  if (r.notFound) throw new Error('rojo not found — install Rojo 7 (or set BLOX_ROJO)');
  if (r.code !== 0) throw new Error(`rojo build failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  if (!existsSync(out)) throw new Error('rojo build produced no file');
  const notes: string[] = [];
  const world = join(projectPath, 'world');
  if (existsSync(world) && readdirSync(world).some((f) => f.endsWith('.luau')))
    notes.push('world/ builders run inside Studio, so this Rojo build does not contain them — publish from Studio (File → Publish) if the map comes from world/ builders');
  return { file: BUILD_REL, sha256: sha(readFileSync(out)), notes };
}

// CLI-only (`blox release approve`): a human signs off on this exact build.
export function approveRelease(projectPath: string): string {
  const f = join(projectPath, BUILD_REL);
  if (!existsSync(f)) throw new Error('no build to approve — run `blox release build` first');
  const sha256 = sha(readFileSync(f));
  writeJson(projectPath, 'release-approval.json', { sha256, approvedAt: new Date().toISOString() });
  return sha256;
}

export async function publishRelease(projectPath: string, o: { confirm?: boolean; client?: OpenCloud } = {}): Promise<{ dryRun: true; target: ReleaseTarget; sha256: string } | { dryRun: false; versionNumber?: number; sha256: string }> {
  const check = releaseCheck(projectPath);
  if (!check.ready) throw new Error(`not ready to publish: ${check.gates.filter((g) => g.required && g.status !== 'pass').map((g) => `${g.id} ${g.status}`).join(', ')}`);
  const f = join(projectPath, BUILD_REL);
  if (!existsSync(f)) throw new Error('no build — release {action:"build"} first');
  const buf = readFileSync(f);
  const sha256 = sha(buf);
  const approval = readJson<{ sha256: string }>(projectPath, 'release-approval.json');
  if (approval?.sha256 !== sha256) throw new Error('this build is not approved: a human runs `blox release approve` after reviewing it (approval is bound to the build hash)');
  const target = loadTarget(projectPath);
  if (!o.confirm) return { dryRun: true, target, sha256 };
  if (!o.client && !openCloudKey()) throw new Error(NO_KEY);
  const client = o.client ?? new OpenCloud();
  const r = await client.publishPlace(target.universeId, target.placeId, buf);
  appendFileSync(join(bloxDir(projectPath), 'release-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), sha256, ...target, versionNumber: r.versionNumber }) + '\n');
  return { dryRun: false, versionNumber: r.versionNumber, sha256 };
}

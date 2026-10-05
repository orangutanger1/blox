import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// .blox/research/<date>.json (device all) or <date>.<device>.json — one chart
// snapshot per day and device, so a device switch doesn't overwrite. Facts
// only: what the public Roblox APIs said; stats and themes are derived on read.

export interface SnapPass { name: string; price: number }
export interface SnapGame {
  universeId: number;
  name: string;
  description: string;
  ccu: number;
  up: number;
  down: number;
  visits: number;
  maxPlayers: number;
  created: string;
  genre: string;
  subgenre: string;
  creator: string;
  sorts: string[];
  passes: SnapPass[] | null; // null = not fetched (outside top 40 or the call failed)
}
export interface Snapshot {
  version: 1;
  at: string;
  date: string;
  device: string;
  sorts: string[];
  games: SnapGame[];
  notes: string[];
}

const dir = (P: string) => join(P, '.blox', 'research');

// File key: the date for device "all", else date.device.
export const snapshotKey = (date: string, device: string) => (device === 'all' ? date : `${date}.${device}`);
const keyOf = (s: Snapshot) => snapshotKey(s.date, s.device);

export function saveSnapshot(projectPath: string, s: Snapshot): string {
  mkdirSync(dir(projectPath), { recursive: true });
  const f = join(dir(projectPath), `${keyOf(s)}.json`);
  writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2));
  renameSync(`${f}.tmp`, f);
  return join('.blox', 'research', `${keyOf(s)}.json`);
}

export function listSnapshots(projectPath: string): string[] {
  if (!existsSync(dir(projectPath))) return [];
  return readdirSync(dir(projectPath))
    .filter((f) => /^\d{4}-\d{2}-\d{2}(\.[a-z_]+)?\.json$/.test(f))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

export function loadSnapshot(projectPath: string, key: string): Snapshot | null {
  const f = join(dir(projectPath), `${key}.json`);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Snapshot;
  } catch {
    return null;
  }
}

// The most recently fetched snapshot, any device.
export function latestSnapshot(projectPath: string): Snapshot | null {
  let best: Snapshot | null = null;
  for (const k of listSnapshots(projectPath)) {
    const s = loadSnapshot(projectPath, k);
    if (s && (!best || s.at > best.at)) best = s;
  }
  return best;
}

// The newest earlier snapshot for the same device (theme deltas compare like with like).
export function previousSnapshot(projectPath: string, date: string, device = 'all'): Snapshot | null {
  const keys = listSnapshots(projectPath).filter((k) => k.slice(0, 10) < date && k === snapshotKey(k.slice(0, 10), device));
  const k = keys.at(-1);
  return k ? loadSnapshot(projectPath, k) : null;
}

export { keyOf as snapshotKeyOf };

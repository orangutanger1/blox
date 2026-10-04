import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// .blox/research/<date>.json — one chart snapshot per day (and device). Facts
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

export function saveSnapshot(projectPath: string, s: Snapshot): string {
  mkdirSync(dir(projectPath), { recursive: true });
  const f = join(dir(projectPath), `${s.date}.json`);
  writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2));
  renameSync(`${f}.tmp`, f);
  return join('.blox', 'research', `${s.date}.json`);
}

export function listSnapshots(projectPath: string): string[] {
  if (!existsSync(dir(projectPath))) return [];
  return readdirSync(dir(projectPath))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

export function loadSnapshot(projectPath: string, date: string): Snapshot | null {
  const f = join(dir(projectPath), `${date}.json`);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Snapshot;
  } catch {
    return null;
  }
}

export function latestSnapshot(projectPath: string): Snapshot | null {
  const d = listSnapshots(projectPath).at(-1);
  return d ? loadSnapshot(projectPath, d) : null;
}

export function previousSnapshot(projectPath: string, date: string): Snapshot | null {
  const d = listSnapshots(projectPath).filter((x) => x < date).at(-1);
  return d ? loadSnapshot(projectPath, d) : null;
}

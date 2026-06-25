import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface AuditEntry {
  ts: string;
  user: string;
  model: string;
  turns: number;
  costUsd: number;
  status: 'success' | 'error';
  commit: string | null;
  prompt: string;
  stopReason?: string;
}

export function auditPath(projectPath: string): string {
  return join(projectPath, '.blox', 'audit.jsonl');
}

export function appendJsonl(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(obj) + '\n');
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip malformed */ }
  }
  return out;
}

export function appendAuditEntry(projectPath: string, entry: AuditEntry): void {
  appendJsonl(auditPath(projectPath), entry);
}

export function readAuditEntries(projectPath: string): AuditEntry[] {
  return readJsonl<AuditEntry>(auditPath(projectPath));
}

export function readWindowSpend(projectPath: string, windowDays: number, now: Date = new Date()): number {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  let sum = 0;
  for (const e of readAuditEntries(projectPath)) {
    const t = Date.parse(e.ts);
    if (!Number.isNaN(t) && t >= cutoff && typeof e.costUsd === 'number') sum += e.costUsd;
  }
  return sum;
}

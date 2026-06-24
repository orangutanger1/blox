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

export function appendAuditEntry(projectPath: string, entry: AuditEntry): void {
  const path = auditPath(projectPath);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n');
}

export function readAuditEntries(projectPath: string): AuditEntry[] {
  const path = auditPath(projectPath);
  if (!existsSync(path)) return [];
  const out: AuditEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      // skip malformed line — visibility is best-effort
    }
  }
  return out;
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

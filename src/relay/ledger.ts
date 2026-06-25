import type { AuditEntry } from '../audit.js';
import { appendJsonl, readJsonl } from '../audit.js';

export interface RelayEntry extends AuditEntry {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  unknownPrice?: boolean;
}

export function appendRelayEntry(ledgerPath: string, entry: RelayEntry): void {
  appendJsonl(ledgerPath, entry);
}

export function readRelayEntries(ledgerPath: string): RelayEntry[] {
  return readJsonl<RelayEntry>(ledgerPath);
}

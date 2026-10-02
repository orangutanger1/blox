import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnce } from '../src/run.js';
import { readJsonl, auditPath, type AuditEntry } from '../src/audit.js';
import type { BloxConfig } from '../src/config.js';

describe('runOnce — routed model cost', () => {
  it('records cost as unknown instead of the SDK\'s Claude-priced estimate', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'blox-rc-'));
    const buildMod = await import('../src/agent/buildOptions.js');
    const runMod = await import('../src/agent/runAgent.js');
    const syncMod = await import('../src/sync/rojo.js');
    const b = vi.spyOn(buildMod, 'buildQueryOptions').mockReturnValue({} as never);
    const r = vi.spyOn(runMod, 'runAgent').mockResolvedValue({
      numTurns: 12, costUsd: 1.64, status: 'success', stopReason: 'completed', detail: 'success',
      sessionId: null, gatedActions: [], deniedByUser: [], nonGatedDenials: [],
    });
    const s = vi.spyOn(syncMod, 'syncProject').mockResolvedValue({ ok: false, detail: 'skip' } as never);
    try {
      const cfg = { projectPath, model: 'openrouter,openai/gpt-6-luna', maxTurns: 40, maxBudgetUsd: 5, mode: 'auto' } as BloxConfig;
      const rep = await runOnce(cfg, 'x', { bridge: {} as never, digest: {} as never });
      expect(rep).toMatchObject({ costUsd: 0, costUnknown: true, numTurns: 12 });
      expect(readJsonl<AuditEntry>(auditPath(projectPath))[0]).toMatchObject({ costUsd: 0, costUnknown: true });
    } finally {
      b.mockRestore(); r.mockRestore(); s.mockRestore();
    }
  });
});

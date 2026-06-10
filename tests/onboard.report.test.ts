import { describe, it, expect } from 'vitest';
import { formatOnboardReport } from '../src/onboard/report.js';

describe('formatOnboardReport', () => {
  it('summarizes a successful onboard with next steps', () => {
    const out = formatOnboardReport({
      written: ['src/ReplicatedStorage/Mod.luau', 'src/ServerScriptService/Hello.server.luau'],
      baselineSha: 'abc123',
      renamed: [],
      conflicts: [],
    });
    expect(out).toContain('onboarded 2 scripts');
    expect(out).toContain('baseline: abc123');
    expect(out).toContain('rojo serve');
  });

  it('lists conflicts and tells the user how to resolve them', () => {
    const out = formatOnboardReport({
      written: [],
      baselineSha: null,
      renamed: [],
      conflicts: [{ fullName: 'ReplicatedStorage.Dup', path: 'src/ReplicatedStorage/Dup.luau', reason: 'duplicate-path' }],
    });
    expect(out).toContain('conflicts (nothing written):');
    expect(out).toContain('ReplicatedStorage.Dup');
    expect(out).toContain('--on-conflict suffix');
  });

  it('reports renames under the suffix strategy', () => {
    const out = formatOnboardReport({
      written: ['src/X/Dup.luau', 'src/X/Dup_2.luau'],
      baselineSha: 'sha',
      renamed: [{ fullName: 'X.Dup', from: 'src/X/Dup.luau', to: 'src/X/Dup_2.luau' }],
      conflicts: [],
    });
    expect(out).toContain('renamed 1');
  });

  it('handles the empty (nothing to onboard) case', () => {
    const out = formatOnboardReport({ written: [], baselineSha: null, renamed: [], conflicts: [] });
    expect(out).toContain('nothing to onboard');
  });
});

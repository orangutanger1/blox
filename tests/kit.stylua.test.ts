import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A fresh `kit apply` must pass `check` (stylua) without the agent reformatting kit code.
const KITS = fileURLToPath(new URL('../kits/', import.meta.url));
const has = spawnSync('stylua', ['--version']).status === 0;

describe.skipIf(!has)('kit sources are stylua-clean', () => {
  it('every kit .luau outside vendored packages passes stylua --check', () => {
    const r = spawnSync(
      'stylua',
      ['--check', '--config-path', `${KITS}boilerplate/files/.stylua.toml`, '--glob', '**/*.luau', '--glob', '!**/Packages/**', '--glob', '!**/ServerPackages/**', KITS],
      { encoding: 'utf8' },
    );
    const files = (r.stdout.match(/^Diff in .*$/gm) ?? []).join('\n');
    expect(files, files).toBe('');
  });
});

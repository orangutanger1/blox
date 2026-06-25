import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relayMemberCommand } from '../src/relay/cli.js';

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blox-'));
  mkdirSync(join(dir, '.blox'), { recursive: true });
  writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({ relay: {} }));
  return dir;
}

describe('relayMemberCommand', () => {
  it('add prints a blx_ token once, list then shows the email', () => {
    const dir = project();
    const added = relayMemberCommand('add', dir, 'alice@team.com');
    expect(added).toMatch(/blx_/);
    expect(relayMemberCommand('list', dir)).toContain('alice@team.com');
  });
  it('rm removes a member', () => {
    const dir = project();
    relayMemberCommand('add', dir, 'alice@team.com');
    expect(relayMemberCommand('rm', dir, 'alice@team.com')).toMatch(/removed/i);
    expect(relayMemberCommand('list', dir)).not.toContain('alice@team.com');
  });
});

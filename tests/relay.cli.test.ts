import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAbsolute } from 'node:path';
import { relayMemberCommand, resolveRelayServe, resolveRelayPaths } from '../src/relay/cli.js';
import { loadConfig } from '../src/config.js';
import { loadMembers, authMember } from '../src/relay/members.js';

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blox-'));
  mkdirSync(join(dir, '.blox'), { recursive: true });
  writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({ relay: {} }));
  return dir;
}

function projectNoRelay(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blox-'));
  mkdirSync(join(dir, '.blox'), { recursive: true });
  writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({}));
  return dir;
}

function projectWithApiKeyEnv(apiKeyEnv: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'blox-'));
  mkdirSync(join(dir, '.blox'), { recursive: true });
  writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({ relay: { apiKeyEnv } }));
  return dir;
}

describe('relayMemberCommand', () => {
  it('add prints a blx_ token once, list then shows the email but NOT the raw token', () => {
    const dir = project();
    const added = relayMemberCommand('add', dir, 'alice@team.com');
    expect(added).toMatch(/blx_/);
    const tokenMatch = added.match(/blx_\S+/);
    const token = tokenMatch?.[0];
    expect(token).toBeTruthy();
    const listOut = relayMemberCommand('list', dir);
    expect(listOut).toContain('alice@team.com');
    expect(listOut).not.toContain(token!);
  });
  it('rm removes a member', () => {
    const dir = project();
    relayMemberCommand('add', dir, 'alice@team.com');
    expect(relayMemberCommand('rm', dir, 'alice@team.com')).toMatch(/removed/i);
    expect(relayMemberCommand('list', dir)).not.toContain('alice@team.com');
  });
});

describe('resolveRelayServe', () => {
  it('returns error matching /relay/ when config has no relay block', () => {
    const dir = projectNoRelay();
    const config = loadConfig(dir, { projectPath: dir });
    const result = resolveRelayServe(config, {});
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/relay/);
  });

  it('returns error matching /API key/ when relay block exists but env var is unset', () => {
    const dir = projectWithApiKeyEnv('NOPE_KEY');
    const config = loadConfig(dir, { projectPath: dir });
    const result = resolveRelayServe(config, {});
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/API key/i);
  });

  it('returns realKey when env var IS set', () => {
    const dir = projectWithApiKeyEnv('NOPE_KEY');
    const config = loadConfig(dir, { projectPath: dir });
    const result = resolveRelayServe(config, { NOPE_KEY: 'sk-test' });
    expect('realKey' in result).toBe(true);
    if ('realKey' in result) expect(result.realKey).toBe('sk-test');
  });
});

describe('resolveRelayPaths', () => {
  it('resolves the members file serve reads to the SAME file add-member wrote (project root, not cwd)', () => {
    // Reproduces the bug: add-member resolved paths against the project root,
    // but serve resolved the relative config path against the process CWD.
    const dir = project();
    const token = relayMemberCommand('add', dir, 'alice@team.com').match(/blx_\S+/)![0];
    const relay = resolveRelayPaths(loadConfig(dir, { projectPath: dir }));
    expect(isAbsolute(relay.membersPath)).toBe(true);
    expect(relay.membersPath.startsWith(dir)).toBe(true);
    expect(authMember(loadMembers(relay.membersPath), token)).toBe('alice@team.com');
    expect(isAbsolute(relay.ledgerPath)).toBe(true);
    expect(relay.ledgerPath.startsWith(dir)).toBe(true);
  });

  it('honors an absolute configured path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    mkdirSync(join(dir, '.blox'), { recursive: true });
    const abs = join(dir, 'custom', 'm.json');
    writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({ relay: { membersPath: abs } }));
    const relay = resolveRelayPaths(loadConfig(dir, { projectPath: dir }));
    expect(relay.membersPath).toBe(abs);
  });
});

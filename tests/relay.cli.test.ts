import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relayMemberCommand, resolveRelayServe } from '../src/relay/cli.js';
import { loadConfig } from '../src/config.js';

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

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadAuthStore, saveAuthStore, setApiKey, clearApiKey, setMode,
  effectiveAuthMode, buildAuthEnv, authConfigDir, authStorePath,
  runClaudeAuth, readSubscriptionStatus, formatAuthStatus, type ClaudeRunner,
} from '../src/auth.js';

const enoent: ClaudeRunner = () => {
  const e = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
  e.code = 'ENOENT';
  return { status: null, stdout: '', error: e };
};

const tmp = join(tmpdir(), `blox-auth-${process.pid}.json`);
afterEach(() => { try { rmSync(tmp); } catch { /* ignore */ } });

describe('auth store', () => {
  it('returns {} for a missing file', () => {
    expect(loadAuthStore(join(tmpdir(), 'nope-xyz.json'))).toEqual({});
  });
  it('returns {} for garbage', () => {
    writeFileSync(tmp, 'not json');
    expect(loadAuthStore(tmp)).toEqual({});
  });
  it('keeps only known fields', () => {
    writeFileSync(tmp, JSON.stringify({ mode: 'apiKey', apiKey: 'sk-1', junk: 9, bad: '' }));
    expect(loadAuthStore(tmp)).toEqual({ mode: 'apiKey', apiKey: 'sk-1' });
  });
  it('save writes mode 0600 and round-trips', () => {
    saveAuthStore({ mode: 'subscription', apiKey: 'sk-2' }, tmp);
    expect(loadAuthStore(tmp)).toEqual({ mode: 'subscription', apiKey: 'sk-2' });
    expect(statSync(tmp).mode & 0o777).toBe(0o600);
  });
  it('setApiKey / clearApiKey / setMode mutate in place', () => {
    setApiKey('sk-3', tmp);
    expect(loadAuthStore(tmp).apiKey).toBe('sk-3');
    setMode('apiKey', tmp);
    expect(loadAuthStore(tmp)).toEqual({ apiKey: 'sk-3', mode: 'apiKey' });
    clearApiKey(tmp);
    expect(loadAuthStore(tmp)).toEqual({ mode: 'apiKey' });
  });
});

describe('authConfigDir', () => {
  it('honors XDG_CONFIG_HOME', () => {
    expect(authConfigDir({ XDG_CONFIG_HOME: '/x/cfg' } as never)).toBe('/x/cfg/blox');
  });
  it('falls back to ~/.config when XDG unset/blank', () => {
    expect(authConfigDir({ XDG_CONFIG_HOME: '  ' } as never)).toMatch(/[/\\]\.config[/\\]blox$/);
    expect(authStorePath({} as never)).toMatch(/blox[/\\]auth\.json$/);
  });
});

describe('effectiveAuthMode', () => {
  it('override apiKey with a stored key wins', () => {
    expect(effectiveAuthMode({ apiKey: 'k' }, 'apiKey')).toBe('apiKey');
  });
  it('override apiKey with no key falls back to subscription', () => {
    expect(effectiveAuthMode({}, 'apiKey')).toBe('subscription');
  });
  it('override subscription beats a stored apiKey mode', () => {
    expect(effectiveAuthMode({ mode: 'apiKey', apiKey: 'k' }, 'subscription')).toBe('subscription');
  });
  it('stored apiKey+key, no override → apiKey', () => {
    expect(effectiveAuthMode({ mode: 'apiKey', apiKey: 'k' })).toBe('apiKey');
  });
  it('nothing set → subscription', () => {
    expect(effectiveAuthMode({})).toBe('subscription');
  });
});

describe('buildAuthEnv', () => {
  it('apiKey mode sets the key and strips token vars', () => {
    const env = buildAuthEnv({
      store: { mode: 'apiKey', apiKey: 'sk-x' },
      baseEnv: { PATH: '/b', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o' } as never,
    });
    expect(env?.ANTHROPIC_API_KEY).toBe('sk-x');
    expect(env?.PATH).toBe('/b');
    expect(env && 'ANTHROPIC_AUTH_TOKEN' in env).toBe(false);
    expect(env && 'CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false);
  });
  it('subscription strips a stray ANTHROPIC_API_KEY', () => {
    const env = buildAuthEnv({
      store: { mode: 'subscription' },
      baseEnv: { PATH: '/b', ANTHROPIC_API_KEY: 'leak' } as never,
    });
    expect(env && 'ANTHROPIC_API_KEY' in env).toBe(false);
    expect(env?.PATH).toBe('/b');
  });
  it('subscription with a clean env returns undefined (pass-through)', () => {
    expect(buildAuthEnv({ store: {}, baseEnv: { PATH: '/b' } as never })).toBeUndefined();
  });
});

describe('readSubscriptionStatus', () => {
  it('parses claude auth status JSON', () => {
    const runner: ClaudeRunner = () => ({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true, email: 'a@b.com', subscriptionType: 'pro', authMethod: 'claude.ai' }),
    });
    expect(readSubscriptionStatus(runner)).toEqual({
      loggedIn: true, email: 'a@b.com', plan: 'pro', authMethod: 'claude.ai',
    });
  });
  it('reports an error when claude is missing', () => {
    const r = readSubscriptionStatus(enoent);
    expect('error' in r && /not found/i.test(r.error)).toBe(true);
  });
  it('treats unparseable output as not logged in', () => {
    expect(readSubscriptionStatus(() => ({ status: 0, stdout: 'huh' }))).toEqual({ loggedIn: false });
  });
});

describe('runClaudeAuth', () => {
  it('ok when claude exits 0', () => {
    expect(runClaudeAuth('login', () => ({ status: 0, stdout: '' }))).toEqual({ ok: true, error: undefined });
  });
  it('reports the missing-claude error', () => {
    const r = runClaudeAuth('login', enoent);
    expect(r.ok).toBe(false);
    expect(/not found/i.test(r.error ?? '')).toBe(true);
  });
});

describe('formatAuthStatus', () => {
  it('shows linked subscription, stored key, active mode', () => {
    const s = formatAuthStatus({ loggedIn: true, plan: 'pro', email: 'a@b.com' }, { mode: 'apiKey', apiKey: 'k' });
    expect(s).toMatch(/active mode: apiKey/);
    expect(s).toMatch(/subscription: linked/);
    expect(s).toMatch(/api key: stored/);
  });
  it('prompts to link when not logged in and no key', () => {
    const s = formatAuthStatus({ loggedIn: false }, {});
    expect(s).toMatch(/blox auth login/);
    expect(s).toMatch(/blox auth key set/);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCredStore, credStorePath, parseSubscriptionLinked } from './auth.js';

const file = join(tmpdir(), `blox-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
afterEach(() => rmSync(file, { force: true }));

describe('createCredStore', () => {
  it('saves an API key and reports it, defaulting mode to apiKey', () => {
    const s = createCredStore(file);
    expect(s.hasApiKey()).toBe(false);
    s.saveApiKey('sk-abc');
    expect(s.hasApiKey()).toBe(true);
    expect(s.load()).toEqual({ mode: 'apiKey', apiKey: 'sk-abc' });
  });

  it('useSubscription sets mode without dropping a stored key', () => {
    const s = createCredStore(file);
    s.saveApiKey('sk-abc');
    s.useSubscription();
    expect(s.load()).toEqual({ mode: 'subscription', apiKey: 'sk-abc' });
  });

  it('missing file loads as empty', () => {
    expect(createCredStore(file).load()).toEqual({});
  });
});

describe('credStorePath', () => {
  it('honors XDG_CONFIG_HOME', () => {
    expect(credStorePath({ XDG_CONFIG_HOME: '/tmp/cfg' })).toBe('/tmp/cfg/blox/auth.json');
  });
});

describe('parseSubscriptionLinked', () => {
  it('detects linked with detail', () => {
    expect(parseSubscriptionLinked('active mode: subscription\nsubscription: linked (Pro, a@b.com)\napi key: not set'))
      .toEqual({ linked: true, detail: 'Pro, a@b.com' });
  });
  it('detects not linked', () => {
    expect(parseSubscriptionLinked('subscription: not linked — run `blox auth login`'))
      .toEqual({ linked: false });
  });
});

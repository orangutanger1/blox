import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayServer } from '../src/relay/server.js';
import { addMember } from '../src/relay/members.js';
import { appendRelayEntry } from '../src/relay/ledger.js';
import { DEFAULT_PRICING_CONFIG } from '../src/config.js';
import { buildAuthEnv, checkRelay, clearRelay, effectiveAuthMode, loadAuthStore, setRelay, authInfo } from '../src/auth.js';

let relay: RelayServer | null = null;
afterEach(async () => { if (relay) await relay.stop(); relay = null; });

async function start(policy?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'blox-rc-'));
  const membersPath = join(dir, 'm.json');
  const ledgerPath = join(dir, 'l.jsonl');
  relay = new RelayServer({
    realKey: 'sk-real', policy: policy as never,
    relay: { port: 0, host: '127.0.0.1', apiKeyEnv: 'X', upstream: 'http://127.0.0.1:1', membersPath, ledgerPath, pricing: DEFAULT_PRICING_CONFIG },
  });
  const port = await relay.start();
  return { url: `http://127.0.0.1:${port}`, membersPath, ledgerPath };
}

describe('auth relay store', () => {
  it('stores the link, switches mode, and clears back to subscription', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'blox-auth-')), 'auth.json');
    setRelay({ url: 'http://relay:8787/', token: 'blx_1' }, p);
    const s = loadAuthStore(p);
    expect(s).toMatchObject({ mode: 'relay', relay: { url: 'http://relay:8787', token: 'blx_1' } });
    expect(effectiveAuthMode(s)).toBe('relay');
    expect(authInfo({ store: s }).label).toBe('Team relay');
    clearRelay(p);
    expect(effectiveAuthMode(loadAuthStore(p))).toBe('subscription');
  });
  it('relay mode points the engine at the relay with the member token only', () => {
    const env = buildAuthEnv({
      store: { mode: 'relay', relay: { url: 'http://relay:8787', token: 'blx_1' } },
      baseEnv: { ANTHROPIC_AUTH_TOKEN: 'oauth', CLAUDE_CODE_OAUTH_TOKEN: 'o2', PATH: '/bin' },
    })!;
    expect(env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://relay:8787', ANTHROPIC_API_KEY: 'blx_1', PATH: '/bin' });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe('checkRelay preflight', () => {
  it('ok for a valid member + allowed model', async () => {
    const r = await start({ models: ['claude-opus-5-5'] });
    const token = addMember(r.membersPath, 'a@x.com');
    expect(await checkRelay({ url: r.url, token }, 'claude-opus-5-5')).toEqual({ ok: true, member: 'a@x.com' });
  });
  it('explains a revoked token, a disallowed model, and a spent budget', async () => {
    const r = await start({ models: ['claude-opus-5-5'], rollingBudget: { windowDays: 7, maxUsd: 1 } });
    const token = addMember(r.membersPath, 'a@x.com');
    expect(await checkRelay({ url: r.url, token: 'blx_bad' }, null)).toMatchObject({ ok: false, reason: 'token' });
    const m = await checkRelay({ url: r.url, token }, 'gpt-x');
    expect(m).toMatchObject({ ok: false, reason: 'policy' });
    expect(m.ok === false && m.message).toMatch(/not in the team allowlist/);
    appendRelayEntry(r.ledgerPath, { ts: new Date().toISOString(), user: 'a@x.com', model: 'claude-opus-5-5', turns: 1, costUsd: 2, status: 'success', commit: null, prompt: '' } as never);
    const b = await checkRelay({ url: r.url, token }, 'claude-opus-5-5');
    expect(b.ok === false && b.message).toMatch(/rolling budget reached/);
  });
  it('reports an unreachable relay', async () => {
    expect(await checkRelay({ url: 'http://127.0.0.1:1', token: 't' }, null)).toMatchObject({ ok: false, reason: 'unreachable' });
  });
});

describe('relayPreflight', () => {
  const store = { mode: 'relay' as const, relay: { url: 'http://127.0.0.1:1', token: 't' } };
  it('is a no-op outside relay mode', async () => {
    const { relayPreflight } = await import('../src/auth.js');
    expect(await relayPreflight({ model: 'm', runner: 'openai', store: {} })).toBeNull();
  });
  it('refuses runs that would bypass the relay', async () => {
    const { relayPreflight } = await import('../src/auth.js');
    expect(await relayPreflight({ model: 'claude-opus-5-5', runner: 'openai', store })).toMatch(/bypass/);
    expect(await relayPreflight({ model: 'openrouter,x', runner: 'claude', store })).toMatch(/bypass/);
  });
});

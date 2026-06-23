import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ccrReachable, ensureCcr, ccrStatus, formatCcrStatus, ccrRunEnv, ensureCcrInstalled } from '../src/ccrServe.js';

const noSleep = () => Promise.resolve();

describe('ccrReachable', () => {
  it('true when the fetch resolves (any HTTP response, even 404)', async () => {
    expect(await ccrReachable('http://x', async () => ({ status: 404 }))).toBe(true);
  });
  it('false when the fetch throws (connection refused)', async () => {
    expect(await ccrReachable('http://x', async () => { throw new Error('ECONNREFUSED'); })).toBe(false);
  });
});

describe('ensureCcr', () => {
  it('reused: returns true without spawning when already reachable', async () => {
    const spawn = vi.fn();
    const ok = await ensureCcr(() => {}, { fetchFn: async () => ({}), spawn });
    expect(ok).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawned: starts ccr, then succeeds once the port answers', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw new Error('down'); // initial probe + first poll fail
      return {}; // second poll succeeds
    });
    const spawn = vi.fn();
    const logs: string[] = [];
    const ok = await ensureCcr((m) => logs.push(m), { fetchFn, spawn, sleep: noSleep, delayMs: 0 });
    expect(ok).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    expect(logs.some((l) => l.includes('starting'))).toBe(true);
    expect(logs.some((l) => l.includes('ready'))).toBe(true);
  });

  it('gives up after the poll window and returns false', async () => {
    const spawn = vi.fn();
    const logs: string[] = [];
    const ok = await ensureCcr((m) => logs.push(m), {
      fetchFn: async () => { throw new Error('down'); },
      spawn,
      attempts: 3,
      delayMs: 0,
      sleep: noSleep,
    });
    expect(ok).toBe(false);
    expect(spawn).toHaveBeenCalledOnce();
    expect(logs.some((l) => l.includes('did not come up'))).toBe(true);
  });
});

describe('ccrStatus', () => {
  const cfgPath = join(tmpdir(), `blox-ccr-${process.pid}.json`);
  afterEach(() => {
    delete process.env.CCR_CONFIG;
    rmSync(cfgPath, { force: true });
  });

  it('reads provider/models from CCR_CONFIG and reflects reachability', async () => {
    writeFileSync(cfgPath, JSON.stringify({
      Providers: [{ name: 'openrouter', models: ['a', 'b'] }],
      Router: { default: 'openrouter,b' },
    }));
    process.env.CCR_CONFIG = cfgPath;
    const s = await ccrStatus(async () => ({}));
    expect(s).toMatchObject({ reachable: true, provider: 'openrouter', modelCount: 2, current: 'b' });
  });

  it('marks down when the probe throws', async () => {
    process.env.CCR_CONFIG = cfgPath; // no file → empty config
    const s = await ccrStatus(async () => { throw new Error('refused'); });
    expect(s).toMatchObject({ reachable: false, provider: null, modelCount: 0 });
  });
});

describe('formatCcrStatus', () => {
  it('reports native-only when no provider', () => {
    const out = formatCcrStatus({ reachable: false, baseUrl: 'http://x', provider: null, modelCount: 0, current: null });
    expect(out).toContain('NO CCR CONFIG');
    expect(out).toContain('native Claude only');
  });
  it('reports reachable + configured-but-down', () => {
    const base = { baseUrl: 'http://x', provider: 'openrouter', modelCount: 3, current: 'gpt-4o' };
    expect(formatCcrStatus({ ...base, reachable: true })).toContain('CCR REACHABLE');
    const down = formatCcrStatus({ ...base, reachable: false });
    expect(down).toContain('CCR CONFIGURED, DOWN');
    expect(down).toContain('auto-starts');
  });
});

describe('ccrRunEnv', () => {
  it('useCcr=false returns undefined (inherit env unchanged)', () => {
    expect(ccrRunEnv(false)).toBeUndefined();
  });
  it('useCcr=true points the SDK at CCR and drops a competing bearer token', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'leftover';
    const env = ccrRunEnv(true)!;
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\//);
    expect(env.ANTHROPIC_API_KEY).toBeTruthy();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });
});

describe('ensureCcrInstalled', () => {
  it('present on PATH → true, no install attempted', () => {
    const install = vi.fn(() => true);
    expect(ensureCcrInstalled(() => {}, { probe: () => true, install })).toBe(true);
    expect(install).not.toHaveBeenCalled();
  });
  it('absent → installs once and returns true on success', () => {
    const logs: string[] = [];
    expect(ensureCcrInstalled((m) => logs.push(m), { probe: () => false, install: () => true })).toBe(true);
    expect(logs.join(' ')).toMatch(/installing/i);
  });
  it('absent and install fails → false with a manual hint', () => {
    const logs: string[] = [];
    expect(ensureCcrInstalled((m) => logs.push(m), { probe: () => false, install: () => false })).toBe(false);
    expect(logs.join(' ')).toMatch(/npm i -g @musistudio\/claude-code-router/);
  });
});

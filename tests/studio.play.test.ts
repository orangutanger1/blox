import { describe, expect, it } from 'vitest';
import { startPlay } from '../src/studio/play.js';
import type { StudioSession } from '../src/studio/session.js';

function fakeSession(mode: () => string) {
  const calls: string[] = [];
  const s = {
    calls,
    state: async () => ({ mode: mode() }),
    call: async (name: string) => {
      calls.push(name);
      return { content: [{ type: 'text', text: 'Playtest started' }] };
    },
  };
  return s as unknown as StudioSession & { calls: string[] };
}
const instant = async () => {};

describe('startPlay on a locked PC', () => {
  it('fails fast before starting when the session is locked', async () => {
    const s = fakeSession(() => 'Edit');
    await expect(startPlay(s, { sleep: instant, locked: async () => true, restore: instant })).rejects.toMatchObject({ code: 'play_blocked' });
    expect(s.calls).toEqual([]);
  });
  it('names the lock when Play never starts and the PC locked meanwhile', async () => {
    const s = fakeSession(() => 'Edit');
    let n = 0;
    await expect(startPlay(s, { sleep: instant, enterTimeoutMs: 0, locked: async () => n++ > 0, restore: instant })).rejects.toMatchObject({ code: 'play_blocked' });
  });
  it('says Play did not start, with the unlock hint, when not locked', async () => {
    const s = fakeSession(() => 'Edit');
    await expect(startPlay(s, { sleep: instant, enterTimeoutMs: 0, locked: async () => false, restore: instant })).rejects.toThrow(/did not enter Play.*unlock/s);
  });
  it('does not probe when a playtest is already running', async () => {
    const s = fakeSession(() => 'Server');
    let probed = false;
    await startPlay(s, { sleep: instant, readyTimeoutMs: 0, locked: async () => (probed = true), restore: instant });
    expect(probed).toBe(false);
  });
  it('restores the Studio window before starting', async () => {
    let mode = 'Edit';
    const s = fakeSession(() => mode);
    const order: string[] = [];
    const origCall = s.call.bind(s);
    (s as any).call = async (n: string, ...r: unknown[]) => { order.push(n); mode = 'Server'; return origCall(n, ...r); };
    await startPlay(s, { sleep: instant, readyTimeoutMs: 0, locked: async () => false, restore: async () => { order.push('restore'); } });
    expect(order[0]).toBe('restore');
  });

});

describe('startPlay when Studio is wedged', () => {
  const wedged = (onCall?: () => void) => {
    let mode = 'Edit';
    const s = {
      setMode: (m: string) => (mode = m),
      state: async () => ({ mode }),
      call: async () => {
        onCall?.();
        return { isError: true, content: [{ type: 'text', text: "Start play hasn't finished yet" }] };
      },
    };
    return s as unknown as StudioSession & { setMode(m: string): void };
  };
  it('presses Play once in Studio, then carries on when Play starts', async () => {
    const s = wedged();
    let presses = 0;
    const info = await startPlay(s, { sleep: instant, readyTimeoutMs: 0, locked: async () => false, restore: instant, pressPlay: async () => { presses++; s.setMode('Server'); return true; } });
    expect(presses).toBe(1);
    expect(info.alreadyRunning).toBe(false);
  });
  it('names the stuck request when pressing Play does not help', async () => {
    const s = wedged();
    let presses = 0;
    await expect(
      startPlay(s, { sleep: instant, enterTimeoutMs: 0, locked: async () => false, restore: instant, pressPlay: async () => (presses++, true) }),
    ).rejects.toMatchObject({ code: 'play_blocked', message: expect.stringMatching(/stuck.*F5/s) });
    expect(presses).toBe(1);
  });
});

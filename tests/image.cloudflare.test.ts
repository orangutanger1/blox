import { describe, expect, it } from 'vitest';
import { runFluxBatch } from '../src/image/cloudflare.js';

const SECRET = 'tok-SECRET-123';
function fakeFetch(o: { failRun?: boolean } = {}) {
  const calls: { url: string; body?: any; auth?: string }[] = [];
  const f = async (url: string, init?: any) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.Authorization });
    if (url.endsWith('/accounts')) return new Response(JSON.stringify({ success: true, result: [{ id: 'acc1' }] }));
    if (o.failRun) return new Response(JSON.stringify({ success: false, errors: [{ message: `bad token ${SECRET}` }] }), { status: 401 });
    return new Response(JSON.stringify({ success: true, result: { image: Buffer.from('JPEG' + calls.length).toString('base64') } }));
  };
  return { f, calls };
}

describe('cloudflare flux backend', () => {
  it('finds the account, runs flux-1-schnell per item (the API takes no seed)', async () => {
    const { f, calls } = fakeFetch();
    const r = await runFluxBatch([{ file: 'a.png', prompt: 'coin', seed: 3 }, { file: 'b.png', prompt: 'gem', seed: 4 }], { fetch: f as any, token: async () => SECRET });
    expect(calls[0].url).toMatch(/\/client\/v4\/accounts$/);
    expect(calls[1].url).toMatch(/accounts\/acc1\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell$/);
    expect(calls[1].body).toMatchObject({ prompt: 'coin' });
    expect(calls[1].body).not.toHaveProperty('seed');
    expect(r[0].seed).toBeUndefined();
    expect(calls[1].auth).toBe(`Bearer ${SECRET}`);
    expect(r.map((x) => x.data!.toString())).toEqual(['JPEG2', 'JPEG3']);
  });
  it('never puts the token in an error', async () => {
    const { f } = fakeFetch({ failRun: true });
    const r = await runFluxBatch([{ file: 'a.png', prompt: 'coin', seed: 3 }], { fetch: f as any, token: async () => SECRET });
    expect(r[0].error).toBeDefined();
    expect(r[0].error).not.toContain(SECRET);
  });
});

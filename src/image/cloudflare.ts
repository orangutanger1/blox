import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { KernelItem } from './kaggleScripts.js';
import type { BatchResult } from './kaggle.js';

// Fallback backend: Cloudflare Workers AI FLUX.1-schnell (Apache-2.0 output),
// with the user's wrangler OAuth login. The token is never logged or returned.

const API = 'https://api.cloudflare.com/client/v4';
export const FLUX_MODEL = '@cf/black-forest-labs/flux-1-schnell';
type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

const CONFIG = join(homedir(), '.wrangler/config/default.toml');

function readToml(): { token?: string; expires?: number } {
  if (!existsSync(CONFIG)) return {};
  const t = readFileSync(CONFIG, 'utf8');
  const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(t)?.[1];
  const exp = /^expiration_time\s*=\s*"([^"]+)"/m.exec(t)?.[1];
  return { token, expires: exp ? Date.parse(exp) : undefined };
}

// The wrangler token lasts about an hour; any wrangler command refreshes it.
export async function wranglerToken(): Promise<string> {
  let c = readToml();
  if (!c.token || (c.expires !== undefined && c.expires < Date.now() + 60_000)) {
    spawnSync('npx', ['-y', 'wrangler', 'whoami'], { stdio: 'ignore', timeout: 120_000, shell: process.platform === 'win32' });
    c = readToml();
  }
  if (!c.token) throw new Error('no Cloudflare login: run `npx wrangler login` once');
  return c.token;
}

const scrub = (s: string, secret: string) => (secret ? s.split(secret).join('<token>') : s);

export async function runFluxBatch(items: KernelItem[], o: { fetch?: Fetch; token?: () => Promise<string>; steps?: number } = {}): Promise<BatchResult[]> {
  const f: Fetch = o.fetch ?? ((u, i) => fetch(u, i as RequestInit));
  const token = await (o.token ?? wranglerToken)();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const acc = (await (await f(`${API}/accounts`, { headers })).json()) as { result?: { id: string }[] };
  const account = acc.result?.[0]?.id;
  if (!account) throw new Error('Cloudflare: no account visible to this login');
  const out: BatchResult[] = [];
  for (const it of items) {
    try {
      const r = await f(`${API}/accounts/${account}/ai/run/${FLUX_MODEL}`, { method: 'POST', headers, body: JSON.stringify({ prompt: it.prompt, seed: it.seed, steps: o.steps ?? 8 }) });
      const j = (await r.json()) as { success?: boolean; result?: { image?: string }; errors?: { message: string }[] };
      if (!r.ok || !j.result?.image) throw new Error(`HTTP ${r.status}: ${(j.errors ?? []).map((e) => e.message).join('; ')}`);
      out.push({ file: it.file, seed: it.seed, data: Buffer.from(j.result.image, 'base64') });
    } catch (e) {
      out.push({ file: it.file, seed: it.seed, error: scrub(`flux: ${(e as Error).message}`, token) });
    }
  }
  return out;
}

// Minimal Roblox Open Cloud client. The API key comes from
// ROBLOX_OPEN_CLOUD_KEY (never stored in the repo). fetch is injectable so
// every caller is testable without a real key; callers gate anything that
// publishes, spends or changes live state behind explicit human confirmation.

import { ENDPOINTS } from './endpoints.js';

export const OPEN_CLOUD_BASE = 'https://apis.roblox.com';
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class OpenCloudError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface Operation {
  path: string;
  done?: boolean;
  response?: Record<string, unknown>;
  error?: { message?: string };
}

export function openCloudKey(): string | undefined {
  return process.env.ROBLOX_OPEN_CLOUD_KEY || undefined;
}

export const NO_KEY = 'no Open Cloud API key: a human must create one (Creator Hub → Open Cloud → API Keys, scoped to this experience) and export ROBLOX_OPEN_CLOUD_KEY';

export class OpenCloud {
  private readonly key: string;
  private readonly fetch: FetchLike;
  readonly base: string;
  constructor(o: { apiKey?: string; fetch?: FetchLike; base?: string } = {}) {
    const key = o.apiKey ?? openCloudKey();
    if (!key) throw new OpenCloudError(NO_KEY);
    this.key = key;
    this.fetch = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.base = o.base ?? OPEN_CLOUD_BASE;
  }

  async request<T = Record<string, unknown>>(method: string, path: string, init: { json?: unknown; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = { 'x-api-key': this.key, ...(init.headers ?? {}) };
    let body = init.body;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    const res = await this.fetch(`${this.base}${path}`, { method, headers, body });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && ((data as { message?: string }).message ?? (data as { errors?: { message?: string }[] }).errors?.[0]?.message)) || text.slice(0, 300);
      throw new OpenCloudError(`Open Cloud ${method} ${path} → ${res.status}: ${msg}`, res.status);
    }
    return data as T;
  }

  // Assets API: multipart request JSON + file.
  uploadAsset(a: { assetType: string; displayName: string; description: string; creator: { userId?: number; groupId?: number }; file: Buffer; fileName: string; contentType: string }): Promise<Operation> {
    const form = new FormData();
    const creator = a.creator.groupId ? { groupId: String(a.creator.groupId) } : { userId: String(a.creator.userId) };
    form.append('request', JSON.stringify({ assetType: a.assetType, displayName: a.displayName, description: a.description, creationContext: { creator } }));
    form.append('fileContent', new Blob([new Uint8Array(a.file)], { type: a.contentType }), a.fileName);
    return this.request<Operation>('POST', '/assets/v1/assets', { body: form });
  }

  getOperation(path: string): Promise<Operation> {
    return this.request<Operation>('GET', `/assets/v1/${path.replace(/^\/+/, '')}`);
  }

  async waitOperation(path: string, o: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<Record<string, unknown>> {
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < (o.attempts ?? 30); i++) {
      const op = await this.getOperation(path);
      if (op.error) throw new OpenCloudError(`operation ${path} failed: ${op.error.message ?? 'unknown error'}`);
      if (op.done) return op.response ?? {};
      await sleep(o.intervalMs ?? 2000);
    }
    throw new OpenCloudError(`operation ${path} still running — check it later`);
  }

  // Place Publishing: the .rbxl becomes the live version. Human-gated by callers.
  publishPlace(universeId: number, placeId: number, file: Buffer): Promise<{ versionNumber?: number }> {
    return this.request('POST', ENDPOINTS.placePublish(universeId, placeId), { body: new Uint8Array(file), headers: { 'content-type': 'application/octet-stream' } });
  }

  // Analytics Query (scope universe.analytics:read). Path/body unverified — see endpoints.ts.
  queryMetrics(universeId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', ENDPOINTS.analyticsMetrics(universeId), { json: body });
  }

  // Live Configs. Path/body unverified — see endpoints.ts.
  putConfigs(universeId: number, entries: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('PATCH', ENDPOINTS.configs(universeId), { json: { entries } });
  }

  // Thumbnail Personalization upload. Path/body unverified — see endpoints.ts.
  uploadThumbnail(universeId: number, file: Buffer, fileName: string, contentType: string): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append('fileContent', new Blob([new Uint8Array(file)], { type: contentType }), fileName);
    return this.request('POST', ENDPOINTS.thumbnails(universeId), { body: form });
  }
}

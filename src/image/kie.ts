import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

// kie.ai: one API key for 200+ hosted image/video/audio models. Every model is a
// task: createTask → poll recordInfo until success/fail → download resultUrls.
// Bodies are {code, msg, data}; HTTP 200 does not mean success, `code` does.

const API = 'https://api.kie.ai';
const UPLOAD = 'https://kieai.redpandaai.co';
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

export class KieError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

export interface KieOptions {
  fetch?: Fetch;
  key?: string;
  pollMs?: number; // default 3000 (recordInfo allows 10/s per task)
  timeoutSec?: number; // default 300 (images); video wants more
  onStatus?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function kieKey(o: KieOptions = {}): string {
  const k = o.key ?? process.env.KIE_API_KEY;
  if (!k) throw new KieError('no kie.ai key: set KIE_API_KEY (create one at https://kie.ai/api-key)');
  return k;
}

const scrub = (s: string, key: string) => s.split(key).join('<key>');

async function call<T>(path: string, o: KieOptions, body?: unknown, base = API): Promise<T> {
  const key = kieKey(o);
  const f: Fetch = o.fetch ?? ((u, i) => fetch(u, i as RequestInit));
  const r = await f(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let j: { code?: number; msg?: string; data?: T };
  try {
    j = JSON.parse(text);
  } catch {
    throw new KieError(`kie ${path}: HTTP ${r.status} ${scrub(text.slice(0, 200), key)}`, r.status);
  }
  if (j.code !== 200) {
    const hint = j.code === 402 ? ' (out of credits: top up at https://kie.ai)' : j.code === 429 ? ' (rate limited)' : '';
    throw new KieError(`kie ${path}: ${j.code} ${scrub(String(j.msg ?? ''), key)}${hint}`, j.code);
  }
  return j.data as T;
}

export const kieCredit = (o: KieOptions = {}) => call<number>('/api/v1/chat/credit', o);

export interface KieModel {
  model: string;
  provider: string;
  taskType: string[];
  pricingDesc: string | null;
}
export async function kieModels(o: KieOptions = {}): Promise<KieModel[]> {
  return (await call<{ models: KieModel[] }>('/api/v1/models', o)).models;
}

// A local file → a KIE temp URL (24 h) that a model input can reference.
export async function kieUpload(file: string, o: KieOptions = {}): Promise<string> {
  const ext = extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  const base64Data = `data:${mime};base64,${readFileSync(file).toString('base64')}`;
  const d = await call<{ downloadUrl: string }>('/api/file-base64-upload', o, { base64Data, uploadPath: 'blox/refs', fileName: basename(file) }, UPLOAD);
  return d.downloadUrl;
}

export interface KieResult {
  taskId: string;
  urls: string[];
  credits?: number;
  response: Record<string, unknown>;
}

export async function kieRun(model: string, input: Record<string, unknown>, o: KieOptions = {}): Promise<KieResult> {
  const { taskId } = await call<{ taskId: string }>('/api/v1/jobs/createTask', o, { model, input });
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (o.timeoutSec ?? 300) * 1000;
  let last = '';
  for (;;) {
    await sleep(o.pollMs ?? 3000);
    let d: { state: string; failMsg?: string | null; failCode?: string | null; creditsConsumed?: number; response?: Record<string, unknown> | null; resultJson?: string | null };
    try {
      d = await call('/api/v1/jobs/recordInfo?taskId=' + encodeURIComponent(taskId), o);
    } catch (e) {
      if (e instanceof KieError && (e.code === 429 || (e.code ?? 0) >= 500)) continue; // transient: poll again
      throw e;
    }
    if (d.state !== last) o.onStatus?.((last = d.state));
    if (d.state === 'success') {
      const response = d.response ?? (d.resultJson ? JSON.parse(d.resultJson) : {});
      const urls = (response.resultUrls as string[] | undefined) ?? [];
      return { taskId, urls, credits: d.creditsConsumed, response };
    }
    if (d.state === 'fail') throw new KieError(`${model} failed: ${d.failMsg ?? d.failCode ?? 'no reason given'} (task ${taskId})`);
    if (Date.now() > deadline) throw new KieError(`${model}: no result after ${o.timeoutSec ?? 300} s (task ${taskId}, state ${d.state})`);
  }
}

export async function kieDownload(url: string, o: KieOptions = {}): Promise<Buffer> {
  const f: Fetch = o.fetch ?? ((u, i) => fetch(u, i as RequestInit));
  const r = await f(url);
  if (!r.ok) throw new KieError(`download ${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Per-family input: field names differ by model (schema is the source of truth;
// these cover the families blox defaults to). `extra` is merged last, so any
// model works given the right fields.
export function imageInput(model: string, prompt: string, o: { refs?: string[]; aspect?: string; transparent?: boolean; extra?: Record<string, unknown> }): Record<string, unknown> {
  const aspect = o.aspect ?? '1:1';
  let input: Record<string, unknown>;
  if (model.startsWith('gpt-image-2')) {
    // background:transparent only works at 1K
    input = { prompt, aspect_ratio: aspect, resolution: '1K', ...(o.transparent ? { background: 'transparent' } : {}), ...(o.refs?.length ? { input_urls: o.refs } : {}) };
  } else if (model.startsWith('nano-banana')) {
    input = { prompt, aspect_ratio: aspect, resolution: '1K', output_format: 'png', ...(o.refs?.length ? { image_input: o.refs } : {}) };
  } else {
    input = { prompt, aspect_ratio: aspect, ...(o.refs?.length ? { image_urls: o.refs } : {}) };
  }
  return { ...input, ...(o.extra ?? {}) };
}

// The image-to-image sibling of a text-to-image model (KIE names them in pairs).
export const withRefsModel = (model: string) => model.replace(/text-to-image$/, 'image-to-image');

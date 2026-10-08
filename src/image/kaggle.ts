import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BATCH_SLUG, DOCKER_IMAGE, RUNTIME_DATASET, WEIGHTS_SLUG, batchScript, weightsScript, type KernelItem } from './kaggleScripts.js';

// Kaggle as a GPU batch backend: write a kernel folder, push it, poll its
// status, download its output. Everything goes through the kaggle CLI (2.2+,
// token in ~/.kaggle/access_token); the runner is injectable for tests.

export type KaggleCli = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

// Kaggle can't run this batch (quota, auth, CLI missing, timeout): callers may fall back.
export class KaggleUnavailable extends Error {}

export function kaggleBin(): string {
  if (process.env.BLOX_KAGGLE) return process.env.BLOX_KAGGLE;
  const local = join(homedir(), '.local/bin/kaggle'); // the miniforge kaggle (1.7) is too old
  return existsSync(local) ? local : 'kaggle';
}

export const realKaggle: KaggleCli = (args, timeoutMs = 600_000) =>
  new Promise((resolve) => {
    const p = spawn(kaggleBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: 127, stdout, stderr: String(e) });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

const UNAVAILABLE = /quota|429|401|403|unauthori[sz]ed|forbidden|ENOENT|not found: kaggle|spawn/i;

async function must(cli: KaggleCli, args: string[], what: string, timeoutMs?: number): Promise<string> {
  const r = await cli(args, timeoutMs);
  if (r.code !== 0) {
    const msg = `kaggle ${what} failed: ${(r.stderr || r.stdout).trim().slice(-600)}`;
    throw UNAVAILABLE.test(r.stderr + r.stdout) || r.code === 127 ? new KaggleUnavailable(msg) : new Error(msg);
  }
  return r.stdout;
}

export async function kaggleUser(cli: KaggleCli): Promise<string> {
  const out = await must(cli, ['config', 'view'], 'config view');
  const m = /username:\s*(\S+)/.exec(out);
  if (!m || m[1] === 'None') throw new KaggleUnavailable('kaggle: no signed-in user (put an API token in ~/.kaggle/access_token)');
  return m[1];
}

interface Kernel {
  meta: Record<string, unknown>;
  script: string;
}

function meta(user: string, slug: string, title: string, gpu: boolean, extra: Record<string, unknown> = {}) {
  return {
    id: `${user}/${slug}`,
    title,
    code_file: 'main.py',
    language: 'python',
    kernel_type: 'script',
    is_private: true,
    enable_gpu: gpu,
    enable_tpu: false,
    enable_internet: true,
    dataset_sources: [],
    kernel_sources: [],
    competition_sources: [],
    model_sources: [],
    ...extra,
  };
}

export function weightsKernel(user: string): Kernel {
  return { meta: meta(user, WEIGHTS_SLUG, 'blox qwen21 weights', false), script: weightsScript() };
}

export function batchKernel(user: string, items: KernelItem[], size: number): Kernel {
  return {
    meta: meta(user, BATCH_SLUG, 'blox image batch', true, {
      dataset_sources: [RUNTIME_DATASET],
      kernel_sources: [`${user}/${WEIGHTS_SLUG}`],
      machine_shape: 'NvidiaTeslaT4',
      docker_image: DOCKER_IMAGE,
    }),
    script: batchScript(items, size),
  };
}

function writeKernel(dir: string, k: Kernel): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'kernel-metadata.json'), JSON.stringify(k.meta, null, 2));
  writeFileSync(join(dir, 'main.py'), k.script);
}

export type KernelStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled' | 'unknown';

export async function kernelStatus(cli: KaggleCli, ref: string): Promise<KernelStatus> {
  const out = await must(cli, ['kernels', 'status', ref], 'kernels status');
  const s = (/status "(?:KernelWorkerStatus\.)?(\w+)"/.exec(out)?.[1] ?? '').toLowerCase();
  return s === 'cancel_acknowledged' || s === 'cancel_requested' ? 'cancelled' : (['queued', 'running', 'complete', 'error'].includes(s) ? s : 'unknown') as KernelStatus;
}

export interface WaitOptions {
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
  onStatus?: (s: KernelStatus) => void;
}

export async function waitKernel(cli: KaggleCli, ref: string, o: WaitOptions = {}): Promise<KernelStatus> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (o.timeoutMs ?? 90 * 60_000);
  for (;;) {
    const s = await kernelStatus(cli, ref);
    o.onStatus?.(s);
    if (s === 'complete' || s === 'error' || s === 'cancelled') return s;
    if (Date.now() > deadline) throw new KaggleUnavailable(`kaggle kernel ${ref} still ${s} after ${Math.round((o.timeoutMs ?? 5_400_000) / 60_000)} min`);
    await sleep(o.pollMs ?? 30_000);
  }
}

function logTail(dir: string, n = 25): string {
  const log = readdirSync(dir).find((f) => f.endsWith('.log'));
  if (!log) return '';
  const text = readFileSync(join(dir, log), 'utf8');
  // Kaggle logs are a JSON array of {stream_name, time, data}; plain text otherwise.
  let lines: string[];
  try {
    lines = (JSON.parse(text) as { data: string }[]).map((e) => e.data).join('').split('\n');
  } catch {
    lines = text.split('\n');
  }
  return lines.filter((l) => l.trim()).slice(-n).join('\n');
}

export interface BatchResult {
  file: string;
  seed?: number;
  data?: Buffer;
  channels?: number;
  error?: string;
}

export interface BatchOptions extends WaitOptions {
  size: number;
  workDir: string; // scratch for the kernel folder and its output
  cli?: KaggleCli;
}

export async function runKaggleBatch(items: KernelItem[], o: BatchOptions): Promise<BatchResult[]> {
  const cli = o.cli ?? realKaggle;
  const user = await kaggleUser(cli);
  const k = batchKernel(user, items, o.size);
  const src = join(o.workDir, 'kernel');
  writeKernel(src, k);
  await must(cli, ['kernels', 'push', '-p', src], 'kernels push', 180_000);
  const ref = `${user}/${BATCH_SLUG}`;
  const status = await waitKernel(cli, ref, o);
  const out = join(o.workDir, 'output');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await must(cli, ['kernels', 'output', ref, '-p', out, '-o'], 'kernels output', 600_000);
  const resFile = [join(out, 'out/results.json'), join(out, 'results.json')].find(existsSync);
  const res = resFile ? (JSON.parse(readFileSync(resFile, 'utf8')) as { status: string; error?: string; results: BatchResult[] }) : null;
  if (status !== 'complete' || !res || res.status === 'FAILED') {
    const why = res?.error ?? `kernel ${status}`;
    throw new Error(`kaggle batch failed: ${why}\n--- log tail ---\n${logTail(out)}`);
  }
  const imgDir = resFile!.replace(/results\.json$/, '');
  return items.map((it) => {
    const r = res.results.find((x) => x.file === it.file);
    if (!r) return { file: it.file, error: 'not generated (kernel stopped early?)' };
    if (r.error) return { file: it.file, seed: it.seed, error: r.error };
    const p = join(imgDir, it.file);
    return existsSync(p) ? { file: it.file, seed: r.seed, channels: r.channels, data: readFileSync(p) } : { file: it.file, error: 'image missing from the kernel output' };
  });
}

// One-time: push the weights kernel and wait for it (CPU; ~15–30 min).
export async function setupWeights(o: { workDir: string; cli?: KaggleCli } & WaitOptions): Promise<{ user: string; status: KernelStatus; already: boolean }> {
  const cli = o.cli ?? realKaggle;
  const user = await kaggleUser(cli);
  const ref = `${user}/${WEIGHTS_SLUG}`;
  const r = await cli(['kernels', 'status', ref]);
  if (r.code === 0) {
    const s = await kernelStatus(cli, ref);
    if (s === 'complete') return { user, status: s, already: true };
    if (s === 'running' || s === 'queued') return { user, status: await waitKernel(cli, ref, { timeoutMs: 90 * 60_000, ...o }), already: true };
  }
  const dir = join(o.workDir, 'weights-kernel');
  writeKernel(dir, weightsKernel(user));
  await must(cli, ['kernels', 'push', '-p', dir], 'kernels push', 180_000);
  return { user, status: await waitKernel(cli, ref, { timeoutMs: 90 * 60_000, ...o }), already: false };
}

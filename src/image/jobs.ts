import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bloxDir } from '../state/store.js';
import { cacheMisses, generateImages, validateImages, defaultBackends, type BackendName, type GenerateInput, type GenerateResult, type ImageBackend } from './generate.js';

// `image generate` over MCP: a Kaggle batch takes 10+ minutes, so the call
// starts a job in the server process and returns its id and ETA at once;
// `image status {job}` reads .blox/image-jobs/<id>.json (progress, then the files).

export interface ImageJob {
  id: string;
  status: 'running' | 'done' | 'failed' | 'lost';
  startedAt: string;
  endedAt?: string;
  etaSec: number;
  backend: BackendName;
  items: string[];
  progress: string;
  pid: number;
  result?: GenerateResult;
  error?: string;
}

// ~10 min Kaggle setup + ~40 s per 512px image; FLUX ~5 s each; cache hits are free.
export function imageEta(backend: BackendName, misses: number): number {
  if (!misses) return 0;
  return backend === 'kaggle-qwen' ? 600 + 40 * misses : 5 * misses;
}

const jobDir = (P: string) => join(bloxDir(P), 'image-jobs');
function save(P: string, j: ImageJob): void {
  mkdirSync(jobDir(P), { recursive: true });
  const f = join(jobDir(P), `${j.id}.json`);
  writeFileSync(`${f}.tmp`, JSON.stringify(j, null, 2));
  renameSync(`${f}.tmp`, f);
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function readImageJob(P: string, id: string): ImageJob | null {
  const f = join(jobDir(P), `${id}.json`);
  if (!existsSync(f)) return null;
  const j = JSON.parse(readFileSync(f, 'utf8')) as ImageJob;
  if (j.status === 'running' && !alive(j.pid)) j.status = 'lost'; // the server that ran it exited
  return j;
}

export function listImageJobs(P: string): ImageJob[] {
  if (!existsSync(jobDir(P))) return [];
  return readdirSync(jobDir(P))
    .filter((f) => f.endsWith('.json'))
    .map((f) => readImageJob(P, f.slice(0, -5))!)
    .filter(Boolean)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function startImageJob(P: string, input: GenerateInput, o: { backends?: ImageBackend[]; cacheDir: string | null; pid?: number }): { id: string; etaSec: number; misses: number; done: Promise<void> } {
  validateImages(P, input);
  const backends = o.backends ?? defaultBackends();
  const misses = cacheMisses(input, backends, o.cacheDir).length;
  const backend = backends[0]?.name ?? 'kaggle-qwen';
  const now = new Date();
  const id = `img-${now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${Math.random().toString(36).slice(2, 6)}`;
  const job: ImageJob = { id, status: 'running', startedAt: now.toISOString(), etaSec: imageEta(backend, misses), backend, items: input.items.map((i) => i.name), progress: misses ? `${backend}: starting` : 'from the image cache', pid: o.pid ?? process.pid };
  save(P, job);
  const done = generateImages(P, input, { backends, cacheDir: o.cacheDir, onStatus: (s) => save(P, { ...job, progress: `${backend}: ${s}` }) })
    .then((result) => save(P, { ...job, status: 'done', endedAt: new Date().toISOString(), progress: 'done', result, backend: result.backend }))
    .catch((e: Error) => save(P, { ...job, status: 'failed', endedAt: new Date().toISOString(), progress: 'failed', error: e.message }));
  return { id, etaSec: job.etaSec, misses, done };
}

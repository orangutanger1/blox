import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolCtx, ToolOutput } from '../tools/registry.js';
import { generateImages, STYLES, defaultBackends, imageCacheDir, type BackendName, type GenerateResult, type ImageBackend } from './generate.js';
import { listImageJobs, readImageJob, startImageJob, type ImageJob } from './jobs.js';
import { kernelStatus, kaggleUser, realKaggle, setupWeights } from './kaggle.js';
import { WEIGHTS_SLUG } from './kaggleScripts.js';

export const IMAGE_DESCRIPTION =
  'AI images for icons and UI art (no emoji). generate {items:[{name, prompt, seed?}], style?: icon|hud|item|badge|<raw style text>="icon" (hud = simple 32 px-readable HUD glyphs), size?=512, backend?: kaggle-qwen|cloudflare-flux, overwrite?, fresh?, wait?} — starts a background job and returns its id + ETA at once (all-cached requests finish in the call; wait:true blocks) → transparent, trimmed, square PNGs at assets/icons/<name>.png, each a candidate in .blox/assets.json with model, prompt, seed and licence. Default backend: Qwen-Image-2.1 as ONE Kaggle T4x2 batch (≈10 min setup + ~40 s per 512px image; batch every icon you need into one call — the GPU quota is weekly); falls back to Cloudflare FLUX.1-schnell when Kaggle is unavailable. Images are cached in ~/.cache/blox/images by prompt+style+size+backend(+seed): repeats return at once and only new prompts go to Kaggle; fresh:true skips the cache. Write prompts as the object only ("a gold coin with a star"); the style preset adds the look. Then asset sheet → asset upload. Qwen output is non-commercial (fine for personal games; release check fails it once blox.config.json has "monetized": true) | setup (once: copies the Qwen weights into a private Kaggle kernel, ~20 min, no upload from this PC) | status {job?} (the progress of a job, then its files and images; no job and none running = is setup done?).';

export const imageShape = {
  action: z.enum(['generate', 'setup', 'status']),
  items: z.array(z.object({ name: z.string(), prompt: z.string(), seed: z.number().int().optional() })).optional(),
  style: z.string().optional(),
  size: z.number().int().min(64).max(1024).optional(),
  backend: z.enum(['kaggle-qwen', 'cloudflare-flux']).optional(),
  overwrite: z.boolean().optional(),
  fresh: z.boolean().optional(),
  wait: z.boolean().optional(),
  job: z.string().optional(),
};

// Swappable in tests.
export const imageToolDeps: { backends: () => ImageBackend[]; cacheDir: () => string | null; lastJob?: Promise<void> } = {
  backends: defaultBackends,
  cacheDir: imageCacheDir,
};

const mins = (sec: number) => (sec < 90 ? `${Math.max(1, Math.round(sec))} s` : `${Math.round(sec / 60)} min`);

function resultOutput(P: string, r: GenerateResult, head = ''): ToolOutput {
  const lines = [
    head + `image generate (${r.backend}): ${r.written.length} written${r.cached?.length ? ` (${r.cached.length} from the image cache)` : ''}, ${r.failed.length} failed`,
    ...r.written.map((w) => `  ✓ ${w.file}${w.seed !== undefined ? ` (seed ${w.seed})` : ''}${r.cached?.includes(w.name) ? ' cached' : ''}`),
    ...r.failed.map((f) => `  ✗ ${f.name}: ${f.error}`),
    ...r.notes.map((n) => `  note: ${n}`),
    r.written.length ? `next: look at them, then asset {action:"sheet", id, files:[...]} → asset {action:"upload"}` : '',
  ].filter(Boolean);
  const images = r.written.slice(0, 12).map((w) => ({ data: readFileSync(join(P, w.file)).toString('base64'), mimeType: 'image/png' }));
  return { text: lines.join('\n'), images, artifacts: r.written.map((w) => w.file), isError: r.written.length === 0, summary: `${r.written.length}/${r.written.length + r.failed.length} via ${r.backend}` };
}

function jobOutput(P: string, j: ImageJob): ToolOutput {
  if (j.status === 'done' && j.result) return resultOutput(P, j.result, `job ${j.id} done. `);
  const took = (Date.now() - Date.parse(j.startedAt)) / 1000;
  if (j.status === 'running')
    return { text: `job ${j.id} running (${j.progress}) — ${mins(took)} so far, ETA ${mins(Math.max(0, j.etaSec - took))} more for ${j.items.length} image(s). Do other work, then image {action:"status", job:"${j.id}"} again.`, summary: 'running' };
  if (j.status === 'lost') return { text: `job ${j.id} lost: the blox server that ran it exited. Run image generate again (finished images are in the cache).`, isError: true, summary: 'lost' };
  return { text: `job ${j.id} failed: ${j.error}`, isError: true, summary: 'failed' };
}

export async function imageTool(a: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput> {
  if (a.action === 'status' && (a.job || listImageJobs(ctx.projectPath).some((j) => j.status === 'running'))) {
    const j = a.job ? readImageJob(ctx.projectPath, a.job as string) : listImageJobs(ctx.projectPath).find((x) => x.status === 'running')!;
    if (!j) return { text: `no image job ${a.job} (jobs: ${listImageJobs(ctx.projectPath).slice(0, 5).map((x) => `${x.id} ${x.status}`).join(', ') || 'none'})`, isError: true, summary: 'no job' };
    return jobOutput(ctx.projectPath, j);
  }
  if (a.action === 'status' || a.action === 'setup') {
    if (a.action === 'setup') {
      const r = await setupWeights({ workDir: mkdtempSync(join(tmpdir(), 'blox-kaggle-')) });
      const ok = r.status === 'complete';
      return { text: ok ? `Qwen weights ready in ${r.user}/${WEIGHTS_SLUG}${r.already ? ' (already set up)' : ''}.` : `weights kernel ${r.user}/${WEIGHTS_SLUG} ended ${r.status} — see https://www.kaggle.com/code/${r.user}/${WEIGHTS_SLUG}`, isError: !ok, summary: r.status };
    }
    const user = await kaggleUser(realKaggle);
    const s = await kernelStatus(realKaggle, `${user}/${WEIGHTS_SLUG}`).catch(() => 'missing');
    return { text: `kaggle user ${user}; weights kernel ${user}/${WEIGHTS_SLUG}: ${s}${s === 'complete' ? '' : ' — run image {action:"setup"}'}`, summary: String(s) };
  }
  const all = imageToolDeps.backends();
  const want = a.backend as BackendName | undefined;
  const backends = want ? all.filter((b) => b.name === want) : all;
  const input = { items: (a.items as { name: string; prompt: string; seed?: number }[]) ?? [], style: a.style as string | undefined, size: a.size as number | undefined, overwrite: a.overwrite === true, fresh: a.fresh === true };
  if (a.wait === true) return resultOutput(ctx.projectPath, await generateImages(ctx.projectPath, input, { backends, cacheDir: imageToolDeps.cacheDir() }));
  const j = startImageJob(ctx.projectPath, input, { backends, cacheDir: imageToolDeps.cacheDir() });
  imageToolDeps.lastJob = j.done;
  if (!j.misses) {
    await j.done;
    return jobOutput(ctx.projectPath, readImageJob(ctx.projectPath, j.id)!);
  }
  return {
    text: `started image job ${j.id}: ${input.items.length} image(s), ${j.misses} to generate on ${backends[0]?.name} — about ${mins(j.etaSec)}. Don't sleep-poll: do other work (code, UI layout with placeholder icons), then image {action:"status", job:"${j.id}"}.`,
    summary: `job ${j.id}`,
  };
}

export { STYLES };

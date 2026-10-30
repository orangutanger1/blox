import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolCtx, ToolOutput } from '../tools/registry.js';
import { generateImages, STYLES, defaultBackends, imageCacheDir, type GenerateResult, type ImageBackend } from './generate.js';
import { listImageJobs, readImageJob, startImageJob, type ImageJob } from './jobs.js';
import { kieCredit, kieModels } from './kie.js';
import { generateRef, generateSheet, REF_KINDS, runModel, type SheetResult } from './sheet.js';

export const IMAGE_DESCRIPTION =
  'AI images and media via kie.ai (KIE_API_KEY; every generation costs credits — check credit first for big batches). ' +
  'generate {items:[{name, prompt}], style?: icon|hud|item|badge|<raw style text>="icon" (hud = simple 32 px-readable HUD glyphs), size?=512, model?="gpt-image-2-text-to-image" (falls back to nano-banana-2-1), refs?:[project image paths] (match their style/character/palette — pass an earlier sheet or icon to keep a set consistent), overwrite?, fresh?, wait?} — starts a background job (id + ETA at once; wait:true blocks) → transparent, trimmed, square PNGs at assets/icons/<name>.png, each a candidate in .blox/assets.json with model, prompt and licence. ' +
  '| sheet {name, items:[{name, prompt}] (2–16), style?, cols?, refs?, size?, overwrite?, fresh?} — ONE image with every item on a grid (one style and palette, one generation\'s credits), saved at assets/sheets/<name>.png and cut into assets/icons/<item>.png; prefer it over generate for a set of related icons/props. ' +
  '| ref {name, prompt, kind?: turnaround|style|concept|ui|raw="concept", refs?, model?, aspect?} — a reference image for YOU at .blox/refs/<name>.png (returned as an image): turnaround → pass to model brief refs before building a 3D model; style → look at it before UI/map work and compare screenshots against it; ui → a mockup to build from. ' +
  '| run {model, input:{...}, name, timeout?} — any kie.ai model (video, audio, upscale, background removal, ...): fields per the model\'s schema; string values naming project files are uploaded first; results land in assets/media/<name>.<ext>. ' +
  '| models {query?} (catalog with prices) | credit (balance) | status {job?} (an image job\'s progress, then its files and images). ' +
  'Images are cached in ~/.cache/blox/images by prompt+style+size+model+refs: repeats cost nothing; fresh:true skips the cache. Write prompts as the object only ("a gold coin with a star"); the style preset adds the look. Then asset sheet → asset upload.';

export const imageShape = {
  action: z.enum(['generate', 'sheet', 'ref', 'run', 'models', 'credit', 'status']),
  items: z.array(z.object({ name: z.string(), prompt: z.string() })).optional(),
  name: z.string().optional(),
  prompt: z.string().optional(),
  kind: z.enum(['turnaround', 'style', 'concept', 'ui', 'raw']).optional(),
  style: z.string().optional(),
  size: z.number().int().min(64).max(1024).optional(),
  cols: z.number().int().min(1).max(8).optional(),
  model: z.string().optional(),
  refs: z.array(z.string()).optional(),
  aspect: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  timeout: z.number().int().min(30).max(3600).optional(),
  query: z.string().optional(),
  overwrite: z.boolean().optional(),
  fresh: z.boolean().optional(),
  wait: z.boolean().optional(),
  job: z.string().optional(),
};

// Swappable in tests.
export const imageToolDeps: { backends: (model?: string) => ImageBackend[]; cacheDir: () => string | null; lastJob?: Promise<void> } = {
  backends: defaultBackends,
  cacheDir: imageCacheDir,
};

const mins = (sec: number) => (sec < 90 ? `${Math.max(1, Math.round(sec))} s` : `${Math.round(sec / 60)} min`);

function resultOutput(P: string, r: GenerateResult, head = ''): ToolOutput {
  const lines = [
    head + `image ${'sheet' in r ? `sheet ${(r as SheetResult).sheet} (${(r as SheetResult).grid.cols}×${(r as SheetResult).grid.rows})` : 'generate'} (${r.backend}): ${r.written.length} written${r.cached?.length ? ` (${r.cached.length} from the image cache)` : ''}, ${r.failed.length} failed`,
    ...r.written.map((w) => `  ✓ ${w.file}${w.seed !== undefined ? ` (seed ${w.seed})` : ''}${r.cached?.includes(w.name) ? ' cached' : ''}`),
    ...r.failed.map((f) => `  ✗ ${f.name}: ${f.error}`),
    ...r.notes.map((n) => `  note: ${n}`),
    r.written.length ? `next: look at them, then asset {action:"sheet", id, files:[...]} → asset {action:"upload"}` : '',
  ].filter(Boolean);
  const images = [...('sheet' in r ? [{ data: readFileSync(join(P, (r as SheetResult).sheet)).toString('base64'), mimeType: 'image/png' }] : []), ...r.written.slice(0, 12).map((w) => ({ data: readFileSync(join(P, w.file)).toString('base64'), mimeType: 'image/png' }))];
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
  const P = ctx.projectPath;
  if (a.action === 'credit' || a.action === 'status') {
    const c = await kieCredit();
    return { text: `kie.ai balance: ${c} credits (≈ $${(c * 0.005).toFixed(2)}); GPT Image 2 at 1K costs 6 credits per image or sheet.${a.action === 'status' ? ' No image job running.' : ''}`, summary: `${c} credits` };
  }
  if (a.action === 'models') {
    const q = String(a.query ?? '').toLowerCase();
    const ms = (await kieModels()).filter((m) => !q || `${m.model} ${m.provider} ${m.taskType.join(' ')}`.toLowerCase().includes(q));
    return { text: ms.slice(0, 80).map((m) => `${m.model} [${m.taskType.join(', ')}] ${(m.pricingDesc ?? '').split('\n')[0].slice(0, 110)}`).join('\n') + (ms.length > 80 ? `\n… ${ms.length - 80} more — narrow the query` : '') + '\nInput fields: https://api.kie.ai/api/v1/models/<model>/schema (or the kie-models skill).', summary: `${ms.length} models` };
  }
  if (a.action === 'ref') {
    if (!a.name || !a.prompt) return { text: 'image ref: give name and prompt', isError: true, summary: 'bad args' };
    const r = await generateRef(P, { name: a.name as string, prompt: a.prompt as string, kind: a.kind as never, refs: a.refs as string[] | undefined, model: a.model as string | undefined, aspect: a.aspect as string | undefined });
    const next = a.kind === 'turnaround' ? `next: model {action:"brief", id, prompt, refs:["${r.file}"]}` : 'next: keep it in view while building; compare your screenshots against it';
    return { text: `ref ${r.file} (${r.model}${r.credits !== undefined ? `, ${r.credits} credits` : ''}). Look at it now. ${next}`, images: [{ data: readFileSync(join(P, r.file)).toString('base64'), mimeType: 'image/png' }], artifacts: [r.file], summary: r.file };
  }
  if (a.action === 'run') {
    if (!a.model || !a.input || !a.name) return { text: 'image run: give model, input and name (see image {action:"models"} and the model schema)', isError: true, summary: 'bad args' };
    const r = await runModel(P, { model: a.model as string, input: a.input as Record<string, unknown>, name: a.name as string, timeoutSec: a.timeout as number | undefined });
    const pngs = r.files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).slice(0, 4);
    return {
      text: [`${a.model}: ${r.files.length} file(s)${r.credits !== undefined ? `, ${r.credits} credits` : ''}`, ...r.files.map((f) => `  ✓ ${f}`), r.files.length ? '' : `response: ${JSON.stringify(r.response).slice(0, 1500)}`].filter(Boolean).join('\n'),
      images: pngs.map((f) => ({ data: readFileSync(join(P, f)).toString('base64'), mimeType: /png$/i.test(f) ? 'image/png' : 'image/jpeg' })),
      artifacts: r.files,
      summary: `${r.files.length} file(s)`,
    };
  }
  if (a.action === 'sheet') {
    if (!a.name || !(a.items as unknown[])?.length) return { text: 'image sheet: give name and items [{name, prompt}]', isError: true, summary: 'bad args' };
    const r = await generateSheet(P, { name: a.name as string, items: a.items as { name: string; prompt: string }[], style: a.style as string | undefined, cols: a.cols as number | undefined, size: a.size as number | undefined, refs: a.refs as string[] | undefined, overwrite: a.overwrite === true, fresh: a.fresh === true }, { backends: imageToolDeps.backends(a.model as string | undefined), cacheDir: imageToolDeps.cacheDir() });
    return resultOutput(P, r);
  }
  const backends = imageToolDeps.backends(a.model as string | undefined);
  const input = { items: (a.items as { name: string; prompt: string }[]) ?? [], style: a.style as string | undefined, size: a.size as number | undefined, refs: a.refs as string[] | undefined, overwrite: a.overwrite === true, fresh: a.fresh === true };
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

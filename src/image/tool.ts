import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolCtx, ToolOutput } from '../tools/registry.js';
import { generateImages, STYLES, defaultBackends, imageCacheDir, type BackendName } from './generate.js';
import { kernelStatus, kaggleUser, realKaggle, setupWeights } from './kaggle.js';
import { WEIGHTS_SLUG } from './kaggleScripts.js';

export const IMAGE_DESCRIPTION =
  'AI images for icons and UI art (no emoji). generate {items:[{name, prompt, seed?}], style?: icon|item|badge|<raw style text>="icon", size?=512, backend?: kaggle-qwen|cloudflare-flux, overwrite?, fresh?} → transparent, trimmed, square PNGs at assets/icons/<name>.png, each a candidate in .blox/assets.json with model, prompt, seed and licence. Default backend: Qwen-Image-2.1 as ONE Kaggle T4x2 batch (≈10 min setup + ~40 s per 512px image; batch every icon you need into one call — the GPU quota is weekly); falls back to Cloudflare FLUX.1-schnell when Kaggle is unavailable. Images are cached in ~/.cache/blox/images by prompt+style+size+backend(+seed): repeats return at once and only new prompts go to Kaggle; fresh:true skips the cache. Write prompts as the object only ("a gold coin with a star"); the style preset adds the look. Then asset sheet → asset upload. Qwen output is non-commercial (fine for personal games; release check fails it once blox.config.json has "monetized": true) | setup (once: copies the Qwen weights into a private Kaggle kernel, ~20 min, no upload from this PC) | status (is setup done?).';

export const imageShape = {
  action: z.enum(['generate', 'setup', 'status']),
  items: z.array(z.object({ name: z.string(), prompt: z.string(), seed: z.number().int().optional() })).optional(),
  style: z.string().optional(),
  size: z.number().int().min(64).max(1024).optional(),
  backend: z.enum(['kaggle-qwen', 'cloudflare-flux']).optional(),
  overwrite: z.boolean().optional(),
  fresh: z.boolean().optional(),
};

export async function imageTool(a: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput> {
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
  const all = defaultBackends();
  const want = a.backend as BackendName | undefined;
  const backends = want ? [all.find((b) => b.name === want)!] : all;
  const r = await generateImages(
    ctx.projectPath,
    { items: (a.items as { name: string; prompt: string; seed?: number }[]) ?? [], style: a.style as string | undefined, size: a.size as number | undefined, overwrite: a.overwrite === true, fresh: a.fresh === true },
    { backends, cacheDir: imageCacheDir() },
  );
  const lines = [
    `image generate (${r.backend}): ${r.written.length} written${r.cached?.length ? ` (${r.cached.length} from the image cache)` : ''}, ${r.failed.length} failed`,
    ...r.written.map((w) => `  ✓ ${w.file}${w.seed !== undefined ? ` (seed ${w.seed})` : ""}${r.cached?.includes(w.name) ? ' cached' : ''}`),
    ...r.failed.map((f) => `  ✗ ${f.name}: ${f.error}`),
    ...r.notes.map((n) => `  note: ${n}`),
    r.written.length ? `next: look at them, then asset {action:"sheet", id, files:[...]} → asset {action:"upload"}` : '',
  ].filter(Boolean);
  const images = r.written.slice(0, 12).map((w) => ({ data: readFileSync(join(ctx.projectPath, w.file)).toString('base64'), mimeType: 'image/png' }));
  return { text: lines.join('\n'), images, artifacts: r.written.map((w) => w.file), isError: r.written.length === 0, summary: `${r.written.length}/${r.written.length + r.failed.length} via ${r.backend}` };
}

export { STYLES };

import { z } from 'zod';

// .blox/presentation.json — store-page presentation: title, description and
// the shots (thumbnails + icon) the render rig captures from the real place.

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const THEMES = ['action', 'exploration', 'character', 'reward', 'social', 'logo'] as const;
export const POSES = ['idle', 'cheer', 'carry', 'punch', 'run', 'point'] as const;

const Shot = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    kind: z.enum(['thumbnail', 'icon']),
    theme: z.enum(THEMES),
    camera: z.object({ position: Vec3, lookAt: Vec3 }).strict(),
    subject: z.object({ at: Vec3, yaw: z.number().optional(), pose: z.enum(POSES).default('idle') }).strict().optional(),
    hero: z.object({ path: z.string().min(1), at: Vec3, scale: z.number().positive().optional() }).strict().optional(),
    overlay: z
      .object({ text: z.string().min(1).max(40), sub: z.string().max(40).optional(), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'color is #RRGGBB').optional() })
      .strict()
      .optional(),
    file: z.string().optional(),
    provenance: z.enum(['render', 'human', 'generated']).optional(),
    renderedAt: z.string().optional(),
  })
  .strict();

export const PresentationSchema = z
  .object({
    version: z.literal(1),
    title: z.string(),
    description: z.string(),
    shots: z.array(Shot).default([]),
  })
  .strict();

export type Presentation = z.infer<typeof PresentationSchema>;
export type Shot = Presentation['shots'][number];

export function validatePresentation(raw: unknown): { ok: true; doc: Presentation } | { ok: false; errors: { path: string; message: string }[] } {
  const p = PresentationSchema.safeParse(raw);
  if (!p.success) return { ok: false, errors: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  const seen = new Set<string>();
  const errors: { path: string; message: string }[] = [];
  p.data.shots.forEach((s, i) => {
    if (seen.has(s.id)) errors.push({ path: `shots.${i}.id`, message: `duplicate id "${s.id}"` });
    seen.add(s.id);
  });
  return errors.length ? { ok: false, errors } : { ok: true, doc: p.data };
}

import { z } from 'zod';
import type { Snapshot } from './snapshot.js';

// An idea the agent proposes from a snapshot. Evidence must be real: every
// cited universeId is in the snapshot and the genre matches a cited game.

export const FORMATS = ['incremental', 'steal-tycoon', 'round', 'survival', 'collection', 'battlegrounds', 'other'] as const;
export type Format = (typeof FORMATS)[number];

const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'ids start with a letter; letters, digits, _ and - only');

export const IdeaSchema = z
  .object({
    id: Id,
    title: z.string().min(1),
    format: z.enum(FORMATS),
    genre_l1: z.string().min(1),
    genre_l2: z.string().optional(),
    theme: z.string().min(1),
    hook: z.string().min(1),
    loop: z.array(z.string().min(1)).min(3),
    monetization: z
      .array(z.object({ kind: z.enum(['pass', 'product', 'subscription']), name: z.string().min(1), priceRobux: z.number().int().positive().optional() }).strict())
      .min(1),
    cites: z.array(z.coerce.number().int().positive()).min(2),
    risks: z.array(z.string()).optional(),
  })
  .strict();
export type Idea = z.infer<typeof IdeaSchema>;

export function validateIdeas(raw: unknown, snap: Snapshot): { ok: true; ideas: Idea[] } | { ok: false; errors: string[] } {
  const list = Array.isArray(raw) ? raw : (raw as { ideas?: unknown } | null)?.ideas;
  const parsed = z.array(IdeaSchema).min(3, 'propose 3 to 6 ideas').max(6, 'propose 3 to 6 ideas').safeParse(list);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(ideas)'}: ${i.message}`) };
  const errors: string[] = [];
  const byId = new Map(snap.games.map((g) => [g.universeId, g]));
  const seen = new Set<string>();
  for (const idea of parsed.data) {
    if (seen.has(idea.id)) errors.push(`${idea.id}: duplicate id`);
    seen.add(idea.id);
    const unknown = idea.cites.filter((c) => !byId.has(c));
    if (unknown.length) errors.push(`${idea.id}: cites not in the ${snap.date} snapshot: ${unknown.join(', ')}`);
    const genres = idea.cites.map((c) => byId.get(c)?.genre.toLowerCase()).filter(Boolean);
    if (genres.length && !genres.includes(idea.genre_l1.toLowerCase()))
      errors.push(`${idea.id}: genre_l1 "${idea.genre_l1}" matches none of its cited games (${[...new Set(genres)].join(', ')})`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, ideas: parsed.data };
}

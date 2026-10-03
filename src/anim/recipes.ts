import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILLS_ROOT } from '../skills.js';

// Tested recipes live in the character-animation skill (one ```json block each),
// so the agent reads the same text the regression test holds them to.
export const RECIPE_SKILL = join(SKILLS_ROOT, 'blox', 'animation', 'character-animation', 'SKILL.md');

export function loadRecipes(file = RECIPE_SKILL): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const m of readFileSync(file, 'utf8').matchAll(/```json\r?\n([\s\S]*?)```/g)) {
    const r = JSON.parse(m[1]) as Record<string, unknown>;
    if (typeof r.name === 'string') out.set(r.name, r);
  }
  return out;
}

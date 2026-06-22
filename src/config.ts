import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const BloxConfigSchema = z.object({
  projectPath: z.string(),
  model: z.string().default('claude-opus-4-8'),
  maxTurns: z.number().int().positive().default(40),
  maxBudgetUsd: z.number().positive().default(5),
  mode: z.enum(['auto', 'ask']).default('auto'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  panel: z
    .object({
      port: z.number().int().positive().default(35768),
      gateTimeoutSeconds: z.number().positive().default(120),
    })
    // prefault (not default): zod v4 .default() short-circuits inner parsing,
    // so {} would skip the field defaults; prefault parses it through them.
    .prefault({}),
});

export type BloxConfig = z.infer<typeof BloxConfigSchema>;

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export function loadConfig(cwd: string, overrides: Partial<BloxConfig> = {}): BloxConfig {
  const file = resolve(cwd, 'blox.config.json');
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const merged = { projectPath: cwd, ...fromFile, ...stripUndefined(overrides) };
  return BloxConfigSchema.parse(merged);
}

// Map parsed CLI flags to config overrides, including only flags that were set so
// that unset flags fall through to blox.config.json / schema defaults.
export function overridesFromArgs(a: {
  projectPath: string | null;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  effort: 'high' | 'xhigh' | null;
  mode: 'auto' | 'ask' | null;
  model: string | null;
}): Partial<BloxConfig> {
  const o: Partial<BloxConfig> = {};
  if (a.projectPath) o.projectPath = a.projectPath;
  if (a.maxTurns != null) o.maxTurns = a.maxTurns;
  if (a.maxBudgetUsd != null) o.maxBudgetUsd = a.maxBudgetUsd;
  if (a.effort != null) o.effort = a.effort;
  if (a.mode != null) o.mode = a.mode;
  if (a.model != null) o.model = a.model;
  return o;
}

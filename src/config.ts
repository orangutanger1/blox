import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const BloxConfigSchema = z.object({
  projectPath: z.string(),
  model: z.string().default('claude-opus-4-8'),
  maxTurns: z.number().int().positive().default(40),
  maxBudgetUsd: z.number().positive().default(5),
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

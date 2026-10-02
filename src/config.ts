import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PRICING } from './relay/pricing.js';

export const PolicySchema = z.object({
  models: z.array(z.string()).optional(),
  maxBudgetUsd: z.number().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  mode: z.enum(['auto', 'ask']).optional(),
  rollingBudget: z
    .object({
      windowDays: z.number().int().positive(),
      maxUsd: z.number().positive(),
    })
    .optional(),
  commitConvention: z.string().optional(),
});

export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_PRICING_CONFIG: Record<string, { in: number; out: number }> = DEFAULT_PRICING;

export const RelaySchema = z.object({
  port: z.number().int().positive().default(8787),
  host: z.string().default('127.0.0.1'),
  apiKeyEnv: z.string().default('ANTHROPIC_API_KEY'),
  upstream: z.string().default('https://api.anthropic.com'),
  membersPath: z.string().default('.blox/relay-members.json'),
  ledgerPath: z.string().default('.blox/relay-audit.jsonl'),
  pricing: z.record(z.string(), z.object({ in: z.number(), out: z.number() })).default(DEFAULT_PRICING_CONFIG),
  // Serve HTTPS with this PEM cert/key (paths relative to the project). Without
  // it the relay is plain HTTP: member tokens cross the network in the clear.
  tls: z.object({ certPath: z.string(), keyPath: z.string() }).optional(),
  // Abort an upstream request that sends nothing for this long.
  upstreamTimeoutSeconds: z.number().positive().default(600),
});
export type Relay = z.infer<typeof RelaySchema>;

export const BloxConfigSchema = z.object({
  projectPath: z.string(),
  // Any model id the configured endpoint accepts (direct, CCR-routed, or other
  // providers); this is only the default.
  model: z.string().default('claude-opus-5-5'),
  // Which agent loop drives a run: the Claude Agent SDK, or a vendor-neutral
  // loop over any OpenAI-compatible endpoint (OpenRouter, OpenAI, local).
  runner: z.enum(['claude', 'openai']).default('claude'),
  // When a subscription run hits its plan usage limit, finish the task on this
  // model through the openai runner (e.g. "openrouter,openai/gpt-6-luna").
  // Unset: the run stops at the limit. Fallback runs are billed by the provider.
  fallbackModel: z.string().optional(),
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
  policy: PolicySchema.optional(),
  relay: RelaySchema.optional(),
  // Which attached Studio to drive when several are open: a name substring
  // (e.g. the place name) or a studio id. BLOX_STUDIO env overrides.
  studio: z.object({ match: z.string().optional() }).prefault({}),
  testDir: z.string().default('tests'),
  worldDir: z.string().default('world'),
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
  runner?: 'claude' | 'openai' | null;
  fallbackModel?: string | null;
}): Partial<BloxConfig> {
  const o: Partial<BloxConfig> = {};
  if (a.projectPath) o.projectPath = a.projectPath;
  if (a.maxTurns != null) o.maxTurns = a.maxTurns;
  if (a.maxBudgetUsd != null) o.maxBudgetUsd = a.maxBudgetUsd;
  if (a.effort != null) o.effort = a.effort;
  if (a.mode != null) o.mode = a.mode;
  if (a.model != null) o.model = a.model;
  if (a.runner != null) o.runner = a.runner;
  if (a.fallbackModel != null) o.fallbackModel = a.fallbackModel;
  return o;
}

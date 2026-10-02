import { z } from 'zod';
import type { OpenCloud } from '../opencloud/client.js';

// Post-launch numbers: from a Creator Hub export the human saves as JSON, or
// from the Analytics Query API. Fractions are 0..1.
export const AnalyticsSchema = z
  .object({
    period: z.string().optional(),
    dau: z.number().nonnegative().optional(),
    retention: z.object({ d1: z.number().min(0).max(1).optional(), d7: z.number().min(0).max(1).optional(), d30: z.number().min(0).max(1).optional() }).strict().default({}),
    sessionLengthMin: z.number().nonnegative().optional(),
    payerConversion: z.number().min(0).max(1).optional(),
    funnel: z.array(z.object({ step: z.number().int().positive(), name: z.string(), users: z.number().nonnegative() }).strict()).default([]),
  })
  .strict();
export type Analytics = z.infer<typeof AnalyticsSchema>;

// GameAnalytics 2025 benchmarks (500+ titles), research report §K.
export const BENCHMARKS: Record<string, { p50: number; p75?: number; p90?: number; fmt: (v: number) => string }> = {
  d1: { p50: 0.103, p75: 0.129, p90: 0.159, fmt: (v) => `${(v * 100).toFixed(1)}%` },
  d7: { p50: 0.016, p75: 0.023, p90: 0.045, fmt: (v) => `${(v * 100).toFixed(1)}%` },
  d30: { p50: 0.005, p90: 0.015, fmt: (v) => `${(v * 100).toFixed(2)}%` },
  sessionLengthMin: { p50: 9.8, p90: 14.7, fmt: (v) => `${v.toFixed(1)} min` },
  payerConversion: { p50: 0.038, fmt: (v) => `${(v * 100).toFixed(1)}%` },
};

export type Lever = 'ftue' | 'offline' | 'progression' | 'monetization';
export interface Finding {
  id: string;
  metric: string;
  detail: string;
  lever: Lever;
  severity: number; // higher = worse, for ordering
}
export interface Grade {
  metric: string;
  value: number;
  band: '<p50' | '>=p50' | '>=p75' | '>=p90'; // highest benchmark reached
}

const LEVERS: Record<string, Lever> = { d1: 'ftue', d7: 'progression', d30: 'progression', sessionLengthMin: 'progression', payerConversion: 'monetization' };

export function gradeAnalytics(a: Analytics): { grades: Grade[]; findings: Finding[] } {
  const values: Record<string, number | undefined> = { ...a.retention, sessionLengthMin: a.sessionLengthMin, payerConversion: a.payerConversion };
  const grades: Grade[] = [];
  const findings: Finding[] = [];
  for (const [metric, b] of Object.entries(BENCHMARKS)) {
    const v = values[metric];
    if (v === undefined) continue;
    const band: Grade['band'] = b.p90 !== undefined && v >= b.p90 ? '>=p90' : b.p75 !== undefined && v >= b.p75 ? '>=p75' : v >= b.p50 ? '>=p50' : '<p50';
    grades.push({ metric, value: v, band });
    if (v < b.p50) findings.push({ id: `below:${metric}`, metric, lever: LEVERS[metric], severity: 1 - v / b.p50, detail: `${metric} ${b.fmt(v)} is below the p50 benchmark ${b.fmt(b.p50)}` });
  }
  const steps = [...a.funnel].sort((x, y) => x.step - y.step);
  let worst: { name: string; drop: number } | null = null;
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1].users;
    const drop = prev > 0 ? 1 - steps[i].users / prev : 0;
    if (!worst || drop > worst.drop) worst = { name: steps[i].name, drop };
  }
  if (worst && worst.drop >= 0.3)
    findings.push({ id: `funnel:${worst.name}`, metric: 'funnel', lever: 'ftue', severity: worst.drop + 0.5, detail: `${(worst.drop * 100).toFixed(0)}% of players drop before onboarding step "${worst.name}"` });
  findings.sort((x, y) => y.severity - x.severity);
  return { grades, findings };
}

// Analytics Query API — request/response shapes unverified (see endpoints.ts);
// mapping is best-effort and isolated here.
const METRIC_NAMES: Record<string, string> = { d1: 'D1Retention', d7: 'D7Retention', d30: 'D30Retention', sessionLengthMin: 'AverageSessionLength', payerConversion: 'PayerConversionRate', dau: 'DailyActiveUsers' };
export async function fetchAnalytics(client: OpenCloud, universeId: number, days = 7): Promise<Analytics> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  const out: Record<string, number> = {};
  for (const [k, metric] of Object.entries(METRIC_NAMES)) {
    const r = await client.queryMetrics(universeId, { metric, granularity: 'OneDay', startTime: start.toISOString(), endTime: end.toISOString() });
    const vals = (r.values ?? r.dataPoints ?? r.data) as { value?: number }[] | undefined;
    const last = Array.isArray(vals) ? vals.filter((v) => typeof v.value === 'number').at(-1)?.value : typeof r.value === 'number' ? r.value : undefined;
    if (last !== undefined) out[k] = last;
  }
  return AnalyticsSchema.parse({
    period: `${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`,
    dau: out.dau,
    retention: { d1: out.d1, d7: out.d7, d30: out.d30 },
    sessionLengthMin: out.sessionLengthMin,
    payerConversion: out.payerConversion,
  });
}

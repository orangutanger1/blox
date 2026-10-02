import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Durable per-project state under <project>/.blox/. Plain JSON files so any
// agent, the CLI, the dashboard and a human with `cat` all read the same truth:
//   events.jsonl      — every blox operation (tool, ok, duration, summary)
//   last-sync.json    — last sync diff
//   last-tests.json   — last test run (per-test results)
//   last-playtest.json— last playtest report (no image bytes; artifact path)
//   task.json         — goal + acceptance criteria + notes
//   artifacts/        — screenshots

export function bloxDir(projectPath: string): string {
  const d = join(projectPath, '.blox');
  mkdirSync(d, { recursive: true });
  return d;
}

export function readJson<T>(projectPath: string, name: string): T | null {
  const f = join(projectPath, '.blox', name);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJson(projectPath: string, name: string, value: unknown): void {
  const f = join(bloxDir(projectPath), name);
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, f);
}

export interface BloxEvent {
  ts: string;
  tool: string;
  ok: boolean;
  ms: number;
  summary: string;
  args?: string;
  error?: string;
  artifacts?: string[];
  agent?: string;
}

const MAX_EVENTS_BYTES = 5_000_000;

export function appendEvent(projectPath: string, e: BloxEvent): void {
  const f = join(bloxDir(projectPath), 'events.jsonl');
  try {
    if (existsSync(f) && statSync(f).size > MAX_EVENTS_BYTES) renameSync(f, `${f}.1`);
  } catch {
    /* rotation is best-effort */
  }
  appendFileSync(f, JSON.stringify(e) + '\n');
}

export function readEvents(projectPath: string, limit = 200): BloxEvent[] {
  const f = join(projectPath, '.blox', 'events.jsonl');
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  const out: BloxEvent[] = [];
  for (const l of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(l) as BloxEvent);
    } catch {
      /* skip torn line */
    }
  }
  return out;
}

// --- task / acceptance criteria ---------------------------------------------

export type CriterionStatus = 'pending' | 'pass' | 'fail';

export interface Criterion {
  id: string;
  text: string;
  // Test-name/file substrings that prove this criterion. When set, status is
  // derived from the last test run; otherwise it is set manually with evidence.
  tests?: string[];
  status: CriterionStatus;
  evidence?: string;
  updatedAt?: string;
}

export interface TaskState {
  goal: string;
  criteria: Criterion[];
  notes: { ts: string; text: string }[];
  blockers: { ts: string; text: string }[];
  updatedAt: string;
}

export interface TestSummaryLike {
  ranAt: string;
  tests: { file: string; name: string; status: string }[];
}

export function loadTask(projectPath: string): TaskState | null {
  return readJson<TaskState>(projectPath, 'task.json');
}

export function saveTask(projectPath: string, t: TaskState): void {
  writeJson(projectPath, 'task.json', { ...t, updatedAt: new Date().toISOString() });
}

// Criteria bound to tests take their status from the latest run: pass only if
// at least one matching test exists and every matching test passed.
export function evaluateCriteria(task: TaskState, lastTests: TestSummaryLike | null): Criterion[] {
  return task.criteria.map((c) => {
    if (!c.tests?.length || !lastTests) return c;
    const matched = lastTests.tests.filter((t) => c.tests!.some((p) => t.name.includes(p) || t.file.includes(p)));
    if (!matched.length) return { ...c, status: 'pending' as const, evidence: `no test matching ${c.tests.join(', ')} yet` };
    const failed = matched.filter((t) => t.status !== 'pass');
    return {
      ...c,
      status: failed.length ? ('fail' as const) : ('pass' as const),
      evidence: failed.length
        ? `${failed.length}/${matched.length} matching tests failing`
        : `${matched.length} matching tests pass`,
    };
  });
}

// Offline checks count as synthetic test results so a criterion binds to one
// with tests: ["design:<id>"] (design sim, .blox/sim-report.json) or
// ["ftue:<id>"] / ["soak:<check>"] (playtest metrics, .blox/metrics-report.json) or
// ["ui:<rule>"] (UI lint, .blox/ui-report.json).
export function withSyntheticResults(projectPath: string, lt: TestSummaryLike | null): TestSummaryLike | null {
  const sim = readJson<{ ranAt: string; assertions: { id: string; ok: boolean }[] }>(projectPath, 'sim-report.json');
  const met = readJson<{ ranAt: string; results: { id: string; ok: boolean }[] }>(projectPath, 'metrics-report.json');
  const ui = readJson<{ ranAt: string; results: { id: string; ok: boolean }[] }>(projectPath, 'ui-report.json');
  if (!sim && !met && !ui) return lt;
  const tests = [
    ...(sim?.assertions ?? []).map((a) => ({ file: 'design', name: `design:${a.id}`, status: a.ok ? 'pass' : 'fail' })),
    ...(met?.results ?? []).map((r) => ({ file: 'metrics', name: r.id, status: r.ok ? 'pass' : 'fail' })),
    ...(ui?.results ?? []).map((r) => ({ file: 'ui', name: r.id, status: r.ok ? 'pass' : 'fail' })),
  ];
  return { ranAt: lt?.ranAt ?? sim?.ranAt ?? met?.ranAt ?? ui!.ranAt, tests: [...(lt?.tests ?? []), ...tests] };
}

// compact: for outputs repeated every turn (run_tests). Passing criteria shrink
// to their ids and the goal is left out; the full form is one task {get} away.
export function formatTask(task: TaskState | null, lastTests: TestSummaryLike | null, opts: { compact?: boolean } = {}): string {
  if (!task) return 'no task set — record the goal and acceptance criteria with task {action:"set"}';
  const crit = evaluateCriteria(task, lastTests);
  const passed = crit.filter((c) => c.status === 'pass');
  const lines = opts.compact ? [] : [`goal: ${task.goal}`];
  lines.push(`criteria: ${passed.length}/${crit.length} passing${opts.compact && passed.length ? ` (${passed.map((c) => c.id).join(', ')})` : ''}`);
  for (const c of crit) {
    if (opts.compact && c.status === 'pass') continue;
    const mark = c.status === 'pass' ? '[x]' : c.status === 'fail' ? '[!]' : '[ ]';
    lines.push(`  ${mark} ${c.id}: ${c.text}${c.tests?.length ? ` (tests: ${c.tests.join(', ')})` : ''}${c.evidence ? ` — ${c.evidence}` : ''}`);
  }
  for (const b of task.blockers) lines.push(`  BLOCKER: ${b.text}`);
  for (const n of task.notes.slice(-5)) lines.push(`  note: ${n.text}`);
  return lines.join('\n');
}

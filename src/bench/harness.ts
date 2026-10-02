import { spawn, spawnSync } from 'node:child_process';
import { DEFAULT_PRICING, costUsd } from '../relay/pricing.js';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { scaffoldProject } from '../scaffold.js';
import { runLuau } from '../studio/luau.js';
import { stopPlay } from '../studio/play.js';
import type { StudioSession } from '../studio/session.js';
import { pushProject } from '../sync/push.js';
import { runTests, type TestRunResult } from '../testing/runner.js';
import { readEvents } from '../state/store.js';

// Agent-agnostic benchmark for "can an agent build a working Roblox game".
//
// A task = a seed project + a prompt + HIDDEN checks (tests/*.spec.luau style,
// run by the harness through blox's own test runner — never shown to the agent,
// never trusting its claims). Each task also ships a reference solution; the
// --validate mode proves every check FAILS on the seed and PASSES on the
// reference, so a benchmark score means something.
//
// The agent is any command line (`{prompt}`/`{project}` placeholders): the
// built-in runner, a legacy checkout, Claude Code with blox MCP, Codex, ...
//
// Scoring is done twice per run:
//   live   — Studio exactly as the agent left it (what a player would get)
//   synced — after the harness pushes the agent's files (are the files right?)
// A system whose edits never reach Studio scores 0 live even with good files.

export interface BenchTask {
  id: string;
  level: string;
  title: string;
  prompt: string;
  dir: string; // absolute task dir (seed/, solution/, checks/)
  core?: boolean; // in the default agent-run suite
}

export interface CheckOutcome {
  passed: number;
  total: number;
  failures: string[];
}

export interface TaskRun {
  task: string;
  level: string;
  attempt: number;
  agentExit: number | null;
  timedOut: boolean;
  durationSec: number;
  costUsd?: number;
  billing?: string;
  turns?: number;
  model?: string;
  tokens?: TokenUsage;
  bloxToolCalls?: number;
  bloxToolErrors?: number;
  live?: CheckOutcome;
  synced?: CheckOutcome;
  pass: boolean; // all live checks passed
  workdir: string;
  notes: string[];
}

export interface BenchReport {
  label: string;
  agent: string;
  startedAt: string;
  finishedAt: string;
  environment: Record<string, string>;
  runs: TaskRun[];
}

export function loadTasks(root: string, ids?: string[]): BenchTask[] {
  const tasksDir = join(root, 'tasks');
  return readdirSync(tasksDir)
    .filter((d) => existsSync(join(tasksDir, d, 'task.json')))
    .sort()
    .map((d) => {
      const j = JSON.parse(readFileSync(join(tasksDir, d, 'task.json'), 'utf8')) as Omit<BenchTask, 'dir'>;
      return { ...j, dir: join(tasksDir, d) };
    })
    .filter((t) => !ids?.length || ids.includes(t.id));
}

// Tasks for an agent run. Each live task costs real money (~$1.5 with a
// frontier model), so the default is the small core suite; `--tasks all` or an
// explicit id list widens it.
export function pickRunTasks(root: string, ids?: string[]): BenchTask[] {
  if (ids?.length === 1 && ids[0] === 'all') return loadTasks(root);
  if (ids?.length) return loadTasks(root, ids);
  return loadTasks(root).filter((t) => t.core);
}

// Wipe user content so every task starts from the same empty place. Only run
// against a throwaway place: this deletes everything in the game services.
export const RESET_LUAU = `for _, c in workspace:GetChildren() do
	if not c:IsA("Terrain") and not c:IsA("Camera") then c:Destroy() end
end
workspace.Terrain:Clear()
for _, name in { "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterGui", "ReplicatedFirst", "Teams" } do
	for _, c in game:GetService(name):GetChildren() do pcall(c.Destroy, c) end
end
for _, c in game:GetService("StarterPlayer").StarterPlayerScripts:GetChildren() do c:Destroy() end
for _, c in game:GetService("StarterPlayer").StarterCharacterScripts:GetChildren() do c:Destroy() end
return #workspace:GetChildren()`;

export async function resetStudio(session: StudioSession): Promise<void> {
  const st = await session.state();
  if (st.mode !== 'Edit') await stopPlay(session);
  const r = await runLuau(session, RESET_LUAU, 'edit', { freshRequire: false });
  if (!r.ok) throw new Error(`studio reset failed: ${r.error?.message}`);
}

export function prepareWorkdir(task: BenchTask, workdir: string, overlay: 'seed' | 'solution'): void {
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  scaffoldProject(workdir, task.id, { agentFiles: false });
  // Seeds/solutions are plain project trees layered over the scaffold.
  const seed = join(task.dir, 'seed');
  if (existsSync(seed)) cpSync(seed, workdir, { recursive: true });
  if (overlay === 'solution') {
    const sol = join(task.dir, 'solution');
    if (existsSync(sol)) cpSync(sol, workdir, { recursive: true });
  }
  // Each workdir is its own git repo. Runners that auto-commit (blox does)
  // would otherwise walk up and commit into whatever repo contains the
  // workdir — observed: a legacy run committed this checkout's WIP.
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: workdir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${workdir}: ${r.stderr}`);
  };
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=blox-bench', '-c', 'user.email=bench@blox.local', 'commit', '-q', '-m', `bench seed: ${task.id}`);
}

export async function evaluate(session: StudioSession, task: BenchTask, workdir: string): Promise<{ result: TestRunResult; outcome: CheckOutcome }> {
  const checkDir = '.bench-checks';
  rmSync(join(workdir, checkDir), { recursive: true, force: true });
  cpSync(join(task.dir, 'checks'), join(workdir, checkDir), { recursive: true });
  try {
    const st = await session.state();
    if (st.mode !== 'Edit') await stopPlay(session);
    const result = await runTests(session, workdir, { testDir: checkDir, testTimeoutSec: 20 });
    const failures = [
      ...result.fileErrors.map((f) => `${f.file}: ${f.message}`),
      ...result.tests.filter((t) => t.status !== 'pass').map((t) => `${t.name}: ${t.status}${t.message ? ` — ${t.message}` : ''}`),
    ];
    const total = result.tests.length + result.fileErrors.length;
    return { result, outcome: { passed: result.passed, total, failures } };
  } finally {
    rmSync(join(workdir, checkDir), { recursive: true, force: true });
  }
}

// Provider-neutral token counts. Agents report them however they can (see
// collectAgentStats); the bench never assumes a particular model or vendor.
export interface TokenUsage {
  input: number; // fresh (uncached) input
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface AgentStats {
  costUsd?: number;
  // Who pays: "subscription" means costUsd is the API-equivalent price of the
  // tokens, not a charge; anything else ("apiKey", "relay", "provider") is billed.
  billing?: string;
  turns?: number;
  model?: string;
  tokens?: TokenUsage;
}

export interface AgentSpec {
  name: string;
  model?: string; // requested model, if the profile passes one
  billing?: string; // default when the agent doesn't report it
  argv: string[]; // with {prompt} {project} placeholders
  env?: Record<string, string>;
  cwdIsProject?: boolean;
  prepare?: (workdir: string) => void; // e.g. write .mcp.json
}

export function substitute(argv: string[], vars: Record<string, string>): string[] {
  return argv.map((a) => a.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m));
}

// Stats from an agent's stdout, for agents with a known output format.
export function parseAgentStats(stdout: string): AgentStats {
  // blox runner report: "turns: 12  cost: $0.4567" (+ optional tokens line)
  const m = /turns:\s*(\d+)\s+cost:\s*\$([\d.]+)/.exec(stdout);
  if (m) {
    const out: AgentStats = { turns: Number(m[1]), costUsd: Number(m[2]) };
    const t = /tokens:\s*input=(\d+)\s+cache_read=(\d+)\s+cache_write=(\d+)\s+output=(\d+)/.exec(stdout);
    if (t) out.tokens = { input: Number(t[1]), cacheRead: Number(t[2]), cacheWrite: Number(t[3]), output: Number(t[4]) };
    const mm = /^model:\s*(\S+)/m.exec(stdout);
    if (mm) out.model = mm[1];
    return out;
  }
  // claude -p --output-format stream-json: one JSON object per line. Turns =
  // distinct assistant message ids (model requests); the result line's
  // num_turns counts about one per tool call.
  const lines = stdout.trim().split('\n');
  if (lines.length > 1 && lines.every((l) => l.startsWith('{'))) {
    const ids = new Set<string>();
    let result = '';
    for (const l of lines) {
      try {
        const o = JSON.parse(l) as { type?: string; message?: { id?: string } };
        if (o.type === 'assistant' && o.message?.id) ids.add(o.message.id);
        if (o.type === 'result') result = l;
      } catch {
        /* skip */
      }
    }
    const out = result ? parseAgentStats(result) : {};
    return ids.size ? { ...out, turns: ids.size } : out;
  }
  // claude -p --output-format json
  const j = /\{[^]*"total_cost_usd"[^]*\}\s*$/.exec(stdout.trim());
  if (j) {
    try {
      const o = JSON.parse(j[0]) as {
        total_cost_usd?: number;
        num_turns?: number;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        modelUsage?: Record<string, unknown>;
      };
      const out: AgentStats = { costUsd: o.total_cost_usd, turns: o.num_turns };
      if (o.usage) {
        out.tokens = {
          input: o.usage.input_tokens ?? 0,
          cacheRead: o.usage.cache_read_input_tokens ?? 0,
          cacheWrite: o.usage.cache_creation_input_tokens ?? 0,
          output: o.usage.output_tokens ?? 0,
        };
      }
      const models = Object.keys(o.modelUsage ?? {});
      if (models.length) out.model = models.join('+');
      return out;
    } catch {
      /* not JSON */
    }
  }
  return {};
}

// Generic contract for any agent: if it writes JSON to $BLOX_BENCH_STATS
// ({ turns?, costUsd?, billing?, model?, tokens?: { input, cacheRead, cacheWrite, output } }),
// that wins over stdout parsing. Missing cost is derived from tokens + model
// via the pricing table when the model is known.
export function collectAgentStats(stdout: string, statsFile: string | null, pricing = DEFAULT_PRICING): AgentStats {
  const stats: AgentStats = parseAgentStats(stdout);
  if (statsFile && existsSync(statsFile)) {
    try {
      const f = JSON.parse(readFileSync(statsFile, 'utf8')) as AgentStats;
      if (typeof f.turns === 'number') stats.turns = f.turns;
      if (typeof f.costUsd === 'number') stats.costUsd = f.costUsd;
      if (typeof f.model === 'string') stats.model = f.model;
      if (typeof f.billing === 'string') stats.billing = f.billing;
      if (f.tokens && typeof f.tokens === 'object') {
        const t = f.tokens;
        stats.tokens = { input: t.input ?? 0, cacheRead: t.cacheRead ?? 0, cacheWrite: t.cacheWrite ?? 0, output: t.output ?? 0 };
      }
    } catch {
      /* malformed stats file: keep stdout stats */
    }
  }
  if (stats.costUsd === undefined && stats.tokens && stats.model) {
    const c = costUsd(stats.tokens, stats.model, pricing);
    if (!c.unknownPrice) stats.costUsd = c.usd;
  }
  return stats;
}

export function runAgentProcess(spec: AgentSpec, argv: string[], workdir: string, logFile: string, timeoutSec: number, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; timedOut: boolean; stdout: string }> {
  return new Promise((res) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: spec.cwdIsProject ? workdir : process.cwd(),
      env: { ...process.env, ...(spec.env ?? {}), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = createWriteStream(logFile);
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; log.write(d); });
    child.stderr.on('data', (d) => log.write(d));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000); }, timeoutSec * 1000);
    child.on('close', (code) => { clearTimeout(timer); log.end(); res({ code, timedOut, stdout }); });
    child.on('error', (e) => { clearTimeout(timer); log.end(`\nspawn error: ${e.message}\n`); res({ code: null, timedOut, stdout }); });
  });
}

export interface BenchOptions {
  root: string; // bench/ dir
  label: string;
  agent: AgentSpec | null; // null = reference/seed validation
  tasks?: string[];
  repeat?: number;
  timeoutSec?: number;
  evaluateSynced?: boolean;
  log?: (s: string) => void;
  onRun?: (report: BenchReport) => void; // called after each task (incremental save)
}

export async function runBench(session: StudioSession, opts: BenchOptions): Promise<BenchReport> {
  const log = opts.log ?? ((s: string) => console.error(s));
  const tasks = pickRunTasks(opts.root, opts.tasks);
  const runsDir = join(opts.root, 'runs', opts.label);
  const report: BenchReport = {
    label: opts.label,
    agent: opts.agent?.name ?? 'none',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    environment: { node: process.version, platform: process.platform },
    runs: [],
  };
  for (let attempt = 1; attempt <= (opts.repeat ?? 1); attempt++) {
    for (const task of tasks) {
      const workdir = resolve(runsDir, `${task.id}${(opts.repeat ?? 1) > 1 ? `-${attempt}` : ''}`);
      log(`[bench] ${task.id} (attempt ${attempt}) → ${workdir}`);
      prepareWorkdir(task, workdir, 'seed');
      const run: TaskRun = { task: task.id, level: task.level, attempt, agentExit: null, timedOut: false, durationSec: 0, pass: false, workdir, notes: [] };
      await resetStudio(session);
      const t0 = Date.now();
      if (opts.agent) {
        opts.agent.prepare?.(workdir);
        // Outside the workdir: agents that commit their tree would include it.
        const promptFile = join(runsDir, `${task.id}-${attempt}.prompt.txt`);
        writeFileSync(promptFile, task.prompt);
        const argv = substitute(opts.agent.argv, { prompt: task.prompt, project: workdir, promptFile });
        // Outside the workdir so agents that commit their tree don't pick it up.
        const statsFile = join(runsDir, `${task.id}-${attempt}.stats.json`);
        rmSync(statsFile, { force: true });
        const r = await runAgentProcess(opts.agent, argv, workdir, join(runsDir, `${task.id}-${attempt}.log`), opts.timeoutSec ?? 1800, { BLOX_BENCH_STATS: statsFile });
        rmSync(promptFile, { force: true });
        run.agentExit = r.code;
        run.timedOut = r.timedOut;
        const stats = collectAgentStats(r.stdout, statsFile);
        if (!stats.model && opts.agent.model) stats.model = opts.agent.model;
        if (!stats.billing && opts.agent.billing) stats.billing = opts.agent.billing;
        Object.assign(run, stats);
      }
      run.durationSec = Math.round((Date.now() - t0) / 1000);
      const ev = readEvents(workdir, 100_000);
      if (ev.length) {
        run.bloxToolCalls = ev.length;
        run.bloxToolErrors = ev.filter((e) => !e.ok).length;
      }
      try {
        run.live = (await evaluate(session, task, workdir)).outcome;
      } catch (e) {
        run.notes.push(`live evaluation failed: ${(e as Error).message}`);
      }
      if (opts.evaluateSynced !== false) {
        try {
          const s = await pushProject(session, workdir);
          if (!s.ok) run.notes.push(`harness sync problems: ${[...s.errors, ...s.builders.filter((b) => b.error).map((b) => `${b.name}: ${b.error}`)].join('; ')}`);
          run.synced = (await evaluate(session, task, workdir)).outcome;
        } catch (e) {
          run.notes.push(`synced evaluation failed: ${(e as Error).message}`);
        }
      }
      run.pass = !!run.live && run.live.total > 0 && run.live.passed === run.live.total;
      log(`[bench] ${task.id}: live ${run.live?.passed ?? '?'}/${run.live?.total ?? '?'}, synced ${run.synced?.passed ?? '-'}/${run.synced?.total ?? '-'}, ${run.durationSec}s${run.costUsd !== undefined ? `, $${run.costUsd.toFixed(2)}` : ''}`);
      report.runs.push(run);
      opts.onRun?.(report);
    }
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

// Check-integrity validation: every task's checks must fail on the seed and
// pass on the reference solution.
export async function validateTasks(session: StudioSession, root: string, ids?: string[], log = (s: string) => console.error(s)) {
  const out: { task: string; seed: CheckOutcome; solution: CheckOutcome; valid: boolean }[] = [];
  for (const task of loadTasks(root, ids)) {
    const wd = resolve(root, 'runs', '_validate', task.id);
    const results: Record<'seed' | 'solution', CheckOutcome> = {} as never;
    for (const overlay of ['seed', 'solution'] as const) {
      prepareWorkdir(task, wd, overlay);
      await resetStudio(session);
      const s = await pushProject(session, wd);
      if (!s.ok) log(`[validate] ${task.id}/${overlay} sync: ${JSON.stringify(s.errors)} ${JSON.stringify(s.builders)}`);
      results[overlay] = (await evaluate(session, task, wd)).outcome;
    }
    const valid = results.solution.total > 0 && results.solution.passed === results.solution.total && results.seed.passed < results.seed.total;
    log(`[validate] ${task.id}: seed ${results.seed.passed}/${results.seed.total}, solution ${results.solution.passed}/${results.solution.total} → ${valid ? 'VALID' : 'INVALID'}`);
    if (!valid) for (const f of results.solution.failures) log(`    solution failure: ${f}`);
    out.push({ task: task.id, seed: results.seed, solution: results.solution, valid });
  }
  return out;
}

export function formatBenchMarkdown(r: BenchReport): string {
  const lines = [
    `# Bench: ${r.label}`,
    '',
    `agent: \`${r.agent}\` · ${r.startedAt} → ${r.finishedAt}`,
    '',
    '| task | level | live checks | synced checks | pass | agent exit | turns | cost | billing | time | tokens in / cache read / cache write / out | blox calls (err) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));
  const tok = (t?: TokenUsage) => (t ? `${k(t.input)} / ${k(t.cacheRead)} / ${k(t.cacheWrite)} / ${k(t.output)}` : '-');
  for (const x of r.runs) {
    lines.push(`| ${x.task}${x.attempt > 1 ? ` #${x.attempt}` : ''} | ${x.level} | ${x.live ? `${x.live.passed}/${x.live.total}` : 'n/a'} | ${x.synced ? `${x.synced.passed}/${x.synced.total}` : 'n/a'} | ${x.pass ? 'PASS' : 'fail'} | ${x.timedOut ? 'timeout' : x.agentExit ?? '-'} | ${x.turns ?? '-'} | ${x.costUsd !== undefined ? `$${x.costUsd.toFixed(2)}` : '-'} | ${x.billing ?? '-'} | ${x.durationSec}s | ${tok(x.tokens)} | ${x.bloxToolCalls !== undefined ? `${x.bloxToolCalls} (${x.bloxToolErrors})` : '-'} |`);
  }
  const passed = r.runs.filter((x) => x.pass).length;
  const sum = (k: 'live' | 'synced') => r.runs.reduce((a, x) => [a[0] + (x[k]?.passed ?? 0), a[1] + (x[k]?.total ?? 0)], [0, 0]);
  const [lp, lt] = sum('live');
  const [sp, st] = sum('synced');
  lines.push('', `**${passed}/${r.runs.length} tasks fully passing (live)** · live checks ${lp}/${lt} · synced checks ${sp}/${st}`);
  // Subscription runs report the API-equivalent price, not a charge; keep the
  // two apart so a total never reads as spend it wasn't.
  const sumCost = (subscription: boolean) => r.runs.filter((x) => (x.billing === 'subscription') === subscription).reduce((a, x) => a + (x.costUsd ?? 0), 0);
  const charged = sumCost(false);
  const subscription = sumCost(true);
  const subText = `$${subscription.toFixed(2)} API-equivalent (subscription, not charged)`;
  const costText = !subscription ? `$${charged.toFixed(2)}` : charged ? `$${charged.toFixed(2)} + ${subText}` : subText;
  const secs = r.runs.reduce((a, x) => a + x.durationSec, 0);
  const turns = r.runs.reduce((a, x) => a + (x.turns ?? 0), 0);
  const models = [...new Set(r.runs.map((x) => x.model).filter(Boolean))];
  lines.push('', `totals: cost ${costText} · time ${secs}s · turns ${turns}${models.length ? ` · model ${models.join(', ')}` : ''}`);
  const fails = r.runs.filter((x) => x.live && x.live.failures.length);
  if (fails.length) {
    lines.push('', '## Live check failures');
    for (const x of fails) {
      lines.push(`- **${x.task}**`);
      for (const f of x.live!.failures.slice(0, 8)) lines.push(`  - ${f.replace(/\n/g, ' ').slice(0, 300)}`);
    }
  }
  const notes = r.runs.filter((x) => x.notes.length);
  if (notes.length) {
    lines.push('', '## Notes');
    for (const x of notes) for (const n of x.notes) lines.push(`- ${x.task}: ${n}`);
  }
  return lines.join('\n') + '\n';
}

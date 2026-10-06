import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { longString, runLuau, userLineOffset } from '../studio/luau.js';
import { StudioError, type StudioSession } from '../studio/session.js';
import { BRIDGE_MAX_TIMEOUT_MS, bridgeDenyReason, bridgeSource, isBridgeFailure, mapBridgeLines } from '../studio/evalBridge.js';
import { collectLogs, startPlay, stopPlay, summarizeLogs, type LogSummary } from '../studio/play.js';
import { hostSource, installHost, newRunId, normalizeHostPositions, pollResults, removeHosts, type PlayContext } from './playHost.js';

// Project test suite: tests/**/*.spec.luau, executed inside Studio.
//
// A spec declares where it runs with a first-lines directive:
//   -- @context edit     (default) edit DataModel, no playtest; fast unit tests
//   -- @context server   server DataModel of a running playtest
//   -- @context client   client DataModel (LocalPlayer, PlayerGui, character)
// Specs get globals: test(name, fn), describe(name, fn), expect(v), waitFor(fn,
// timeout?, msg?). Each spec is compiled with loadstring under its own file
// name, so failures read "tests/coins.spec.luau:14: expected 1, got 0".
//
// Because tests accumulate in the repo, re-running the whole suite after every
// change IS the regression check — the agent never has to remember what used
// to work.

export type TestContext = 'edit' | 'server' | 'client';

export interface SpecFile {
  file: string; // project-relative
  context: TestContext;
  source: string;
}

export interface TestCaseResult {
  file: string;
  name: string;
  context: TestContext;
  status: 'pass' | 'fail' | 'timeout' | 'error';
  message?: string;
  ms: number;
}

export interface SpecOutput {
  context: TestContext;
  line: string;
}

export interface TestRunResult {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  tests: TestCaseResult[];
  fileErrors: { file: string; message: string }[];
  logs?: LogSummary;
  output?: SpecOutput[]; // what specs print()ed, per context
  via?: 'bridge' | 'hosts'; // how server/client specs ran (absent: edit only)
  notes?: string[];
  durationMs: number;
  ranAt: string;
}

const CONTEXT_RE = /^--\s*@context\s+(edit|server|client)\b/m;

export function specContext(source: string): TestContext {
  const head = source.split('\n').slice(0, 5).join('\n');
  return (CONTEXT_RE.exec(head)?.[1] as TestContext | undefined) ?? 'edit';
}

export function discoverSpecs(projectPath: string, testDir = 'tests', filter?: string): SpecFile[] {
  const root = join(projectPath, testDir);
  if (!existsSync(root)) return [];
  const out: SpecFile[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir).sort()) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.spec\.(luau|lua)$/i.test(e)) {
        const file = relative(projectPath, full).replace(/\\/g, '/');
        const source = readFileSync(full, 'utf8');
        out.push({ file, context: specContext(source), source });
      }
    }
  };
  walk(root);
  return filter ? out.filter((s) => s.file.includes(filter)) : out;
}

// Runs a batch of spec files in the current context and returns JSON-able
// results. loadstring() is unavailable in playtest DataModels, so each spec is
// inlined as a function; specLines records where each one starts so failure
// positions map back to the spec file.
// extraParams: names passed to every spec function after waitFor (the
// multiplayer lane passes `mp`); they must be in scope where the code runs.
export function testProgram(specs: SpecFile[], testTimeoutSec: number, opts: { extraParams?: string[] } = {}): { code: string; specLines: number[] } {
  const extra = (opts.extraParams ?? []).map((p) => `, ${p}`).join('');
  // Line 1 also shadows print for spec code (same line, so spec line numbers
  // hold): printed lines come back with the results instead of only the log.
  const parts: string[] = [
    'local __SPECFNS = {} local __OUT = {} local __print = print local print = function(...) local n = select("#", ...) local t = table.create(n) for i = 1, n do t[i] = tostring((select(i, ...))) end if #__OUT < 200 then table.insert(__OUT, string.sub(table.concat(t, " "), 1, 500)) end __print(...) end',
  ];
  const specLines: number[] = [];
  let line = 2; // next user-code line number
  specs.forEach((s, i) => {
    parts.push(`__SPECFNS[${i + 1}] = function(test, it, describe, expect, waitFor${extra})`);
    line += 1;
    specLines.push(line);
    const body = s.source.endsWith('\n') ? s.source.slice(0, -1) : s.source;
    parts.push(body);
    line += body.split('\n').length;
    parts.push('end');
    line += 1;
  });
  // A table literal, not JSONDecode: the eval bridge guardrail refuses any HttpService.
  // Names as byte escapes, so a spec file called e.g. httpPost.spec.luau does
  // not read as an HTTP call to that guardrail.
  const files = specs.map((s) => byteString(s.file)).join(', ');
  parts.push(`local FILES = { ${files} }
local TIMEOUT = ${testTimeoutSec}
local function fmt(v)
	if typeof(v) == "string" then return string.format("%q", v) end
	if typeof(v) == "Instance" then return v:GetFullName() end
	return tostring(v)
end
local function deepEq(a, b)
	if a == b then return true end
	if typeof(a) ~= "table" or typeof(b) ~= "table" then return false end
	for k, v in a do if not deepEq(v, b[k]) then return false end end
	for k in b do if a[k] == nil then return false end end
	return true
end
local __H = {}
function __H.check(cond, msg) if not cond then error(msg, 3) end end
local function expect(actual)
	local m = {}
	-- A table field, not a local function: host Scripts compile with inlining,
	-- which would shift error level 3 off the spec line.
	local check = __H.check
	function m.toBe(e) check(actual == e, "expected " .. fmt(e) .. ", got " .. fmt(actual)) end
	function m.toEqual(e) check(deepEq(actual, e), "expected deep-equal " .. fmt(e) .. ", got " .. fmt(actual)) end
	function m.toBeTruthy() check(actual, "expected truthy, got " .. fmt(actual)) end
	function m.toBeFalsy() check(not actual, "expected falsy, got " .. fmt(actual)) end
	function m.toBeNil() check(actual == nil, "expected nil, got " .. fmt(actual)) end
	function m.toExist() check(actual ~= nil, "expected a value/instance, got nil") end
	function m.toBeGreaterThan(e) check(typeof(actual) == "number" and actual > e, "expected > " .. fmt(e) .. ", got " .. fmt(actual)) end
	function m.toBeGreaterThanOrEqual(e) check(typeof(actual) == "number" and actual >= e, "expected >= " .. fmt(e) .. ", got " .. fmt(actual)) end
	function m.toBeLessThan(e) check(typeof(actual) == "number" and actual < e, "expected < " .. fmt(e) .. ", got " .. fmt(actual)) end
	function m.toBeLessThanOrEqual(e) check(typeof(actual) == "number" and actual <= e, "expected <= " .. fmt(e) .. ", got " .. fmt(actual)) end
	function m.toBeCloseTo(e, eps) eps = eps or 1e-3 check(typeof(actual) == "number" and math.abs(actual - e) <= eps, "expected ~" .. fmt(e) .. ", got " .. fmt(actual)) end
	function m.toContain(e)
		if typeof(actual) == "string" then check(string.find(actual, e, 1, true) ~= nil, "expected " .. fmt(actual) .. " to contain " .. fmt(e)) return end
		local found = false
		if typeof(actual) == "table" then for _, v in actual do if v == e then found = true end end end
		check(found, "expected table to contain " .. fmt(e))
	end
	function m.toBeA(cls)
		local ok = (typeof(actual) == "Instance" and actual:IsA(cls)) or typeof(actual) == cls
		check(ok, "expected a " .. cls .. ", got " .. (typeof(actual) == "Instance" and actual.ClassName or typeof(actual)))
	end
	function m.toThrow(pat)
		local ok, err = pcall(actual)
		check(not ok, "expected function to throw")
		if pat then check(string.find(tostring(err), pat, 1, true) ~= nil, "expected error containing " .. fmt(pat) .. ", got " .. fmt(err)) end
	end
	return m
end
local function waitFor(pred, timeout, msg)
	local deadline = os.clock() + (timeout or 5)
	while os.clock() < deadline do
		local ok, v = pcall(pred)
		if ok and v then return v end
		task.wait(0.1)
	end
	error("waitFor timed out" .. (msg and (": " .. msg) or ""), 2)
end
local results, fileErrors = {}, {}
for i, specFn in __SPECFNS do
	local file = FILES[i]
	local tests = {}
	local prefix = ""
	local function test(name, fn) table.insert(tests, { name = prefix .. name, fn = fn }) end
	local function describe(name, fn) local old = prefix prefix = prefix .. name .. " > " fn() prefix = old end
	local ok, err = pcall(specFn, test, test, describe, expect, waitFor${extra})
	if not ok then
		table.insert(fileErrors, { file = file, message = tostring(err) })
	else
		for _, t in tests do
			local started = os.clock()
			local done, passed, msg = false, false, nil
			local th = task.spawn(function()
				local ok2, e2 = xpcall(t.fn, function(e) return tostring(e) end)
				passed, msg, done = ok2, e2, true
			end)
			local deadline = os.clock() + TIMEOUT
			while not done and os.clock() < deadline do task.wait(0.03) end
			local status
			if not done then
				pcall(task.cancel, th)
				status = "timeout"
				msg = "test exceeded " .. TIMEOUT .. "s"
			else
				status = passed and "pass" or "fail"
			end
			table.insert(results, { file = file, name = t.name, status = status, message = (not passed) and msg or nil, ms = math.floor((os.clock() - started) * 1000) })
		end
	end
end
return { results = results, fileErrors = fileErrors, output = __OUT }`);
  return { code: parts.join('\n'), specLines };
}

// Map "AssistantCommand:<abs>" / "<chunk>:<user>" positions to spec files.
export function mapSpecPositions(msg: string, specs: SpecFile[], specLines: number[], absOffset: number, chunk: string): string {
  const toFile = (userLine: number): string | null => {
    for (let i = specs.length - 1; i >= 0; i--) {
      const start = specLines[i];
      const len = specs[i].source.replace(/\n$/, '').split('\n').length;
      if (userLine >= start && userLine < start + len) return `${specs[i].file}:${userLine - start + 1}`;
    }
    return null;
  };
  return msg
    .replace(/[\w.]*AssistantCommand:(\d+)/g, (m, n: string) => toFile(Number(n) - absOffset) ?? m)
    .replace(new RegExp(`${chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`, 'g'), (m, n: string) => toFile(Number(n)) ?? m);
}

/** A Luau string literal of decimal byte escapes ("\\104\\116…"). */
export function byteString(text: string): string {
  return `"${[...Buffer.from(text, 'utf8')].map((b) => `\\${b}`).join('')}"`;
}

// Syntax-check specs with loadstring (edit DataModel only) so one broken file
// can't take down the whole inlined batch.
async function precheckSyntax(session: StudioSession, specs: SpecFile[]): Promise<Map<string, string>> {
  const bad = new Map<string, string>();
  if (!specs.length) return bad;
  const payload = JSON.stringify(specs.map((s) => ({ file: s.file, source: s.source })));
  const code = `local out = {}
for _, s in game:GetService("HttpService"):JSONDecode(${longString(payload)}) do
	local fn, err = loadstring(s.source, "=" .. s.file)
	if not fn then out[s.file] = tostring(err) end
end
return out`;
  const r = await runLuau(session, code, 'edit', { freshRequire: false, chunkName: '<precheck>' });
  const v = (r.values[0] ?? {}) as Record<string, string>;
  if (r.ok && v && typeof v === 'object' && !Array.isArray(v)) for (const [f, e] of Object.entries(v)) bad.set(f, e);
  return bad;
}

type BatchValue = { results?: Omit<TestCaseResult, 'context'>[]; fileErrors?: { file: string; message: string }[]; output?: string[] };

function toBatch(v: BatchValue, ctx: TestContext, map: (m: string) => string) {
  return {
    tests: (Array.isArray(v.results) ? v.results : []).map((t) => ({ ...t, context: ctx, ...(t.message ? { message: map(t.message) } : {}) })),
    fileErrors: (Array.isArray(v.fileErrors) ? v.fileErrors : []).map((f) => ({ ...f, message: map(f.message) })),
    output: (Array.isArray(v.output) ? v.output : []).map((line) => ({ context: ctx, line: String(line) })),
  };
}

// Server/client specs: injected host scripts + a fresh Play (see playHost.ts).
// Always (re)starts Play so the hosts run, and stops it afterwards.
async function runPlayBatches(session: StudioSession, specs: Record<PlayContext, SpecFile[]>, timeoutSec: number) {
  const tests: TestCaseResult[] = [];
  const fileErrors: { file: string; message: string }[] = [];
  const output: SpecOutput[] = [];
  let logs: LogSummary | undefined;
  const st = await session.state();
  if (st.mode !== 'Edit') await stopPlay(session);
  await removeHosts(session);
  const runId = newRunId();
  const ctxs = (['server', 'client'] as const).filter((c) => specs[c].length);
  const programs = new Map<PlayContext, ReturnType<typeof testProgram>>();
  try {
    for (const c of ctxs) {
      const prog = testProgram(specs[c], timeoutSec);
      programs.set(c, prog);
      await installHost(session, c, hostSource(prog.code, c, runId));
    }
    const info = await startPlay(session);
    if (info.players === 0) throw new StudioError('tool_error', 'playtest started but no player joined within the ready timeout');
    for (const c of ctxs) {
      const prog = programs.get(c)!;
      const deadline = Date.now() + batchTimeoutMs(timeoutSec, specs[c].length);
      const v = await pollResults(session, runId, c, deadline);
      if (v === null || typeof v !== 'object') {
        for (const s of specs[c]) fileErrors.push({ file: s.file, message: `no results from the ${c} test host (it may have errored before reporting; see logs)` });
        continue;
      }
      const map = (m: string) => mapSpecPositions(normalizeHostPositions(m), specs[c], prog.specLines, 0, `<test-runner:${c}>`);
      const b = toBatch(v as BatchValue, c, map);
      tests.push(...b.tests);
      fileErrors.push(...b.fileErrors);
      output.push(...b.output);
    }
    const since = info.startedAt - 1;
    const [sl, cl] = await Promise.all([
      collectLogs(session, 'server', since).catch(() => []),
      collectLogs(session, 'client', since).catch(() => []),
    ]);
    logs = summarizeLogs([...sl, ...cl].filter((l) => !l.message.startsWith('BLOXTEST:')));
  } finally {
    await stopPlay(session).catch(() => {});
    await removeHosts(session).catch(() => {});
  }
  return { tests, fileErrors, logs, output };
}

const batchTimeoutMs = (timeoutSec: number, n: number) => (timeoutSec * 1000 + 2000) * Math.max(1, n * 5) + 30_000;

// Why a play run can't use the eval bridge (null: it can).
export function bridgeIneligible(specs: Record<PlayContext, SpecFile[]>, timeoutSec: number): string | null {
  for (const c of ['server', 'client'] as const) {
    if (!specs[c].length) continue;
    const why = bridgeDenyReason(testProgram(specs[c], timeoutSec).code);
    if (why) return `${c} specs: ${why}`;
  }
  return null;
}

// Server/client specs through the plugin eval bridge (bridge.eval): one Play,
// each context's program run directly at game-script identity, results
// returned (no injected hosts, no log scraping). Throws if the bridge fails.
async function runPlayViaBridge(session: StudioSession, specs: Record<PlayContext, SpecFile[]>, timeoutSec: number) {
  const tests: TestCaseResult[] = [];
  const fileErrors: { file: string; message: string }[] = [];
  const output: SpecOutput[] = [];
  const st = await session.state();
  if (st.mode !== 'Edit') await stopPlay(session);
  await removeHosts(session);
  try {
    const info = await startPlay(session);
    if (info.players === 0) throw new StudioError('tool_error', 'playtest started but no player joined within the ready timeout');
    for (const c of ['server', 'client'] as const) {
      const b = await runBatch(session, specs[c], c, timeoutSec, true);
      tests.push(...b.tests);
      fileErrors.push(...b.fileErrors);
      output.push(...b.output);
    }
    const since = info.startedAt - 1;
    const [sl, cl] = await Promise.all([
      collectLogs(session, 'server', since).catch(() => []),
      collectLogs(session, 'client', since).catch(() => []),
    ]);
    return { tests, fileErrors, logs: summarizeLogs([...sl, ...cl]), output };
  } finally {
    await stopPlay(session).catch(() => {});
  }
}

export interface RunTestsOptions {
  testDir?: string;
  filter?: string;
  contexts?: TestContext[];
  testTimeoutSec?: number;
}

// bridge: a runner failure (no plugin, lane error) throws instead of becoming
// file errors, so the caller can fall back to injected hosts.
async function runBatch(session: StudioSession, specs: SpecFile[], ctx: TestContext, timeoutSec: number, bridge = false) {
  if (specs.length === 0) return { tests: [] as TestCaseResult[], fileErrors: [] as { file: string; message: string }[], output: [] as SpecOutput[] };
  const { code, specLines } = testProgram(specs, timeoutSec);
  const chunk = `<test-runner:${ctx}>`;
  const fresh = ctx === 'edit';
  const r = await runLuau(session, code, ctx, {
    chunkName: chunk,
    freshRequire: fresh,
    // The bridge caps a probe at BRIDGE_MAX_TIMEOUT_MS; a suite that runs
    // longer times out there and reruns in injected hosts.
    timeoutMs: bridge ? Math.min(batchTimeoutMs(timeoutSec, specs.length), BRIDGE_MAX_TIMEOUT_MS) : batchTimeoutMs(timeoutSec, specs.length),
  });
  // Through the bridge, positions inside returned values (test messages) still
  // name the bridge script; turn them into chunk lines first.
  const viaBridge = ctx !== 'edit' && session.evalBridge;
  const bridgeOffset = viaBridge ? bridgeSource(code).userLineOffset : 0;
  const lines = code.split('\n').length;
  const map = (m: string) => mapSpecPositions(viaBridge ? mapBridgeLines(m, bridgeOffset, chunk, lines) : m, specs, specLines, userLineOffset(fresh), chunk);
  if (bridge && !r.ok && isBridgeFailure(r.error?.message ?? '')) throw new StudioError('tool_error', r.error!.message);
  if (!r.ok) {
    return { tests: [], fileErrors: specs.map((s) => ({ file: s.file, message: `runner failed: ${map(r.error?.message ?? 'unknown')}` })), output: [] as SpecOutput[] };
  }
  return toBatch((r.values[0] ?? {}) as BatchValue, ctx, map);
}

export async function runTests(session: StudioSession, projectPath: string, opts: RunTestsOptions = {}): Promise<TestRunResult> {
  const t0 = Date.now();
  const timeoutSec = opts.testTimeoutSec ?? 10;
  const discovered = discoverSpecs(projectPath, opts.testDir, opts.filter).filter((s) => !opts.contexts || opts.contexts.includes(s.context));
  const tests: TestCaseResult[] = [];
  const fileErrors: { file: string; message: string }[] = [];
  const output: SpecOutput[] = [];
  // Syntax precheck needs the edit DataModel: stop a live playtest first (play
  // specs start their own), else one broken spec hangs a whole batch.
  const st0 = await session.state();
  if (st0.mode !== 'Edit' && discovered.length) await stopPlay(session);
  const bad = discovered.length ? await precheckSyntax(session, discovered) : new Map<string, string>();
  for (const [file, message] of bad) fileErrors.push({ file, message: `syntax error: ${message}` });
  const all = discovered.filter((s) => !bad.has(s.file));
  const edit = all.filter((s) => s.context === 'edit');
  const server = all.filter((s) => s.context === 'server');
  const client = all.filter((s) => s.context === 'client');
  let logs: LogSummary | undefined;

  if (edit.length) {
    const st = await session.state();
    if (st.mode !== 'Edit') await stopPlay(session);
    const b = await runBatch(session, edit, 'edit', timeoutSec);
    tests.push(...b.tests);
    fileErrors.push(...b.fileErrors);
    output.push(...b.output);
  }
  let via: TestRunResult['via'];
  const notes: string[] = [];
  if (server.length || client.length) {
    const play = { server, client };
    let b: Awaited<ReturnType<typeof runPlayBatches>> | null = null;
    if (session.evalBridge) {
      const why = bridgeIneligible(play, timeoutSec);
      if (why) notes.push(`eval bridge not used (${why}); specs ran in injected hosts`);
      else {
        try {
          b = await runPlayViaBridge(session, play, timeoutSec);
          via = 'bridge';
        } catch (e) {
          if (!isBridgeFailure((e as Error).message)) throw e;
          notes.push(`eval bridge failed (${(e as Error).message}); specs reran in injected hosts`);
        }
      }
    }
    if (!b) {
      b = await runPlayBatches(session, play, timeoutSec);
      via = 'hosts';
    }
    tests.push(...b.tests);
    fileErrors.push(...b.fileErrors);
    output.push(...b.output);
    logs = b.logs;
  }
  const passed = tests.filter((t) => t.status === 'pass').length;
  return {
    ok: fileErrors.length === 0 && passed === tests.length,
    total: tests.length,
    passed,
    failed: tests.length - passed,
    tests,
    fileErrors,
    ...(logs ? { logs } : {}),
    ...(output.length ? { output } : {}),
    ...(via ? { via } : {}),
    ...(notes.length ? { notes } : {}),
    durationMs: Date.now() - t0,
    ranAt: new Date().toISOString(),
  };
}

export function formatTestRun(r: TestRunResult): string {
  const lines = [`tests ${r.ok ? 'PASS' : 'FAIL'}: ${r.passed}/${r.total} passed (${r.durationMs}ms)`];
  if (r.via === 'bridge') lines.push('  (play specs ran through the eval bridge; HTTP requests are off while it runs)');
  for (const n of r.notes ?? []) lines.push(`  note: ${n}`);
  for (const f of r.fileErrors) lines.push(`  ERROR ${f.file}: ${f.message}`);
  // Failures in full; passes as one line of names (they repeat on every run).
  for (const t of r.tests.filter((x) => x.status !== 'pass')) {
    lines.push(`  ${t.status.toUpperCase()} [${t.context}] ${t.file} › ${t.name}${t.message ? `\n        ${t.message}` : ''}`);
  }
  const ok = r.tests.filter((x) => x.status === 'pass').map((x) => x.name);
  if (ok.length) {
    let names = ok.join('; ');
    if (names.length > 400) names = names.slice(0, 400) + '…';
    lines.push(`  ok (${ok.length}): ${names}`);
  }
  const out = r.output ?? [];
  for (const o of out.slice(0, 30)) lines.push(`  output [${o.context}]: ${o.line}`);
  if (out.length > 30) lines.push(`  output: ${out.length - 30} more line(s)`);
  if (r.logs?.errors.length) {
    lines.push(`  runtime errors during playtest (${r.logs.errors.length}):`);
    for (const e of r.logs.errors.slice(0, 10)) lines.push(`    [${e.context}] ${e.message}${e.count ? ` (x${e.count})` : ''}`);
  }
  return lines.join('\n');
}

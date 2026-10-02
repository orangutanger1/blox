import { z } from 'zod';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BloxConfig } from '../config.js';
import { StudioError, contextToDataModel, resultText, type DataModelContext, type StudioSession } from '../studio/session.js';
import { runLuau, type LuauResult } from '../studio/luau.js';
import { collectLogs, startPlay, stopPlay, summarizeLogs } from '../studio/play.js';
import { formatSyncResult, pushProject, syncDrift } from '../sync/push.js';
import { formatTestRun, runTests, type TestContext, type TestRunResult } from '../testing/runner.js';
import { captureScreenshot, formatPlaytest, playtest, type InputStep, type PlaytestResult } from '../testing/playtest.js';
import {
  appendEvent, evaluateCriteria, formatTask, loadTask, readJson, saveTask, writeJson,
  type Criterion, type TaskState,
} from '../state/store.js';
import { scaffoldProject } from '../scaffold.js';

// blox's agent-facing contract, defined once and served two ways: as a stdio
// MCP server (`blox mcp`, for Claude Code / Codex / Cursor / any MCP client)
// and in-process to the built-in runner. Every call is logged to
// .blox/events.jsonl — the same record the dashboard and `blox status` read.

export interface ToolCtx {
  session: StudioSession;
  projectPath: string;
  config: BloxConfig;
  agent?: string; // who is calling (for the event log)
}

export interface ToolOutput {
  text: string;
  images?: { data: string; mimeType: string }[];
  isError?: boolean;
  artifacts?: string[];
  summary?: string; // one line for the event log
}

export interface BloxTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolOutput>;
}

const context = z.enum(['edit', 'server', 'client']);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);

// Narrow on purpose: HttpService:JSONEncode is fine; outbound requests are not.
const EXTERNAL_HTTP = /:\s*(GetAsync|PostAsync|RequestAsync)\s*\(|HttpGet(Async)?\s*\(/;

function luauText(r: LuauResult): string {
  const parts = [r.ok ? `ok (${r.durationMs}ms)` : `ERROR: ${r.error?.message}`];
  if (r.ok) parts.push(`returned: ${JSON.stringify(r.values.length === 1 ? r.values[0] : r.values)}`);
  if (r.error?.traceback) parts.push(`traceback:\n${r.error.traceback}`);
  if (r.logs.length) parts.push('logs:\n' + r.logs.map((l) => `  [${l.level}] ${l.message}`).join('\n'));
  return parts.join('\n');
}

function filesNewerThan(projectPath: string, iso: string, dirs: string[]): string[] {
  const since = Date.parse(iso);
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      if (e.startsWith('.')) continue;
      const f = join(d, e);
      const st = statSync(f);
      if (st.isDirectory()) walk(f);
      else if (st.mtimeMs > since) out.push(f.slice(projectPath.length + 1));
    }
  };
  for (const d of dirs) walk(join(projectPath, d));
  return out;
}

// Studio's schema minus the studio_id blox fills in.
export function schemaText(schema: unknown): string {
  const sch = JSON.parse(JSON.stringify(schema ?? {})) as { properties?: Record<string, unknown>; required?: string[] };
  if (sch.properties) delete sch.properties.studio_id;
  if (sch.required) sch.required = sch.required.filter((r) => r !== 'studio_id');
  return JSON.stringify(sch);
}

function compactTests(r: TestRunResult) {
  return { ranAt: r.ranAt, ok: r.ok, passed: r.passed, total: r.total, tests: r.tests, fileErrors: r.fileErrors, logErrors: r.logs?.errors ?? [] };
}

function compactPlaytest(r: PlaytestResult) {
  return { ...r, screenshot: r.screenshot ? { path: r.screenshot.path } : undefined, at: new Date().toISOString() };
}

export const TOOLS: BloxTool[] = [
  {
    name: 'status',
    description:
      'Start here: attached Studio + mode, unsynced files, last test run (stale?), last playtest errors, task checklist.',
    shape: {},
    async handler(_a, ctx) {
      const lines = [`project: ${ctx.projectPath}`];
      try {
        const studio = await ctx.session.attach();
        const st = await ctx.session.state();
        lines.push(`studio: attached ${studio.name ?? '(unnamed)'} [${studio.id || 'default'}], mode=${st.mode}`);
        if (st.mode === 'Edit') {
          const drift = await syncDrift(ctx.session, ctx.projectPath, { worldDir: ctx.config.worldDir });
          const n = drift.pending.length + drift.builders.length + drift.deletes.length;
          lines.push(n ? `sync: ${n} change(s) not in Studio yet (${[...drift.pending, ...drift.builders.map((b) => `world:${b}`), ...drift.deletes.map((d) => `-${d}`)].slice(0, 12).join(', ')}) — run sync or run_tests` : 'sync: Studio matches files');
          if (drift.skipped.length) lines.push(`sync skipped: ${drift.skipped.map((s) => s.file).join(', ')}`);
        } else {
          lines.push('sync: (playtest running — stop it to sync)');
        }
      } catch (e) {
        const err = e as StudioError;
        lines.push(`studio: NOT AVAILABLE — ${err.message}${err.hint ? ` (${err.hint})` : ''}`);
      }
      const lt = readJson<ReturnType<typeof compactTests>>(ctx.projectPath, 'last-tests.json');
      if (lt) {
        const changed = filesNewerThan(ctx.projectPath, lt.ranAt, ['src', ctx.config.worldDir, ctx.config.testDir]);
        lines.push(`tests: ${lt.passed}/${lt.total} passed at ${lt.ranAt}${changed.length ? ` — STALE: ${changed.length} file(s) changed since` : ''}`);
        for (const t of lt.tests.filter((t) => t.status !== 'pass').slice(0, 8)) lines.push(`  ${t.status}: ${t.file} › ${t.name}`);
        for (const f of lt.fileErrors.slice(0, 5)) lines.push(`  file error: ${f.file}`);
      } else {
        lines.push('tests: never run');
      }
      const lp = readJson<ReturnType<typeof compactPlaytest>>(ctx.projectPath, 'last-playtest.json');
      if (lp) lines.push(`last playtest (${lp.at}): ${lp.ok ? 'ok' : 'problems'}, ${lp.logs.errors.length} runtime error(s)`);
      lines.push('', formatTask(loadTask(ctx.projectPath), lt));
      return { text: lines.join('\n'), summary: 'status' };
    },
  },
  {
    name: 'sync',
    description:
      'Push files into Studio (scripts + world/ builders), incremental. Edit mode only; run_tests/playtest already sync.',
    shape: { force: z.boolean().optional().describe('re-push all scripts and rebuild every world builder') },
    async handler(a, ctx) {
      const r = await pushProject(ctx.session, ctx.projectPath, { force: a.force === true, worldDir: ctx.config.worldDir });
      writeJson(ctx.projectPath, 'last-sync.json', { ...r, at: new Date().toISOString() });
      return { text: formatSyncResult(r), isError: !r.ok, summary: `+${r.created.length} ~${r.updated.length} -${r.deleted.length}${r.ok ? '' : ' FAILED'}` };
    },
  },
  {
    name: 'run_tests',
    description:
      'Sync, then run tests/*.spec.luau in Studio (server/client specs in one playtest, handled for you). Returns failures with file:line, playtest runtime errors, criteria status.',
    shape: {
      filter: z.string().optional().describe('only spec files whose path contains this'),
      contexts: z.array(context).optional().describe('limit to these spec contexts'),
      sync: z.boolean().optional().describe('default true'),
    },
    async handler(a, ctx) {
      let pre = '';
      if (a.sync !== false) {
        const st = await ctx.session.state();
        if (st.mode !== 'Edit') await stopPlay(ctx.session);
        const s = await pushProject(ctx.session, ctx.projectPath, { worldDir: ctx.config.worldDir });
        writeJson(ctx.projectPath, 'last-sync.json', { ...s, at: new Date().toISOString() });
        pre = formatSyncResult(s).split('\n')[0] + (s.ok ? '' : '\n' + formatSyncResult(s)) + '\n';
      }
      const r = await runTests(ctx.session, ctx.projectPath, {
        testDir: ctx.config.testDir,
        filter: typeof a.filter === 'string' ? a.filter : undefined,
        contexts: Array.isArray(a.contexts) ? (a.contexts as TestContext[]) : undefined,
      });
      if (!a.filter && !a.contexts) writeJson(ctx.projectPath, 'last-tests.json', compactTests(r));
      const task = loadTask(ctx.projectPath);
      const crit = task ? `\n${formatTask(task, r, { compact: true })}` : '';
      const none = r.total === 0 && r.fileErrors.length === 0 ? '\n(no specs found — add tests/*.spec.luau)' : '';
      return { text: pre + formatTestRun(r) + none + crit, isError: !r.ok, summary: `${r.passed}/${r.total} passed` };
    },
  },
  {
    name: 'playtest',
    description:
      'One call: sync → play → wait for character → wait `seconds` → inputs → server_code/client_code probes (returns serialized) → screenshot → typed errors/warnings/output → stop.',
    shape: {
      seconds: z.number().min(0).max(120).optional().describe('game time before probing (default 3)'),
      server_code: z.string().optional().describe('Luau run in the server DataModel; return values are reported'),
      client_code: z.string().optional().describe('Luau run in the client DataModel (LocalPlayer, PlayerGui)'),
      inputs: z
        .array(z.object({ kind: z.enum(['navigate', 'keyboard', 'mouse', 'wait']), args: z.record(z.string(), z.unknown()) }))
        .optional()
        .describe('navigate {x,y,z}|{instance_path}; mouse {actions:[{action:"mouseButtonClick",mouse_button:"left",instance_path}]} (also moveTo/mouseButtonDown/Up/scrollUp/Down, x,y); keyboard {actions:[{action:"keyPress",key_code:"E"}]} (also keyDown/keyUp/textInput+text_inputs); wait {seconds}'),
      screenshot: z.boolean().optional(),
      camera_position: vec3.optional(),
      look_at: vec3.optional(),
      keep_running: z.boolean().optional().describe('leave play running; stop with play {action:"stop"}'),
      sync: z.boolean().optional().describe('default true'),
    },
    async handler(a, ctx) {
      let pre = '';
      if (a.sync !== false) {
        const st = await ctx.session.state();
        if (st.mode === 'Edit') {
          const s = await pushProject(ctx.session, ctx.projectPath, { worldDir: ctx.config.worldDir });
          pre = formatSyncResult(s).split('\n')[0] + '\n';
          if (!s.ok) return { text: formatSyncResult(s), isError: true, summary: 'sync failed' };
        }
      }
      for (const c of [a.server_code, a.client_code]) {
        if (typeof c === 'string' && EXTERNAL_HTTP.test(c)) return { text: 'blocked: probes may not make external HTTP requests', isError: true, summary: 'blocked' };
      }
      const r = await playtest(ctx.session, ctx.projectPath, {
        seconds: typeof a.seconds === 'number' ? a.seconds : undefined,
        serverCode: a.server_code as string | undefined,
        clientCode: a.client_code as string | undefined,
        inputs: a.inputs as InputStep[] | undefined,
        screenshot: a.screenshot === true,
        camera: a.camera_position && a.look_at ? { position: a.camera_position as [number, number, number], lookAt: a.look_at as [number, number, number] } : undefined,
        keepRunning: a.keep_running === true,
      });
      writeJson(ctx.projectPath, 'last-playtest.json', compactPlaytest(r));
      return {
        text: pre + formatPlaytest(r),
        images: r.screenshot ? [{ data: r.screenshot.data, mimeType: r.screenshot.mimeType }] : undefined,
        artifacts: r.screenshot ? [r.screenshot.path] : undefined,
        summary: `${r.ok ? 'ok' : 'problems'}: ${r.logs.errors.length} errors`,
      };
    },
  },
  {
    name: 'run_luau',
    description:
      'Run Luau in Studio; returns serialized return values, printed logs, errors with line numbers. context edit (default) or server/client (needs a running playtest). For probes; lasting checks go in tests/.',
    shape: { code: z.string(), context: context.optional() },
    async handler(a, ctx) {
      const code = String(a.code ?? '');
      if (EXTERNAL_HTTP.test(code)) return { text: 'blocked: run_luau may not make external HTTP requests', isError: true, summary: 'blocked' };
      const r = await runLuau(ctx.session, code, (a.context as 'edit' | 'server' | 'client') ?? 'edit');
      return { text: luauText(r), isError: !r.ok, summary: r.ok ? 'ok' : `error: ${r.error?.message?.slice(0, 80)}` };
    },
  },
  {
    name: 'play',
    description: 'Playtest control: start (waits for character), stop, state.',
    shape: { action: z.enum(['start', 'stop', 'state']) },
    async handler(a, ctx) {
      if (a.action === 'start') {
        const i = await startPlay(ctx.session);
        return { text: `playing: players=${i.players} character=${i.character} ready in ${i.readyMs}ms${i.alreadyRunning ? ' (was already running)' : ''}`, summary: 'start' };
      }
      if (a.action === 'stop') {
        const stopped = await stopPlay(ctx.session);
        return { text: stopped ? 'stopped' : 'was not playing', summary: 'stop' };
      }
      const s = await ctx.session.state();
      return { text: `mode=${s.mode} datamodels=${s.dataModels.join(',')}`, summary: s.mode };
    },
  },
  {
    name: 'logs',
    description: 'Typed error/warning/output lines from a DataModel (server/client during play) for the last N seconds.',
    shape: { context: context.optional(), since_seconds: z.number().positive().optional().describe('default 60') },
    async handler(a, ctx) {
      const ctxName = (a.context as 'edit' | 'server' | 'client') ?? 'edit';
      const since = Date.now() / 1000 - (typeof a.since_seconds === 'number' ? a.since_seconds : 60);
      const logs = await collectLogs(ctx.session, ctxName, since);
      const s = summarizeLogs(logs, 60);
      const lines = [`${s.errors.length} errors, ${s.warnings.length} warnings (${s.noise} env-noise hidden)`];
      for (const l of [...s.errors, ...s.warnings, ...s.output]) lines.push(`[${l.level}] ${l.message}${l.count ? ` (x${l.count})` : ''}`);
      return { text: lines.join('\n'), summary: `${s.errors.length} errors` };
    },
  },
  {
    name: 'screenshot',
    description: 'Image of the Studio viewport (edit or play), optionally aimed; saved under .blox/artifacts.',
    shape: { camera_position: vec3.optional(), look_at: vec3.optional() },
    async handler(a, ctx) {
      const cam = a.camera_position && a.look_at ? { position: a.camera_position as [number, number, number], lookAt: a.look_at as [number, number, number] } : undefined;
      const shot = await captureScreenshot(ctx.session, ctx.projectPath, 'shot', cam);
      if (!shot) return { text: 'screen_capture returned no image', isError: true, summary: 'no image' };
      return { text: `saved ${shot.path}`, images: [{ data: shot.data, mimeType: shot.mimeType }], artifacts: [shot.path], summary: shot.path };
    },
  },
  {
    name: 'explore',
    description: 'Search the live instance tree by instance_type (IsA), keywords, path; keep max_depth small.',
    shape: {
      context: context.optional().describe('default: edit, or server while playing'),
      path: z.string().optional(),
      instance_type: z.string().optional(),
      keywords: z.string().optional(),
      max_depth: z.number().int().positive().optional(),
      head_limit: z.number().int().positive().optional(),
    },
    async handler(a, ctx) {
      const { context: c, ...rest } = a;
      const dm = c ? (c as DataModelContext) : (await ctx.session.state()).mode === 'Edit' ? 'edit' : 'server';
      const r = await ctx.session.call('search_game_tree', { ...rest, datamodel_type: contextToDataModel(dm) });
      return { text: resultText(r), isError: r.isError, summary: 'search_game_tree' };
    },
  },
  {
    name: 'studio_tool',
    description:
      'Last resort: call a raw Studio MCP tool by name (e.g. inspect_instance, search_asset, insert_asset, generate_mesh). name "list" lists tools; name "list" + args {tool} gives that tool\'s full input schema.',
    shape: { name: z.string(), args: z.record(z.string(), z.unknown()).optional() },
    async handler(a, ctx) {
      const name = String(a.name);
      if (name === 'list') {
        const tools = await ctx.session.listTools();
        const want = (a.args as Record<string, unknown> | undefined)?.tool;
        if (typeof want === 'string') {
          const t = tools.find((x) => x.name === want);
          return t ? { text: `${t.name}: ${t.description ?? ''}\ninput schema: ${schemaText(t.inputSchema)}`, summary: `schema ${want}` }
            : { text: `no Studio tool "${want}"`, isError: true, summary: 'no such tool' };
        }
        return {
          text: tools.map((t) => `${t.name}(${(t.inputSchema?.required ?? []).filter((r) => r !== 'studio_id').join(', ')})`).join('\n'),
          summary: 'list',
        };
      }
      if (name === 'http_get') return { text: 'blocked: external web requests are not allowed', isError: true, summary: 'blocked' };
      if (name === 'multi_edit') return { text: 'blocked: edit script files on disk and sync instead of multi_edit', isError: true, summary: 'blocked' };
      const r = await ctx.session.call(name, (a.args as Record<string, unknown>) ?? {}, 600_000);
      // A rejected call usually means wrong arguments: hand back the real schema
      // so the next attempt is informed instead of guessed.
      let hint = '';
      if (r.isError) {
        const t = (await ctx.session.listTools().catch(() => [])).find((x) => x.name === name);
        if (t) hint = `\ninput schema for ${name}: ${schemaText(t.inputSchema)}`;
      }
      const images = (r.content ?? []).filter((b) => b.type === 'image' && b.data).map((b) => ({ data: b.data!, mimeType: b.mimeType ?? 'image/png' }));
      return { text: (resultText(r) || '(no text)') + hint, images: images.length ? images : undefined, isError: r.isError, summary: name };
    },
  },
  {
    name: 'task',
    description:
      'Persistent goal + acceptance criteria. get | set {goal, criteria:[{id,text,tests?}]} (tests = test names; run_tests then sets status) | update {id,status,evidence} (criteria without tests) | note {text} | block {text} (needs a human) | unblock.',
    shape: {
      action: z.enum(['get', 'set', 'update', 'note', 'block', 'unblock']),
      goal: z.string().optional(),
      criteria: z.array(z.object({ id: z.string(), text: z.string(), tests: z.array(z.string()).optional() })).optional(),
      id: z.string().optional(),
      status: z.enum(['pending', 'pass', 'fail']).optional(),
      evidence: z.string().optional(),
      text: z.string().optional(),
    },
    async handler(a, ctx) {
      const lt = readJson<{ ranAt: string; tests: { file: string; name: string; status: string }[] }>(ctx.projectPath, 'last-tests.json');
      const now = new Date().toISOString();
      let task = loadTask(ctx.projectPath);
      if (a.action === 'set') {
        if (typeof a.goal !== 'string') return { text: 'set needs goal', isError: true };
        const prev = new Map((task?.criteria ?? []).map((c) => [c.id, c]));
        const criteria: Criterion[] = ((a.criteria as Criterion[] | undefined) ?? []).map((c) => ({
          ...c,
          status: prev.get(c.id)?.status ?? 'pending',
          evidence: prev.get(c.id)?.evidence,
        }));
        task = { goal: a.goal, criteria, notes: task?.notes ?? [], blockers: task?.blockers ?? [], updatedAt: now };
      } else if (!task) {
        return { text: formatTask(null, lt), summary: 'no task' };
      } else if (a.action === 'update') {
        const c = task.criteria.find((x) => x.id === a.id);
        if (!c) return { text: `no criterion ${String(a.id)}`, isError: true };
        if (c.tests?.length) return { text: `${c.id} is bound to tests; its status comes from run_tests`, isError: true };
        c.status = (a.status as Criterion['status']) ?? c.status;
        c.evidence = typeof a.evidence === 'string' ? a.evidence : c.evidence;
        c.updatedAt = now;
      } else if (a.action === 'note' && typeof a.text === 'string') {
        task.notes.push({ ts: now, text: a.text });
      } else if (a.action === 'block' && typeof a.text === 'string') {
        task.blockers.push({ ts: now, text: a.text });
      } else if (a.action === 'unblock') {
        task.blockers = typeof a.text === 'string' ? task.blockers.filter((b) => !b.text.includes(a.text as string)) : [];
      }
      if (a.action !== 'get') {
        // Persist derived statuses so the dashboard reads the same truth.
        task.criteria = evaluateCriteria(task, lt).map((c, i) => (task!.criteria[i].tests?.length ? c : task!.criteria[i]));
        saveTask(ctx.projectPath, task as TaskState);
      }
      return { text: formatTask(task, lt), summary: String(a.action) };
    },
  },
  {
    name: 'scaffold',
    description: 'Create the standard project layout (default.project.json, src/, world/, tests/, AGENTS.md); keeps existing files.',
    shape: { name: z.string().optional() },
    async handler(a, ctx) {
      const r = scaffoldProject(ctx.projectPath, typeof a.name === 'string' ? a.name : undefined);
      return { text: `created: ${r.created.join(', ') || '(nothing)'}\nkept: ${r.existing.join(', ') || '(none)'}`, summary: `${r.created.length} created` };
    },
  },
];

export function argSummary(args: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(args);
  } catch {
    s = '';
  }
  s = s.replace(/\s+/g, ' ');
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

// Invoke a tool with uniform error handling + event logging.
export async function invokeTool(tool: BloxTool, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput> {
  const t0 = Date.now();
  let out: ToolOutput;
  try {
    const parsed = z.object(tool.shape).parse(args ?? {});
    out = await tool.handler(parsed, ctx);
  } catch (e) {
    const err = e as StudioError;
    const msg = e instanceof z.ZodError ? `invalid arguments: ${e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` : err?.message ?? String(e);
    out = {
      text: `${err?.code ? `[${err.code}] ` : ''}${msg}${err?.hint ? `\nhint: ${err.hint}` : ''}`,
      isError: true,
      summary: msg.slice(0, 120),
    };
  }
  try {
    appendEvent(ctx.projectPath, {
      ts: new Date().toISOString(),
      tool: tool.name,
      ok: !out.isError,
      ms: Date.now() - t0,
      summary: out.summary ?? '',
      args: argSummary(args ?? {}),
      ...(out.isError ? { error: out.text.slice(0, 500) } : {}),
      ...(out.artifacts ? { artifacts: out.artifacts } : {}),
      ...(ctx.agent ? { agent: ctx.agent } : {}),
    });
  } catch {
    /* observability must never break a tool call */
  }
  return out;
}

export function findTool(name: string): BloxTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

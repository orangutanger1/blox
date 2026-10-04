import { z } from 'zod';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { BloxConfig } from '../config.js';
import { StudioError, contextToDataModel, resultText, type DataModelContext, type StudioSession } from '../studio/session.js';
import { runLuau, type LuauResult } from '../studio/luau.js';
import { collectLogs, startPlay, stopPlay, summarizeLogs } from '../studio/play.js';
import { formatSyncResult, pushProject, syncDrift } from '../sync/push.js';
import { formatSkillList, listSkills, loadSkill } from '../skills.js';
import { formatTestRun, runTests, type TestContext, type TestRunResult } from '../testing/runner.js';
import { captureScreenshot, formatPlaytest, playtest, type InputStep, type PlaytestResult } from '../testing/playtest.js';
import {
  appendEvent, evaluateCriteria, formatTask, loadTask, readJson, saveTask, withSyntheticResults, writeJson,
  type Criterion, type TaskState, type TestSummaryLike,
} from '../state/store.js';
import { scaffoldProject } from '../scaffold.js';
import { validateDesign, formatErrors, DESIGN_EXAMPLE } from '../design/schema.js';

const EXAMPLE_TEXT = JSON.stringify(DESIGN_EXAMPLE);
import { runSimulation, formatReport } from '../design/report.js';
import { renderTunables, TUNABLES_PATH } from '../design/codegen.js';
import { applyKit, formatApply, KITS_ROOT, listKits } from '../kits.js';
import { runMetrics } from '../metrics/run.js';
import { formatMetrics } from '../metrics/gamefeel.js';
import { runUiLint } from '../ui/run.js';
import { formatUiReport } from '../ui/lint.js';
import { validatePresentation, type Presentation } from '../present/schema.js';
import { defaultShots, describe as describeGame, titleCandidates } from '../present/generate.js';
import { formatPresentLint, lintPresentation, presentResults } from '../present/lint.js';
import { renderShots } from '../present/render.js';
import { formatMp, runMultiplayer } from '../multiplayer/run.js';
import { addAsset, loadManifest, saveManifest } from '../assets/manifest.js';
import { assetResults, formatAssetLint, lintAssets } from '../assets/lint.js';
import { runSanitize, scanProgram, trackedPaths, untrackedFromScan, coveredFromScan } from '../assets/scan.js';
import { runNormalize } from '../assets/blender.js';
import { briefText, checkImages, formatStats, modelDir, previewLuau, readBrief, runModelPy, writeBrief, type ModelStats } from '../model/run.js';
import { buildLuau, checkMotion, keyframeSequenceXml, PLAY_TOLERANCE, prepare, type AnimJson, type BuildResult } from '../model/anim.js';
import { realSpawn, rojoBin } from '../sync/rojo.js';
import { recordImageId, uploadAsset } from '../assets/upload.js';
import { resolveDecalImage } from '../assets/decal.js';
import { refreshRefs, relinkAsset } from '../assets/locate.js';
import { formatRelease, releaseCheck } from '../release/check.js';
import { buildPlace, loadTarget, publishRelease } from '../release/publish.js';
import { AnalyticsSchema, fetchAnalytics, gradeAnalytics, type Finding } from '../liveops/analytics.js';
import { applyChanges, propose, type Proposal } from '../liveops/propose.js';
import { isApproved, pushPayload } from '../liveops/push.js';
import { isPathContained } from '../agent/guardrail.js';
import { animateTool, animateShape, ANIMATE_DESCRIPTION } from '../anim/tool.js';
import { scoutTool, scoutShape, SCOUT_DESCRIPTION } from '../assets/scoutTool.js';
import { OpenCloud, openCloudKey } from '../opencloud/client.js';
import { formatCheck, runCheck } from '../check.js';
import { UNVERIFIED_ENDPOINTS } from '../opencloud/endpoints.js';

// blox's agent-facing contract, defined once and served two ways: as a stdio
// MCP server (`blox mcp`, for Claude Code / Codex / Cursor / any MCP client)
// and in-process to the built-in runner. Every call is logged to
// .blox/events.jsonl — the same record the dashboard and `blox status` read.

import type { FetchLike } from '../assets/scoutWeb.js';

export interface ToolCtx {
  session: StudioSession;
  projectPath: string;
  config: BloxConfig;
  agent?: string; // who is calling (for the event log)
  fetch?: FetchLike; // HTTP for tools that read public web APIs (tests inject one)
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
          if (n || !drift.conflicts.length) lines.push(n ? `sync: ${n} change(s) not in Studio yet (${[...drift.pending, ...drift.builders.map((b) => `world:${b}`), ...drift.deletes.map((d) => `-${d}`)].slice(0, 12).join(', ')}) — run sync or run_tests` : 'sync: Studio matches files');
          if (drift.skipped.length) lines.push(`sync skipped: ${drift.skipped.map((s) => s.file).join(', ')}`);
          if (drift.conflicts.length) lines.push(`sync CONFLICT (edited in Studio and in files): ${drift.conflicts.join(', ')} — merge, then sync {force:true}`);
          if (drift.studioEdits.length) lines.push(`edited in Studio only (files lack these edits; the next change to those files will CONFLICT): ${drift.studioEdits.join(', ')}`);
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
      lines.push('', formatTask(loadTask(ctx.projectPath), withSyntheticResults(ctx.projectPath, lt)));
      return { text: lines.join('\n'), summary: 'status' };
    },
  },
  {
    name: 'sync',
    description:
      'Push files into Studio (scripts + world/ builders), incremental. Edit mode only; run_tests/playtest already sync.',
    shape: { force: z.boolean().optional().describe('re-push all scripts and rebuild every world builder; also overwrites scripts edited in Studio since the last sync (otherwise refused as CONFLICT)') },
    async handler(a, ctx) {
      const r = await pushProject(ctx.session, ctx.projectPath, { force: a.force === true, worldDir: ctx.config.worldDir });
      writeJson(ctx.projectPath, 'last-sync.json', { ...r, at: new Date().toISOString() });
      return { text: formatSyncResult(r), isError: !r.ok, summary: `+${r.created.length} ~${r.updated.length} -${r.deleted.length}${r.ok ? '' : ' FAILED'}` };
    },
  },
  {
    name: 'run_tests',
    description:
      'Sync, then run tests/*.spec.luau in Studio (server/client specs in one playtest, handled for you: through the eval bridge when bridge.eval is on, else injected host scripts). Returns failures with file:line, playtest runtime errors, criteria status.',
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
      const crit = task ? `\n${formatTask(task, withSyntheticResults(ctx.projectPath, r), { compact: true })}` : '';
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
        .array(z.object({ kind: z.enum(['click', 'luau', 'navigate', 'keyboard', 'mouse', 'wait']), args: z.record(z.string(), z.unknown()) }))
        .optional()
        .describe('run in order: click {target:"PlayerGui.HUD.Button"} (real click on a GUI button); luau {context:"server"|"client", code} (arrange/check state between inputs, e.g. give coins); navigate {x,y,z}|{instance_path}; keyboard {actions:[{action:"keyPress",key_code:"E"}]} (also keyDown/keyUp/textInput+text_inputs); mouse {actions:[…]} (raw: moveTo/mouseButtonClick/scroll, x,y|instance_path); wait {seconds}'),
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
      for (const i of (a.inputs as InputStep[] | undefined) ?? []) {
        if (i.kind === 'luau' && typeof i.args.code === 'string' && EXTERNAL_HTTP.test(i.args.code)) return { text: 'blocked: probes may not make external HTTP requests', isError: true, summary: 'blocked' };
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
      'Run Luau in Studio; returns serialized return values, printed logs, errors with line numbers. context edit (default) or server/client (needs a running playtest; require() of game modules there works only with blox.config.json bridge.eval). For probes; lasting checks go in tests/.',
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
      const args = { ...((a.args as Record<string, unknown>) ?? {}) };
      // Studio wants Edit/Server/Client exactly; "client" is the usual guess.
      if (typeof args.datamodel_type === 'string') {
        const dm = ({ edit: 'Edit', server: 'Server', client: 'Client' } as Record<string, string>)[args.datamodel_type.toLowerCase()];
        if (dm) args.datamodel_type = dm;
      }
      const r = await ctx.session.call(name, args, 600_000);
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
      const lt = withSyntheticResults(ctx.projectPath, readJson<{ ranAt: string; tests: { file: string; name: string; status: string }[] }>(ctx.projectPath, 'last-tests.json'));
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
    name: 'design',
    description:
      'Game design doc (.blox/design.json) + offline economy simulator. get | example (a small valid doc to copy shapes from) | set {doc} (validated; invalid docs are not written) | validate | simulate {archetypes?, horizon? s, runs?, seed?} (player archetypes over time → pass/fail assertions + milestones; failing assertions = isError) | codegen (writes src/ReplicatedStorage/Design/Tunables.luau; game code reads numbers from it). Criteria bind to assertions via tests:["design:<id>"]. No Studio needed.',
    shape: {
      action: z.enum(['get', 'example', 'set', 'validate', 'simulate', 'codegen']),
      doc: z.unknown().optional(),
      archetypes: z.array(z.string()).optional(),
      horizon: z.number().int().positive().optional(),
      runs: z.number().int().positive().max(1000).optional(),
      seed: z.number().int().optional(),
    },
    async handler(a, ctx) {
      if (a.action === 'example') return { text: `${EXAMPLE_TEXT}\nTimeTo targets are gate:/upgrade:/generator:/action: refs; balanceAt needs res + at (wall clock). Kits ship full examples (kit {action:"list"}).`, summary: 'example' };
      if (a.action === 'set') {
        const v = validateDesign(a.doc);
        if (!v.ok) return { text: `design not saved — ${v.errors.length} error(s):\n${formatErrors(v.errors)}\nA valid doc to copy shapes from:\n${EXAMPLE_TEXT}`, isError: true, summary: 'invalid' };
        writeJson(ctx.projectPath, 'design.json', v.doc);
        return { text: `saved .blox/design.json (${v.doc.meta.title}, ${v.doc.assertions.length} assertion(s)). Next: design {action:"simulate"}.`, summary: 'saved' };
      }
      const raw = readJson<unknown>(ctx.projectPath, 'design.json');
      if (raw === null) return { text: 'no .blox/design.json — create one with design {action:"set", doc:{...}} (design {action:"example"} shows a valid doc)', isError: true, summary: 'no design' };
      if (a.action === 'get') return { text: JSON.stringify(raw, null, 2), summary: 'get' };
      const v = validateDesign(raw);
      if (!v.ok) return { text: `design.json is invalid — ${v.errors.length} error(s):\n${formatErrors(v.errors)}`, isError: true, summary: 'invalid' };
      if (a.action === 'validate') return { text: `design.json is valid (${v.doc.assertions.length} assertion(s))`, summary: 'valid' };
      if (a.action === 'codegen') {
        const file = join(ctx.projectPath, TUNABLES_PATH);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, renderTunables(v.doc));
        return { text: `wrote ${TUNABLES_PATH} — require it for every tuned number; sync/run_tests push it to Studio.`, artifacts: [TUNABLES_PATH], summary: 'codegen' };
      }
      const report = runSimulation(v.doc, {
        archetypes: a.archetypes as string[] | undefined,
        horizonSec: a.horizon as number | undefined,
        runs: a.runs as number | undefined,
        seed: a.seed as number | undefined,
      });
      writeJson(ctx.projectPath, 'sim-report.json', report);
      refreshCriteria(ctx.projectPath);
      const failed = report.assertions.filter((x) => !x.ok).length;
      return { text: formatReport(report), isError: failed > 0, summary: `${report.assertions.length - failed}/${report.assertions.length} assertions` };
    },
  },
  {
    name: 'kit',
    description:
      'Format kits: proven game loops as tested Luau modules + world builder + specs + design.json. list | apply {name} (non-destructive: existing files and an existing .blox/design.json are kept; Tunables regenerated). After apply: design simulate, run_tests, then reskin/tune.',
    shape: { action: z.enum(['list', 'apply']), name: z.string().optional() },
    async handler(a, ctx) {
      if (a.action === 'list') {
        const kits = listKits();
        return { text: kits.map((k) => `${k.name} — ${k.title}\n  ${k.description}`).join('\n') || '(no kits installed)', summary: `${kits.length} kits` };
      }
      if (typeof a.name !== 'string') return { text: 'kit apply needs name (see kit {action:"list"})', isError: true, summary: 'no name' };
      const r = applyKit(ctx.projectPath, a.name);
      return { text: formatApply(r), isError: r.tunables !== null, artifacts: r.created, summary: `${r.created.length} created` };
    },
  },
  {
    name: 'skill',
    description:
      'Roblox know-how on demand (29 skills: Luau, architecture, networking, security, data, performance, GUI, physics, NPCs, camera, building, game design, monetization, Open Cloud, publishing…). No args: list. {name}: the skill\'s guidance. {name, section}: a section of its deep reference ("toc" lists sections). Load the relevant skill before domain work.',
    shape: {
      name: z.string().optional().describe('skill name, e.g. roblox-security'),
      section: z.string().optional().describe('reference section heading (substring) or "toc"'),
    },
    async handler(a) {
      if (typeof a.name !== 'string' || !a.name) return { text: formatSkillList(listSkills()), summary: 'list' };
      const r = loadSkill(a.name, typeof a.section === 'string' ? a.section : undefined);
      return { text: r.text, isError: !r.ok, summary: r.ok ? String(a.name) : 'not found' };
    },
  },
  {
    name: 'check',
    description:
      'Static checks on the project\'s Luau, no Studio needed: StyLua formatting (when the project has .stylua.toml), Rojo sourcemap, luau-lsp type + lint analysis of src/ (vendored Packages/Replica skipped) and a Rojo build. Run after every code change, before sync. fix:true formats with StyLua instead of only checking. Missing tools are reported as skipped. Type/syntax errors or a failed build = isError.',
    shape: { fix: z.boolean().optional() },
    async handler(a, ctx) {
      const r = await runCheck(ctx.projectPath, { fix: a.fix === true });
      const failed = r.steps.filter((s) => s.status === 'fail').map((s) => s.name);
      return { text: formatCheck(r), isError: !r.ok, summary: r.ok ? 'pass' : `fail: ${failed.join(', ')}` };
    },
  },
  {
    name: 'metrics',
    description:
      'Game-feel metrics from a real playtest (needs BloxTelemetry; kits include it). ftue {seconds?=60, bot?} → each design.json ftue step reached within targetSec + first currency <= 60s | soak {seconds?=300, bot?, archetype?, tolerance?} → no runtime errors, memory growth <= 10 MB/min, and (with archetype) purchase milestones on the simulator\'s pace | install (adds src/ReplicatedStorage/BloxTelemetry.luau). bot: "walk" (default) | "idle" | project file returning function(player, deadline) run on the server. Criteria bind via tests:["ftue:<id>"|"soak:<check>"]. Failing checks = isError.',
    shape: {
      action: z.enum(['ftue', 'soak', 'install']),
      sync: z.boolean().optional().describe('default true: push files to Studio first'),
      seconds: z.number().int().min(0).max(900).optional(),
      bot: z.string().optional(),
      archetype: z.string().optional(),
      tolerance: z.number().min(1).optional(),
    },
    async handler(a, ctx) {
      if (a.action === 'install') {
        const rel = 'src/ReplicatedStorage/BloxTelemetry.luau';
        const dest = join(ctx.projectPath, rel);
        if (existsSync(dest)) return { text: `${rel} already exists`, summary: 'exists' };
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(join(KITS_ROOT, '_common/files', rel), 'utf8'));
        return {
          text: `wrote ${rel}. In a server script: local Telemetry = require(game.ReplicatedStorage.BloxTelemetry); Telemetry.start(); then Telemetry.step(player, "<ftue id>") where each design.json ftue step happens, Telemetry.event(player, "<ref>") for purchases.`,
          artifacts: [rel],
          summary: 'installed',
        };
      }
      // Measure the code on disk, not whatever Studio last saw (a stale
      // Tunables made a live FTUE run measure old numbers).
      const st = await ctx.session.state();
      if (a.sync !== false && st.mode === 'Edit') {
        const s = await pushProject(ctx.session, ctx.projectPath, { worldDir: ctx.config.worldDir });
        if (!s.ok) return { text: formatSyncResult(s), isError: true, summary: 'sync failed' };
      }
      const raw = readJson<unknown>(ctx.projectPath, 'design.json');
      const v = raw === null ? null : validateDesign(raw);
      const doc = v?.ok ? v.doc : null;
      const report = await runMetrics(ctx.session, ctx.projectPath, doc, {
        mode: a.action as 'ftue' | 'soak',
        seconds: (a.seconds as number | undefined) ?? (a.action === 'ftue' ? 60 : 300),
        bot: (a.bot as string | undefined) ?? 'walk',
        archetype: a.archetype as string | undefined,
        tolerance: a.tolerance as number | undefined,
      });
      if (v && !v.ok) report.notes.push('design.json is invalid — FTUE targets and pace checks skipped');
      // One file holds both modes: keep the other mode's latest results.
      const prev = readJson<{ results?: { id: string }[] }>(ctx.projectPath, 'metrics-report.json');
      const kept = (prev?.results ?? []).filter((r) => !r.id.startsWith(`${a.action}:`));
      writeJson(ctx.projectPath, 'metrics-report.json', { ...report, results: [...kept, ...report.results] });
      refreshCriteria(ctx.projectPath);
      const failed = report.results.filter((x) => !x.ok).length;
      return { text: formatMetrics(report), isError: failed > 0, summary: `${report.results.length - failed}/${report.results.length} ${a.action}` };
    },
  },
  {
    name: 'ui',
    description:
      'Sync, then deterministic UI lint across a device matrix (phone-landscape 844x390, phone-portrait 390x844, tablet 1024x768, desktop 1920x1080), no vision: lint {seconds?=3, prepare? (client Luau to open menus first), devices?} → offscreen, safe-area (top bar/notch), touch-target (>=44px mobile), overlap, text-overflow, text-tiny | install (BloxUI component kit: screen, Button, CurrencyBar, Rail, Modal, Toast, Reveal — mobile-first). Criteria bind via tests:["ui:<rule>"]. Errors = isError.',
    shape: {
      action: z.enum(['lint', 'install']),
      seconds: z.number().min(0).max(120).optional(),
      prepare: z.string().optional(),
      devices: z.array(z.string()).optional(),
      sync: z.boolean().optional().describe('lint: push files first (default true; skipped while a playtest is already running)'),
    },
    async handler(a, ctx) {
      if (a.action === 'install') {
        const src = join(KITS_ROOT, '_common/files/src/ReplicatedStorage/BloxUI');
        const created: string[] = [];
        for (const f of readdirSync(src)) {
          const rel = `src/ReplicatedStorage/BloxUI/${f}`;
          const dest = join(ctx.projectPath, rel);
          if (existsSync(dest)) continue;
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, readFileSync(join(src, f), 'utf8'));
          created.push(rel);
        }
        return {
          text: `${created.length ? `wrote ${created.join(', ')}` : 'BloxUI already installed'}. Client: local UI = require(game.ReplicatedStorage.BloxUI); local gui = UI.screen("HUD"); UI.CurrencyBar(gui, {"coins"}); UI.Rail(gui, {{id="Shop", text="Shop"}}) … then ui {action:"lint"}.`,
          artifacts: created,
          summary: `${created.length} files`,
        };
      }
      // Lint what the files say, not what Studio held at the last sync.
      let pre = '';
      if (a.sync !== false) {
        const st = await ctx.session.state();
        if (st.mode === 'Edit') {
          const s = await pushProject(ctx.session, ctx.projectPath, { worldDir: ctx.config.worldDir });
          writeJson(ctx.projectPath, 'last-sync.json', { ...s, at: new Date().toISOString() });
          if (!s.ok) return { text: formatSyncResult(s), isError: true, summary: 'sync failed' };
          pre = formatSyncResult(s).split('\n')[0] + '\n';
        } else {
          pre = 'not synced: a playtest is running — linting the running game as it is\n';
        }
      }
      const report = await runUiLint(ctx.session, {
        seconds: (a.seconds as number | undefined) ?? 3,
        prepare: a.prepare as string | undefined,
        devices: a.devices as string[] | undefined,
      });
      writeJson(ctx.projectPath, 'ui-report.json', report);
      refreshCriteria(ctx.projectPath);
      const failed = report.results.filter((x) => !x.ok).length;
      return { text: pre + formatUiReport(report), isError: failed > 0, summary: `${report.results.length - failed}/${report.results.length} rules` };
    },
  },
  {
    name: 'present',
    description:
      'Store-page presentation (.blox/presentation.json): get | set {doc} | generate (title candidates, description and 5 thumbnail + 1 icon shots from design.json; keeps what exists) | render {ids?} (stage a posed avatar/hero/overlay in the edit DataModel and screen_capture each shot; size the Studio viewport 16:9 first) | lint (policy: 9+, no "Roblox" in title, no links/scams, <=50/1000 chars; shots: 5 distinct themes, rendered from the real game, 16:9, no duplicates, icon readable at 64px). Choosing the final title/art and uploading are human decisions. Criteria bind via tests:["present:<rule>"].',
    shape: {
      action: z.enum(['get', 'set', 'generate', 'render', 'lint']),
      doc: z.unknown().optional(),
      ids: z.array(z.string()).optional(),
    },
    async handler(a, ctx) {
      const load = (): Presentation | string => {
        const raw = readJson<unknown>(ctx.projectPath, 'presentation.json');
        if (raw === null) return 'no .blox/presentation.json — present {action:"generate"} drafts one from design.json';
        const v = validatePresentation(raw);
        return v.ok ? v.doc : `presentation.json is invalid:\n${v.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`;
      };
      if (a.action === 'set') {
        const v = validatePresentation(a.doc);
        if (!v.ok) return { text: `presentation not saved — ${v.errors.length} error(s):\n${v.errors.map((e) => `  ${e.path || '(root)'}: ${e.message}`).join('\n')}`, isError: true, summary: 'invalid' };
        writeJson(ctx.projectPath, 'presentation.json', v.doc);
        return { text: `saved .blox/presentation.json (${v.doc.shots.length} shots). Next: present {action:"render"} then {action:"lint"}.`, summary: 'saved' };
      }
      if (a.action === 'generate') {
        const dv = validateDesign(readJson<unknown>(ctx.projectPath, 'design.json'));
        if (!dv.ok) return { text: 'generate needs a valid .blox/design.json (design {action:"set"})', isError: true, summary: 'no design' };
        const cur = load();
        const doc: Presentation = typeof cur === 'string' ? { version: 1, title: '', description: '', shots: [] } : cur;
        const titles = titleCandidates(dv.doc);
        if (!doc.title) doc.title = titles[0] ?? dv.doc.meta.title;
        if (!doc.description) doc.description = describeGame(dv.doc);
        if (!doc.shots.length) doc.shots = defaultShots(dv.doc);
        writeJson(ctx.projectPath, 'presentation.json', doc);
        return {
          text: [
            `title candidates:`,
            ...titles.map((t, i) => `  ${i + 1}. ${t}`),
            `title: ${doc.title}`,
            `description:\n${doc.description}`,
            `shots: ${doc.shots.map((s) => `${s.id} (${s.kind}, ${s.theme})`).join(', ')}`,
            'Adjust cameras/subjects to the real map, then present {action:"render"}. A human picks the final title and art.',
          ].join('\n'),
          summary: 'generated',
        };
      }
      const doc = load();
      if (typeof doc === 'string') return { text: doc, isError: true, summary: 'no presentation' };
      if (a.action === 'get') return { text: JSON.stringify(doc, null, 2), summary: 'get' };
      if (a.action === 'render') {
        const r = await renderShots(ctx.session, ctx.projectPath, doc, a.ids as string[] | undefined);
        writeJson(ctx.projectPath, 'presentation.json', doc);
        const total = r.rendered.length + r.failed.length;
        const lines = [`rendered ${r.rendered.length}/${total}`, ...r.rendered.map((x) => `  ${x.id} → ${x.file} (${x.avatar} avatar)`), ...r.failed.map((x) => `  FAILED ${x.id}: ${x.error}`)];
        return { text: lines.join('\n'), isError: r.failed.length > 0, artifacts: r.rendered.map((x) => x.file), summary: `${r.rendered.length}/${total} rendered` };
      }
      const findings = lintPresentation(doc, ctx.projectPath);
      const results = presentResults(findings);
      writeJson(ctx.projectPath, 'present-report.json', { ranAt: new Date().toISOString(), findings, results });
      refreshCriteria(ctx.projectPath);
      const failed = results.filter((x) => !x.ok).length;
      return { text: formatPresentLint(findings, results), isError: failed > 0, summary: `${results.length - failed}/${results.length} rules` };
    },
  },
  {
    name: 'multiplayer',
    description:
      'Multiplayer test lane: runs tests/**/*.mp.luau (first line "-- @context multiplayer", optional "-- @clients N") in a real Studio server with N clients (<= 8) via StudioTestService through the blox dock plugin (keep Studio open with the plugin installed). Specs get mp.players and mp.client(player, op, ...) with ops invoke/fire <remote path> args | get <path> <prop> | attr <name> | moveTo x y z, driving real clients. Syncs first. Criteria bind to spec files like run_tests.',
    shape: {
      clients: z.number().int().min(1).max(8).optional(),
      filter: z.string().optional(),
      timeout: z.number().int().positive().max(900).optional().describe('seconds for the whole job, default 180'),
    },
    async handler(a, ctx) {
      const s = await pushProject(ctx.session, ctx.projectPath, { worldDir: ctx.config.worldDir });
      writeJson(ctx.projectPath, 'last-sync.json', { ...s, at: new Date().toISOString() });
      const r = await runMultiplayer(ctx.session, ctx.projectPath, {
        clients: a.clients as number | undefined,
        filter: a.filter as string | undefined,
        timeoutSec: a.timeout as number | undefined,
      });
      writeJson(ctx.projectPath, 'mp-report.json', r);
      refreshCriteria(ctx.projectPath);
      const failed = r.results.filter((t) => t.status !== 'pass').length;
      const bad = failed > 0 || !!r.error || r.fileErrors.length > 0;
      return { text: (s.errors.length ? `sync errors: ${s.errors.join('; ')}\n` : '') + formatMp(r), isError: bad, summary: `${r.results.length - failed}/${r.results.length} mp` };
    },
  },
  {
    name: 'asset',
    description:
      'Asset manifest (.blox/assets.json: licence, provenance, sanitize record, budget, human approval) and pipeline. list | add {entry} (status starts as candidate) | sanitize {path, id?, asset_id?, keep_scripts?} (inspect an inserted Creator Store model for backdoors — remote require, getfenv, loadstring, HttpService, obfuscation — and remove its scripts) | scan (asset ids referenced in the place vs the manifest) | lint (asset:<rule>) | normalize {file, out?, tris?=10000, height?, id?} (headless Blender: decimate, scale, pivot, FBX) | upload {id, confirm?} (Open Cloud; only for human-approved entries — approval is `blox asset approve <id>`, a human CLI step — with confirm and ROBLOX_OPEN_CLOUD_KEY; without confirm it is a dry run; an image upload also resolves the Image id inside the Decal and records it as ref.assetId) | resolve {id | asset_id} (decal → image id, when that step failed or for any decal) | relink {id, path} (point an entry at the instance now at path; blox tags placed assets and follows renames itself, so this is only for entries scan reports as not found).',
    shape: {
      action: z.enum(['list', 'add', 'sanitize', 'scan', 'lint', 'normalize', 'upload', 'resolve', 'relink']),
      entry: z.unknown().optional(),
      path: z.string().optional(),
      id: z.string().optional(),
      asset_id: z.number().int().positive().optional(),
      keep_scripts: z.boolean().optional(),
      file: z.string().optional(),
      out: z.string().optional(),
      tris: z.number().int().positive().optional(),
      height: z.number().nonnegative().optional(),
      confirm: z.boolean().optional(),
    },
    async handler(a, ctx) {
      const P = ctx.projectPath;
      if (a.action === 'list') {
        const m = loadManifest(P);
        const rows = m.assets.map((x) => `${x.id}  ${x.kind}  ${x.source}  ${x.licence}  ${x.status}${x.sanitized ? '  sanitized' : ''}${x.budget?.tris ? `  ${x.budget.tris} tris` : ''}${x.uploaded ? `  uploaded ${x.uploaded.assetId}` : ''}`);
        return { text: rows.join('\n') || '(no assets recorded)', summary: `${m.assets.length} assets` };
      }
      if (a.action === 'add') {
        const r = addAsset(P, a.entry);
        return r.ok ? { text: `added ${r.entry.id} (candidate — a human approves it with \`blox asset approve ${r.entry.id}\`)`, summary: 'added' } : { text: `not added:\n  ${r.errors.join('\n  ')}`, isError: true, summary: 'invalid' };
      }
      if (a.action === 'sanitize') {
        if (typeof a.path !== 'string') return { text: 'sanitize needs path (e.g. "Workspace.FreeTree")', isError: true, summary: 'no path' };
        let g;
        try {
          g = await runSanitize(ctx.session, a.path, a.keep_scripts === true);
        } catch (e) {
          return { text: `sanitize failed: ${(e as Error).message}`, isError: true, summary: 'failed' };
        }
        const findings = g.scripts.flatMap((s) => s.findings.map((f) => `${s.path}: ${f}`));
        const id = typeof a.id === 'string' ? a.id : null;
        if (id) {
          const m = loadManifest(P);
          let e = m.assets.find((x) => x.id === id);
          if (!e) {
            const added = addAsset(P, { id, kind: 'model', source: 'creator-store', licence: 'roblox-creator-store', ref: { path: a.path, ...(a.asset_id ? { assetId: a.asset_id } : {}) }, provenance: { tool: 'insert_asset', createdAt: new Date().toISOString() } });
            if (!added.ok) return { text: `could not record ${id}: ${added.errors.join('; ')}`, isError: true, summary: 'invalid' };
          }
          const m2 = loadManifest(P);
          e = m2.assets.find((x) => x.id === id)!;
          e.sanitized = { at: new Date().toISOString(), scriptsRemoved: g.removed, findings };
          e.budget = { ...(e.budget ?? {}), parts: g.parts };
          saveManifest(P, m2);
        }
        const lines = [
          `${g.path}: ${g.scripts.length} script(s), ${g.parts} parts (${g.meshParts} MeshParts), ${g.textures} texture(s); removed ${g.removed} script(s)`,
          ...g.scripts.map((s) => `  ${s.findings.length ? 'RISK' : 'ok  '} ${s.path} (${s.class})${s.findings.length ? ': ' + s.findings.join(', ') : ''}`),
          id ? `recorded on asset "${id}"` : 'pass id to record this in .blox/assets.json',
        ];
        return { text: lines.join('\n'), summary: `${findings.length} risks` };
      }
      if (a.action === 'relink') {
        if (typeof a.id !== 'string' || typeof a.path !== 'string') return { text: 'relink needs id and path', isError: true, summary: 'missing args' };
        try {
          const notes = await relinkAsset(ctx.session, P, a.id, a.path);
          const e = loadManifest(P).assets.find((x) => x.id === a.id)!;
          return { text: [`${a.id} → ${e.ref.path} (tag ${e.ref.tag})`, ...notes.map((n) => `  ${n}`)].join('\n'), summary: 'relinked' };
        } catch (e) {
          return { text: (e as Error).message, isError: true, summary: 'failed' };
        }
      }
      if (a.action === 'scan') {
        const moved = await refreshRefs(ctx.session, P);
        const m = loadManifest(P);
        const r = await runLuau(ctx.session, scanProgram(trackedPaths(m)), 'edit', { chunkName: 'assetScan', timeoutMs: 60_000 });
        if (!r.ok) return { text: `scan failed: ${r.error?.message}`, isError: true, summary: 'failed' };
        const untracked = untrackedFromScan(r.values[0], m);
        // covered: ids inside tracked models, so code that names one (release code-ids) is not flagged
        writeJson(P, 'asset-scan.json', { at: new Date().toISOString(), untracked, covered: coveredFromScan(r.values[0], m) });
        return { text: [...(moved.length ? ['asset paths updated:', ...moved.map((x) => `  ${x}`)] : []), `${untracked.length} untracked asset id(s)`, ...untracked.slice(0, 30).map((u) => `  ${u.id}  ${u.where}`)].join('\n'), summary: `${untracked.length} untracked` };
      }
      if (a.action === 'lint') {
        const scan = readJson<{ untracked: { id: string; where: string }[] }>(P, 'asset-scan.json') ?? undefined;
        const findings = lintAssets(loadManifest(P), scan);
        const results = assetResults(findings);
        writeJson(P, 'asset-report.json', { ranAt: new Date().toISOString(), findings, results });
        refreshCriteria(P);
        const failed = results.filter((x) => !x.ok).length;
        return { text: formatAssetLint(findings, results), isError: failed > 0, summary: `${results.length - failed}/${results.length} rules` };
      }
      if (a.action === 'normalize') {
        if (typeof a.file !== 'string') return { text: 'normalize needs file', isError: true, summary: 'no file' };
        const out = typeof a.out === 'string' ? a.out : a.file.replace(/\.[^.\/]+$/, '') + '.normalized.glb';
        const bad = [a.file, out].find((f) => !isPathContained(P, f));
        if (bad) return { text: `${bad} is outside the project`, isError: true, summary: 'outside project' };
        const r = await runNormalize({ input: join(P, a.file), out: join(P, out), tris: (a.tris as number | undefined) ?? 10_000, height: (a.height as number | undefined) ?? 0 });
        let note = '';
        if (typeof a.id === 'string') {
          const m = loadManifest(P);
          const e = m.assets.find((x) => x.id === a.id);
          if (e) {
            e.budget = { ...(e.budget ?? {}), tris: r.trisAfter };
            e.ref.file = out;
            saveManifest(P, m);
            note = `\nrecorded on asset "${a.id}"`;
          } else {
            note = `\nnot recorded: no asset "${a.id}" in .blox/assets.json — add it first (asset {action:"add", entry}) and rerun`;
          }
        }
        return { text: `normalized → ${out}: ${r.trisBefore} → ${r.trisAfter} triangles, size ${r.size.join(' × ')} studs${note}`, artifacts: [out], summary: `${r.trisAfter} tris` };
      }
      if (a.action === 'resolve') {
        const e = typeof a.id === 'string' ? loadManifest(P).assets.find((x) => x.id === a.id) : undefined;
        const decal = e?.uploaded?.assetId ?? (a.asset_id as number | undefined);
        if (!decal) return { text: 'resolve needs id of an uploaded image (or asset_id of a decal)', isError: true, summary: 'no decal' };
        const imageId = await resolveDecalImage(ctx.session, decal);
        if (e?.uploaded) recordImageId(P, e.id, imageId);
        return { text: `decal ${decal} → image ${imageId}${e?.uploaded ? ` (recorded on "${e.id}" as ref.assetId)` : ''}. Use rbxassetid://${imageId}.`, summary: `image ${imageId}` };
      }
      if (typeof a.id !== 'string') return { text: 'upload needs id', isError: true, summary: 'no id' };
      const r = await uploadAsset(P, a.id, { confirm: a.confirm === true });
      // Live 2026-10-02: an FBX through Open Cloud arrived 100× too big (cm units) with
      // its colours gone; GLB keeps 1 unit = 1 stud and vertex colours.
      const fbxWarn = r.dryRun && /\.fbx$/i.test(r.plan.file)
        ? `\nWARNING: FBX uploads arrive 100× too big and lose flat colours. Prefer a GLB: model {action:"export"} writes model.glb; asset {action:"normalize", file} writes .normalized.glb.`
        : '';
      if (r.dryRun) return { text: `DRY RUN — would upload:\n${JSON.stringify(r.plan, null, 2)}${fbxWarn}\nRe-run with confirm:true only if the human asked for this upload.`, summary: 'dry run' };
      const meshNote = /\.(glb|gltf|fbx)$/i.test(loadManifest(P).assets.find((x) => x.id === a.id)?.ref.file ?? '')
        ? `\nInsert: studio_tool {name:"insert_asset", args:{assetId:"${r.assetId}", assetName:"${a.id}"}}, then set every MeshPart's Color to Color3.new(1, 1, 1): Studio multiplies vertex colours by it (default grey makes the model ~35% darker).`
        : '';
      if (r.assetType === 'Decal') {
        // ImageLabel.Image can't show a Decal id: resolve the Image inside it.
        try {
          const imageId = await resolveDecalImage(ctx.session, r.assetId);
          recordImageId(P, a.id, imageId);
          return { text: `uploaded ${a.id} → decal ${r.assetId}, image ${imageId} (${r.operation}). Use rbxassetid://${imageId} in ImageLabel.Image / Decal.Texture (recorded as ref.assetId).`, summary: `image ${imageId}` };
        } catch (e) {
          return { text: `uploaded ${a.id} → decal ${r.assetId} (${r.operation}), but its image id is not resolved yet: ${(e as Error).message}\nThe decal id does NOT display in an ImageLabel. Retry: asset {action:"resolve", id:"${a.id}"} (Studio open; moderation can take a minute).`, isError: true, summary: 'image id unresolved' };
        }
      }
      return { text: `uploaded ${a.id} → asset ${r.assetId} (${r.operation})${meshNote}`, summary: 'uploaded' };
    },
  },
  {
    name: 'scout',
    description: SCOUT_DESCRIPTION,
    shape: scoutShape,
    handler: scoutTool,
  },
  {
    name: 'model',
    description:
      'AI-built 3D models in Blender (headless), Roblox-ready and rig-ready. brief {id, prompt, style?, tris?=5000, rig?, animations?, refs?} (records the spec + returns the build loop) | run {id, code} (Blender Python with blox helpers: reset, voxels, box, join, rig, bind_rigid, animate; rebuilds .blox/models/<id>/model.blend) | check {id, images?} (budget: triangles vs target, MeshParts the upload makes, bones, textures; colour survival — procedural or missing-image colours arrive white; front/right/back/three-quarter renders + the brief reference images, returned as images to compare) | export {id} (model.glb = the upload: vertex colours, 1 unit = 1 stud, front -Z; after inserting set each MeshPart Color to white (it multiplies vertex colours); model.fbx for the Studio importer; anim_<name>.fbx per animation; preview.json) | preview {id, at?} (coloured MeshPart in Studio via EditableMesh, no upload) | import {id} (records the GLB in .blox/assets.json as a candidate; a human approves before upload) | animate {id, target, name?} (after the uploaded model is inserted at target, e.g. "Workspace.Dog": turns each exported Blender action into a Roblox KeyframeSequence on its Bones, checks the motion, plays it on the rig in edit mode and compares bone positions, writes anim_<name>.rbxm and records it as an animation candidate for upload) | list.',
    shape: {
      action: z.enum(['brief', 'run', 'check', 'export', 'preview', 'import', 'animate', 'list']),
      id: z.string().optional(),
      images: z.boolean().optional().describe('check: attach the views and reference images (default true)'),
      with_refs: z.boolean().optional().describe('check: resend the brief\'s reference images (default: first check only)'),
      prompt: z.string().optional(),
      style: z.string().optional(),
      tris: z.number().int().positive().optional(),
      rig: z.boolean().optional(),
      animations: z.array(z.string()).optional(),
      refs: z.array(z.string()).optional(),
      code: z.string().optional().describe('run: the whole build script (Blender Python, blox helpers in scope)'),
      at: z.array(z.number()).length(3).optional().describe('preview: where to stand it, default 0,0,20'),
      target: z.string().optional().describe('animate: path of the inserted rig in Studio, e.g. Workspace.Dog'),
      name: z.string().optional().describe('animate: one action (default: every exported action)'),
    },
    async handler(a, ctx) {
      const P = ctx.projectPath;
      if (a.action === 'list') {
        const root = join(P, '.blox', 'models');
        const ids = existsSync(root) ? readdirSync(root).filter((d) => existsSync(join(root, d, 'brief.json'))) : [];
        return { text: ids.map((id) => `${id}  ${readBrief(P, id)?.prompt ?? ''}`).join('\n') || '(no models)', summary: `${ids.length} models` };
      }
      if (typeof a.id !== 'string') return { text: `${a.action} needs id`, isError: true, summary: 'no id' };
      const id = a.id;
      const dir = modelDir(P, id);
      const brief = readBrief(P, id);
      if (a.action === 'brief') {
        if (typeof a.prompt !== 'string') return { text: 'brief needs prompt', isError: true, summary: 'no prompt' };
        // Refs are stored project-relative (check reads them from the project):
        // a project file as is, anything else copied into the model's refs/.
        const given = (a.refs as string[] | undefined) ?? [];
        const missing = given.filter((r) => !existsSync(join(P, r)) && !existsSync(r));
        if (missing.length) return { text: `reference image(s) not found: ${missing.join(', ')}`, isError: true, summary: 'missing refs' };
        const refs = given.map((r) => {
          if (existsSync(join(P, r)) && isPathContained(P, resolve(P, r))) return relative(P, resolve(P, r));
          const abs = resolve(r);
          if (isPathContained(P, abs)) return relative(P, abs);
          mkdirSync(join(dir, 'refs'), { recursive: true });
          const copy = join(dir, 'refs', basename(abs));
          copyFileSync(abs, copy);
          return relative(P, copy);
        });
        const b = writeBrief(P, { id, prompt: a.prompt, ...(typeof a.style === 'string' ? { style: a.style } : {}), tris: (a.tris as number | undefined) ?? 5000, rig: a.rig === true, animations: (a.animations as string[] | undefined) ?? [], refs });
        return { text: briefText(b), summary: 'brief' };
      }
      const budget = brief?.tris ?? 0;
      const blend = join(dir, 'model.blend');
      if (a.action === 'run') {
        if (typeof a.code !== 'string' || !a.code.trim()) return { text: 'run needs code (the whole build script)', isError: true, summary: 'no code' };
        mkdirSync(join(dir, 'code'), { recursive: true });
        const code = join(dir, 'code', 'build.py');
        writeFileSync(code, a.code);
        // A fresh .blend each run: the script is the source of truth.
        rmSync(blend, { force: true });
        const s = (await runModelPy('run', { blend, code, budget, name: `${id}/build.py` }, dir)) as unknown as ModelStats;
        return { text: `built ${id}\n${formatStats(s, P, budget)}\nnext: model {action:"check", id:"${id}"} and look at the views`, isError: s.issues.length > 0, summary: `${s.triangles} tris` };
      }
      if (!existsSync(blend)) return { text: `no model "${id}" yet — model {action:"run", id:"${id}", code} first`, isError: true, summary: 'no model' };
      if (a.action === 'check') {
        const s = (await runModelPy('check', { blend, views: join(dir, 'views'), budget }, dir)) as unknown as ModelStats;
        // References go with the first check only (or when asked): resending
        // them every loop costs image tokens without new information.
        const firstCheck = !existsSync(join(dir, 'check.json'));
        writeFileSync(join(dir, 'check.json'), JSON.stringify(s, null, 2));
        const sendRefs = a.with_refs === true || (a.with_refs !== false && firstCheck);
        const att = a.images === false ? null : checkImages(s.views ?? [], sendRefs ? brief?.refs ?? [] : [], P);
        const refNote = !sendRefs && brief?.refs.length ? [`references not resent (${brief.refs.length}; sent on the first check): pass with_refs:true to see them again`] : [];
        const text = [formatStats(s, P, budget), ...(att?.labels.length ? [`images: ${att.labels.join(', ')}`] : []), ...(att?.notes ?? []), ...refNote].join('\n');
        return { text, ...(att?.images.length ? { images: att.images } : {}), isError: s.issues.length > 0, summary: s.issues.length ? `${s.issues.length} issues` : 'ok' };
      }
      if (a.action === 'export') {
        const r = (await runModelPy('export', { blend, out: join(dir, 'export') }, dir)) as { model: string; upload?: string; pivots?: string; pieces?: number; bake?: { materials: number; baked: number; textured: number }; animations: Record<string, string>; preview: string; previewTriangles: number };
        const rel = (f: string) => f.slice(P.length + 1);
        const anims = Object.entries(r.animations);
        return {
          text: [
            ...(r.upload ? [`upload file ${rel(r.upload)}: ${r.pieces !== undefined ? `${r.pieces} rigid piece(s) → one MeshPart each` : `${r.bake?.materials ?? '?'} material(s) → that many MeshParts`}; flat colours baked into vertex colours (Roblox drops flat material colours)`] : []),
            ...(r.pivots ? [`rig pivots ${rel(r.pivots)}: after upload + insert, animate {action:"rig", model:<inserted model path>, joints:"blender", blender_id:"${id}", controller:"Humanoid"|"AnimationController"}`] : []),
            `Studio-import file ${rel(r.model)} (${r.previewTriangles} triangles)`,
            ...anims.map(([n, f]) => `  animation ${n}: ${rel(f)}`),
            `next: model {action:"preview", id:"${id}"} to see it in Studio, then model {action:"import", id:"${id}"}`,
          ].join('\n'),
          summary: 'exported',
        };
      }
      // The GLB is the upload (vertex colours, 1 unit = 1 stud); older exports only have the FBX.
      const glb = join(dir, 'export', 'model.glb');
      const exported = existsSync(glb) ? glb : join(dir, 'export', 'model.fbx');
      if (!existsSync(exported)) return { text: `export first: model {action:"export", id:"${id}"}`, isError: true, summary: 'not exported' };
      if (a.action === 'preview') {
        const prev = JSON.parse(readFileSync(join(dir, 'export', 'preview.json'), 'utf8')) as { triangles: { v: number[][]; c: string }[] };
        const at = ((a.at as number[] | undefined) ?? [0, 0, 20]) as [number, number, number];
        const r = await runLuau(ctx.session, previewLuau(id, prev, at), 'edit', { chunkName: 'modelPreview', timeoutMs: 60_000 });
        if (!r.ok) return { text: `preview failed: ${r.error?.message}`, isError: true, summary: 'failed' };
        const v = r.values[0] as { name: string; size: number[] };
        return { text: `preview ${v.name} (${v.size.map((x) => x.toFixed(1)).join(' × ')} studs) — a local EditableMesh, not uploaded; it disappears when Studio closes. screenshot to judge it in the place.`, summary: 'preview' };
      }
      if (a.action === 'animate') {
        if (typeof a.target !== 'string') return { text: 'animate needs target: the inserted model in Studio (e.g. "Workspace.Dog"); upload + insert the model first', isError: true, summary: 'no target' };
        const exp = join(dir, 'export');
        const names = readdirSync(exp)
          .map((f) => /^anim_([^.]+)\.json$/.exec(f)?.[1]) // not anim_X.project.json (the rbxm build project)
          .filter((n): n is string => !!n && (typeof a.name !== 'string' || n === a.name));
        if (!names.length) return { text: `no exported animation data${typeof a.name === 'string' ? ` named ${a.name}` : ''}: model {action:"export", id:"${id}"} writes anim_<name>.json`, isError: true, summary: 'no animations' };
        const lines: string[] = [];
        let failed = false;
        for (const n of names) {
          const prepared = prepare(JSON.parse(readFileSync(join(exp, `anim_${n}.json`), 'utf8')) as AnimJson);
          const checks = checkMotion(prepared);
          lines.push(`${n} (${prepared.keyframes.length} frames, ${prepared.length.toFixed(2)}s${prepared.loop ? ', loop' : ''}):`);
          for (const c of checks) lines.push(`  ${c.ok ? '✓' : '✗'} ${c.id}  ${c.detail}`);
          if (checks.some((c) => !c.ok)) {
            failed = true;
            lines.push('  not built: fix the motion in Blender (model run), export, animate again');
            continue;
          }
          const r = await runLuau(ctx.session, buildLuau(a.target, prepared, `${id}_${n}`), 'edit', { chunkName: 'modelAnimate', timeoutMs: 120_000 });
          if (!r.ok) {
            failed = true;
            lines.push(`  ✗ build failed: ${r.error?.message}`);
            continue;
          }
          const b = JSON.parse(String(r.values[0])) as BuildResult;
          if (!b.ok || !b.frames || !b.part) {
            failed = true;
            lines.push(`  ✗ ${b.error ?? 'build failed'}`);
            continue;
          }
          const playOk = (b.playErr ?? 0) <= PLAY_TOLERANCE;
          lines.push(`  ${playOk ? '✓' : '✗'} anim:play  played on ${a.target}: bones within ${(b.playErr ?? 0).toFixed(3)} studs of the Blender motion${playOk ? '' : ` (worst ${b.playWorst})`}`);
          if (!playOk) {
            failed = true;
            continue;
          }
          const xml = keyframeSequenceXml({ name: `${id}_${n}`, loop: prepared.loop, part: b.part, order: prepared.order, parents: prepared.parents, frames: b.frames });
          const base = join(exp, `anim_${n}`);
          writeFileSync(`${base}.rbxmx`, xml);
          writeFileSync(`${base}.project.json`, JSON.stringify({ name: `${id}_${n}`, tree: { $path: `anim_${n}.rbxmx` } }));
          const built = await realSpawn(rojoBin(), ['build', `anim_${n}.project.json`, '--output', `anim_${n}.rbxm`], { cwd: exp });
          if (built.code !== 0) {
            failed = true;
            lines.push(`  ✗ rojo build of the .rbxm failed: ${(built.stderr || built.stdout).trim().slice(0, 300)}`);
            continue;
          }
          const animId = `${id}-${n.toLowerCase()}`;
          const file = `${base}.rbxm`.slice(P.length + 1);
          const m = loadManifest(P);
          const existing = m.assets.find((x) => x.id === animId);
          if (existing) {
            existing.ref = { ...existing.ref, file };
            if (existing.status === 'approved') existing.status = 'candidate';
            saveManifest(P, m);
          } else {
            const added = addAsset(P, { id: animId, kind: 'animation', source: 'generated', licence: 'owned', ref: { file }, provenance: { tool: 'blender (blox model animate)', createdAt: new Date().toISOString() } });
            if (!added.ok) lines.push(`  not recorded: ${added.errors.join('; ')}`);
          }
          lines.push(`  → ${file}, recorded as ${animId} (candidate); KeyframeSequence also in ServerStorage.BloxAnimations.${id}_${n}`);
        }
        if (!failed) {
          lines.push('Next: a human approves (blox asset approve <id>), asset {action:"upload", id, confirm:true}, then play it: Animator:LoadAnimation(Animation with AnimationId "rbxassetid://<id>"). Animations play only in places owned by the uploading user or group.');
        }
        return { text: lines.join('\n'), isError: failed, summary: failed ? 'failed' : `${names.length} animation(s)` };
      }
      if (a.action === 'import') {
        const m = loadManifest(P);
        const file = exported.slice(P.length + 1);
        const check = existsSync(join(dir, 'check.json')) ? (JSON.parse(readFileSync(join(dir, 'check.json'), 'utf8')) as ModelStats) : null;
        const existing = m.assets.find((x) => x.id === id);
        if (existing) {
          existing.ref = { ...existing.ref, file };
          if (check) existing.budget = { ...existing.budget, tris: check.triangles };
          if (existing.status === 'approved') existing.status = 'candidate'; // new content needs a new sign-off
          saveManifest(P, m);
        } else {
          const r = addAsset(P, {
            id, kind: 'model', source: 'generated', licence: 'owned', ref: { file },
            provenance: { tool: 'blender (blox model)', ...(brief?.prompt ? { prompt: brief.prompt } : {}), createdAt: new Date().toISOString() },
            ...(check ? { budget: { tris: check.triangles } } : {}),
          });
          if (!r.ok) return { text: `not recorded:\n  ${r.errors.join('\n  ')}`, isError: true, summary: 'invalid' };
        }
        const anims = readdirSync(join(dir, 'export')).filter((f) => /^anim_.+\.fbx$/.test(f));
        return {
          text: [
            `recorded ${id} → ${file} (candidate). A human approves it: blox asset approve ${id}; then asset {action:"upload", id:"${id}", confirm:true} (needs ROBLOX_OPEN_CLOUD_KEY) and insert it.`,
            `Without an Open Cloud key: Studio → Home → Import 3D → ${join(dir, 'export', 'model.fbx').slice(P.length + 1)}.`,
            ...(anims.length
              ? [`Animations (${anims.join(', ')}): Open Cloud only takes .rbxm animations, so import each FBX in Studio's Animation Editor (… → Import → From FBX Animation) on the imported rig, then publish it.`]
              : []),
          ].join('\n'),
          summary: 'recorded',
        };
      }
      return { text: `unknown action ${a.action}`, isError: true, summary: 'bad action' };
    },
  },
  {
    name: 'release',
    description:
      'Release readiness and publishing behind human gates. check (every machine gate: tests, design sim, FTUE/soak, multiplayer, UI lint, store lint, assets → READY/NOT READY + the human gates) | build (rojo build → .blox/build/place.rbxl + hash) | publish {confirm} (Place Publishing via Open Cloud: only when check is READY, a human ran `blox release approve` for this exact build, ids are in .blox/release.json and ROBLOX_OPEN_CLOUD_KEY is set; without confirm a dry run). Never publish unless the human asked.',
    shape: { action: z.enum(['check', 'build', 'publish']), confirm: z.boolean().optional() },
    async handler(a, ctx) {
      if (a.action === 'check') {
        const r = releaseCheck(ctx.projectPath);
        writeJson(ctx.projectPath, 'release-report.json', r);
        return { text: formatRelease(r), summary: r.ready ? 'ready' : 'not ready' };
      }
      if (a.action === 'build') {
        const b = await buildPlace(ctx.projectPath);
        return { text: [`built ${b.file} (sha256 ${b.sha256.slice(0, 12)}…)`, ...b.notes.map((n) => `note: ${n}`), 'Next: a human reviews and runs `blox release approve`.'].join('\n'), artifacts: [b.file], summary: 'built' };
      }
      const r = await publishRelease(ctx.projectPath, { confirm: a.confirm === true });
      if (r.dryRun) return { text: `DRY RUN — would publish ${r.sha256.slice(0, 12)}… to universe ${r.target.universeId} place ${r.target.placeId}. Re-run with confirm:true only if the human asked to publish now.`, summary: 'dry run' };
      return { text: `published build ${r.sha256.slice(0, 12)}… → version ${r.versionNumber ?? '?'}`, summary: 'published' };
    },
  },
  {
    name: 'liveops',
    description:
      'Post-launch loop. report {from?} (analytics from a Creator Hub export JSON — {retention:{d1,d7,d30}, sessionLengthMin, payerConversion, funnel:[{step,name,users}]} — or the Analytics Query API; graded vs GameAnalytics benchmarks → findings) | propose {finding?} (design changes for the worst finding, each validated by the simulator; never monetization) | apply {proposal} (writes design.json + Tunables locally; ships with the next human-approved release) | push {kind: config|thumbnails, confirm} (live Configs from design tunables / rendered thumbnails to Thumbnail Personalization; dry run unless confirm + key + a human ran `blox liveops approve <kind>` on this exact payload; monetization keys refused).',
    shape: {
      action: z.enum(['report', 'propose', 'apply', 'push']),
      from: z.string().optional(),
      finding: z.string().optional(),
      proposal: z.string().optional(),
      kind: z.enum(['config', 'thumbnails']).optional(),
      confirm: z.boolean().optional(),
    },
    async handler(a, ctx) {
      const P = ctx.projectPath;
      if (a.action === 'report') {
        let analytics;
        let source: string;
        if (typeof a.from === 'string') {
          if (!isPathContained(P, a.from)) return { text: `${a.from} is outside the project`, isError: true, summary: 'outside project' };
          const file = join(P, a.from);
          if (!existsSync(file)) return { text: `no file ${a.from}`, isError: true, summary: 'no file' };
          const v = AnalyticsSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
          if (!v.success) return { text: `bad analytics export:\n${v.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`, isError: true, summary: 'invalid' };
          analytics = v.data;
          source = a.from;
        } else {
          if (!openCloudKey()) return { text: 'no analytics source: pass from:"<export.json>" (a human exports it from Creator Hub → Analytics) or set ROBLOX_OPEN_CLOUD_KEY (scope universe.analytics:read) and .blox/release.json', isError: true, summary: 'no source' };
          analytics = await fetchAnalytics(new OpenCloud(), loadTarget(P).universeId);
          source = 'analytics-query-api (unverified endpoint)';
        }
        const g = gradeAnalytics(analytics);
        writeJson(P, 'liveops-report.json', { ranAt: new Date().toISOString(), source, analytics, ...g });
        const lines = [`liveops report (${source}):`, ...g.grades.map((x) => `  ${x.metric}: ${x.value} (${x.band})`), g.findings.length ? 'findings (worst first):' : 'no findings below benchmark', ...g.findings.map((f) => `  ${f.id} [${f.lever}] ${f.detail}`)];
        if (g.findings.length) lines.push('Next: liveops {action:"propose"}');
        return { text: lines.join('\n'), summary: `${g.findings.length} findings` };
      }
      if (a.action === 'propose') {
        const rep = readJson<{ findings: Finding[] }>(P, 'liveops-report.json');
        if (!rep) return { text: 'run liveops {action:"report"} first', isError: true, summary: 'no report' };
        const f = typeof a.finding === 'string' ? rep.findings.find((x) => x.id === a.finding) : rep.findings.find((x) => x.lever !== 'monetization');
        if (!f) return { text: a.finding ? `unknown finding ${a.finding}` : 'no findings a design change can address (monetization is a human decision)', isError: !!a.finding, summary: 'nothing' };
        const dv = validateDesign(readJson<unknown>(P, 'design.json'));
        if (!dv.ok) return { text: 'propose needs a valid .blox/design.json', isError: true, summary: 'no design' };
        const ps = propose(dv.doc, f);
        mkdirSync(join(P, '.blox', 'proposals'), { recursive: true });
        for (const p of ps) writeJson(P, `proposals/${p.id}.json`, p);
        const lines = [`${ps.length} proposal(s) for ${f.id} (${f.detail}):`, ...ps.map((p) => `  ${p.id}: ${p.description} — ${p.target.metric} ${Number(p.target.before.toPrecision(4))} → ${Number(p.target.after.toPrecision(4))}, assertions ${p.assertions.after}/${p.assertions.total}`)];
        if (ps.length) lines.push('Apply one with liveops {action:"apply", proposal}. Live changes still go through a human-approved release or push.');
        return { text: lines.join('\n'), summary: `${ps.length} proposals` };
      }
      if (a.action === 'apply') {
        if (typeof a.proposal !== 'string') return { text: 'apply needs proposal id', isError: true, summary: 'no id' };
        const p = readJson<Proposal>(P, `proposals/${a.proposal}.json`);
        if (!p) return { text: `unknown proposal ${a.proposal}`, isError: true, summary: 'unknown' };
        if (p.applied) return { text: `proposal ${p.id} already applied at ${p.applied}`, summary: 'already applied' };
        const dv = validateDesign(readJson<unknown>(P, 'design.json'));
        if (!dv.ok) return { text: 'design.json is invalid', isError: true, summary: 'invalid' };
        const r = applyChanges(dv.doc, p.changes);
        if (!r.ok) return { text: r.error, isError: true, summary: 'stale' };
        writeJson(P, 'design.json', r.doc);
        const f = join(P, TUNABLES_PATH);
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, renderTunables(r.doc));
        writeJson(P, `proposals/${p.id}.json`, { ...p, applied: new Date().toISOString() });
        return { text: `applied ${p.id}: ${p.changes.map((c) => `${c.path} ${c.from} → ${c.to}`).join(', ')}; Tunables regenerated. Next: design simulate, run_tests, metrics ftue, then a human-approved release.`, summary: 'applied' };
      }
      // push — target ids only needed for the real call; a dry run shows what would go out.
      let target: { universeId: number | string; placeId?: number } = { universeId: '<set .blox/release.json>' };
      try {
        target = loadTarget(P);
      } catch (e) {
        if (a.confirm) throw e;
      }
      const kind = a.kind === 'thumbnails' ? 'thumbnails' : 'config';
      let payload;
      try {
        payload = pushPayload(P, kind);
      } catch (e) {
        return { text: (e as Error).message, isError: true, summary: 'not ready' };
      }
      const approved = isApproved(P, payload);
      const gate = approved ? 'approved by a human for this exact payload' : `NOT approved — a human runs \`blox liveops approve ${kind}\` after reviewing this dry run`;
      if (payload.kind === 'thumbnails') {
        if (!a.confirm) return { text: `DRY RUN — would upload ${payload.files.length} thumbnail(s) to universe ${target.universeId}: ${payload.files.join(', ')}\n(endpoint unverified: ${UNVERIFIED_ENDPOINTS.join(', ')}). ${gate}.`, summary: 'dry run' };
        if (!approved) return { text: `refused: ${gate}`, isError: true, summary: 'not approved' };
        const client = new OpenCloud();
        for (const f of payload.files) await client.uploadThumbnail(target.universeId as number, readFileSync(join(P, f)), f.split('/').pop()!, f.endsWith('.png') ? 'image/png' : 'image/jpeg');
        return { text: `uploaded ${payload.files.length} thumbnail(s)`, summary: 'uploaded' };
      }
      const tail = payload.skipped.length ? `\nskipped (monetization, human): ${payload.skipped.join(', ')}` : '';
      if (!a.confirm) return { text: `DRY RUN — would set live config on universe ${target.universeId}:\n${JSON.stringify(payload.entries, null, 2)}${tail}\n(endpoint unverified; the game must read these via ConfigService to take effect). ${gate}.`, summary: 'dry run' };
      if (!approved) return { text: `refused: ${gate}`, isError: true, summary: 'not approved' };
      await new OpenCloud().putConfigs(target.universeId as number, payload.entries);
      return { text: `pushed ${Object.keys(payload.entries).length} config value(s)${tail}`, summary: 'pushed' };
    },
  },
  {
    name: 'animate',
    description: ANIMATE_DESCRIPTION,
    shape: animateShape,
    handler: animateTool,
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

// Persist criteria statuses after offline/synthetic results change, so the
// dashboard and task {get} see them without a separate run_tests.
function refreshCriteria(projectPath: string): void {
  const task = loadTask(projectPath);
  if (!task) return;
  const lt = withSyntheticResults(projectPath, readJson<TestSummaryLike>(projectPath, 'last-tests.json'));
  task.criteria = evaluateCriteria(task, lt).map((c, i) => (task.criteria[i].tests?.length ? c : task.criteria[i]));
  saveTask(projectPath, task);
}

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

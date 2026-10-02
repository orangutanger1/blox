import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { StudioSession } from '../studio/session.js';
import { runLuau } from '../studio/luau.js';
import { collectLogs, startPlay, stopPlay, summarizeLogs } from '../studio/play.js';
import type { DesignDoc } from '../design/schema.js';
import { evaluateFtue, evaluateSoak, normalizeDump, type MetricResult, type MetricsReport } from './gamefeel.js';

// Runs a playtest with a bot driving the player, then reads BloxTelemetry and
// evaluates FTUE or soak metrics.

const BUILTIN_BOTS: Record<string, string> = {
  idle: 'local function __bot(player, deadline) end',
  // Back and forth along Z from wherever the character stands.
  walk: `local function __bot(player, deadline)
	local out = true
	while os.clock() < deadline do
		local char = player.Character
		local hum = char and char:FindFirstChildOfClass("Humanoid")
		local root = char and char:FindFirstChild("HumanoidRootPart")
		if hum and root then
			hum:MoveTo(root.Position + Vector3.new(0, 0, out and -40 or 40))
			out = not out
		end
		task.wait(4)
	end
end`,
};

// Server Luau that starts the bot in its own thread and returns at once.
// Project bot files are inlined: playtest DataModels have no loadstring.
export function botProgram(projectPath: string, bot: string, seconds: number): string {
  let def = BUILTIN_BOTS[bot];
  if (def === undefined) {
    const file = resolve(projectPath, bot);
    if (!file.startsWith(resolve(projectPath) + sep) || !existsSync(file)) throw new Error(`bot file not found in project: ${bot} (or use "walk" | "idle")`);
    def = `local __bot = (function()\n${readFileSync(file, 'utf8')}\nend)()`;
  }
  return `local Players = game:GetService("Players")
local player = Players:GetPlayers()[1]
if not player then error("no player to drive") end
local deadline = os.clock() + ${seconds}
${def}
task.spawn(function()
	local ok, err = pcall(__bot, player, deadline)
	if not ok then warn("[blox bot] " .. tostring(err)) end
end)
return true`;
}

const DUMP_CODE = 'local f = game:GetService("ServerStorage"):FindFirstChild("BloxTelemetry")\nif not f then return nil end\nreturn f:Invoke("dump")';

export interface MetricsRunOptions {
  mode: 'ftue' | 'soak';
  seconds: number;
  bot: string;
  archetype?: string;
  tolerance?: number;
  maxMemGrowthMbPerMin?: number;
  sleep?: (ms: number) => Promise<void>;
}

const NO_TELEMETRY =
  'BloxTelemetry not running — metrics {action:"install"}, then call Telemetry.start() at server boot and Telemetry.step(player, "<ftue id>") where each FTUE step happens (kits do this already)';

export async function runMetrics(session: StudioSession, projectPath: string, doc: DesignDoc | null, o: MetricsRunOptions): Promise<MetricsReport> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const program = botProgram(projectPath, o.bot, o.seconds); // validate before starting a playtest
  const notes: string[] = [];
  const info = await startPlay(session);
  let raw: unknown = null;
  let errors = 0;
  try {
    if (o.bot !== 'idle') {
      const b = await runLuau(session, program, 'server', { chunkName: 'bot' });
      if (!b.ok) notes.push(`bot did not start: ${b.error?.message}`);
    }
    await sleep(o.seconds * 1000);
    const d = await runLuau(session, DUMP_CODE, 'server', { chunkName: 'telemetry' });
    raw = d.ok ? d.values[0] : null;
    const since = info.startedAt - 1;
    const [sl, cl] = await Promise.all([collectLogs(session, 'server', since).catch(() => []), collectLogs(session, 'client', since).catch(() => [])]);
    const logs = summarizeLogs([...sl, ...cl]);
    errors = logs.errors.length;
    for (const e of logs.errors.slice(0, 5)) notes.push(`runtime error [${e.context}] ${e.message}`);
    for (const w of logs.warnings) if (w.message.includes('[blox bot]')) notes.push(`bot: ${w.message}`);
  } finally {
    if (!info.alreadyRunning) await stopPlay(session).catch(() => false);
  }
  if (info.players === 0) notes.push('no player joined the playtest');
  let results: MetricResult[];
  const dump = typeof raw === 'string' ? normalizeDump(JSON.parse(raw)) : null;
  if (!dump) {
    results = [{ id: `${o.mode}:telemetry`, ok: false, actual: null, detail: NO_TELEMETRY }];
    if (o.mode === 'soak') results.unshift({ id: 'soak:errors', ok: errors === 0, actual: errors, detail: `${errors} runtime error(s)` });
  } else if (o.mode === 'ftue') {
    results = evaluateFtue(dump, doc);
    if (errors) notes.push(`${errors} runtime error(s) during the FTUE run`);
  } else {
    results = evaluateSoak(dump, errors, { seconds: o.seconds, doc, archetype: o.archetype, tolerance: o.tolerance, maxMemGrowthMbPerMin: o.maxMemGrowthMbPerMin });
  }
  return { ranAt: new Date().toISOString(), mode: o.mode, seconds: o.seconds, bot: o.bot, results, notes };
}


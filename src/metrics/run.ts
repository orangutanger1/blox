import { APPEARANCE_WAIT } from '../testing/playHost.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { StudioSession } from '../studio/session.js';
import { runLuau } from '../studio/luau.js';
import { BRIDGE_MAX_TIMEOUT_MS, bridgeDenyReason, isBridgeFailure } from '../studio/evalBridge.js';

const botTimeoutMs = (seconds: number) => seconds * 1000 + 15_000;
const HTTP_OFF = /Http requests are not enabled/i;
import { collectLogs, startPlay, stopPlay, summarizeLogs } from '../studio/play.js';
import { BOT_HOST, installScript, removeHosts } from '../testing/playHost.js';
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
// blocking: run the bot to its deadline before returning. The eval bridge
// destroys its script when the probe returns, which would kill a spawned bot.
export function botProgram(projectPath: string, bot: string, seconds: number, opts: { blocking?: boolean } = {}): string {
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
${opts.blocking
    ? `local ok, err = pcall(__bot, player, deadline)
if not ok then warn("[blox bot] " .. tostring(err)) end`
    : `task.spawn(function()
	local ok, err = pcall(__bot, player, deadline)
	if not ok then warn("[blox bot] " .. tostring(err)) end
end)`}
return true`;
}

// Reads the dump BloxTelemetry publishes to a StringValue (the MCP thread may
// not invoke game code since Studio's Sep 2026 capability sandbox); falls back
// to invoking the bindable for projects with an older BloxTelemetry.
// Script source for BloxBotHost: waits for the first player's character, then
// runs botProgram (which spawns the bot and returns).
export function botHostSource(program: string): string {
  return `local Players = game:GetService("Players")
local p = Players:GetPlayers()[1] or Players.PlayerAdded:Wait()
if not p.Character then p.CharacterAdded:Wait() end
${APPEARANCE_WAIT}
local function __blox_bot()
${program}
end
local ok, err = pcall(__blox_bot)
if not ok then warn("[blox bot] " .. tostring(err)) end
`;
}

const DUMP_CODE = `local SS = game:GetService("ServerStorage")
local v = SS:FindFirstChild("BloxTelemetryDump")
if v and v.Value ~= "" then return v.Value end
local f = SS:FindFirstChild("BloxTelemetry")
if not f then return nil end
return f:Invoke("dump")`;

export interface MetricsRunOptions {
  mode: 'ftue' | 'soak';
  seconds: number;
  bot: string;
  archetype?: string;
  tolerance?: number;
  maxMemGrowthMbPerMin?: number;
  expect?: string[];
  sleep?: (ms: number) => Promise<void>;
}

const NO_TELEMETRY =
  'BloxTelemetry not running — metrics {action:"install"}, then call Telemetry.start() at server boot and Telemetry.step(player, "<ftue id>") where each FTUE step happens (kits do this already)';

export async function runMetrics(session: StudioSession, projectPath: string, doc: DesignDoc | null, o: MetricsRunOptions): Promise<MetricsReport> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const program = botProgram(projectPath, o.bot, o.seconds); // validate before starting a playtest
  const notes: string[] = [];
  // The bot must run at game-script identity so it can require game modules
  // (the MCP thread cannot, since Studio's Sep 2026 capability sandbox): through
  // the eval bridge when it is on and the run fits, else as an injected server
  // Script, which must exist before Play starts.
  let bridgeBot: string | null = null;
  if (session.evalBridge && o.bot !== 'idle') {
    const blocking = botProgram(projectPath, o.bot, o.seconds, { blocking: true });
    const why = bridgeDenyReason(blocking) ?? (botTimeoutMs(o.seconds) > BRIDGE_MAX_TIMEOUT_MS ? `a ${o.seconds}s run is longer than the bridge's ${BRIDGE_MAX_TIMEOUT_MS / 1000}s limit` : null);
    if (why) notes.push(`eval bridge not used (${why}); bot ran as an injected script`);
    else bridgeBot = blocking;
  }
  const st = await session.state();
  if (st.mode !== 'Edit') await stopPlay(session);
  await removeHosts(session);
  let info: Awaited<ReturnType<typeof startPlay>> | null = null;
  let raw: unknown = null;
  let errors = 0;
  let bridgeDown = false;
  try {
    if (bridgeBot) {
      info = await startPlay(session);
      try {
        const b = await runLuau(session, bridgeBot, 'server', { chunkName: 'bot', timeoutMs: botTimeoutMs(o.seconds) });
        if (!b.ok && isBridgeFailure(b.error?.message ?? '')) throw new Error(b.error!.message);
        if (!b.ok) notes.push(`bot: ${b.error?.message}`);
        notes.push('bot ran through the eval bridge');
      } catch (e) {
        if (!isBridgeFailure((e as Error).message)) throw e;
        notes.push(`eval bridge failed (${(e as Error).message}); bot reran as an injected script`);
        bridgeBot = null;
        bridgeDown = true;
        await stopPlay(session);
      }
    }
    if (!bridgeBot) {
      if (o.bot !== 'idle') await installScript(session, BOT_HOST, botHostSource(program), 'metrics bot');
      info = await startPlay(session);
      await sleep(o.seconds * 1000);
    }
    let d = await runLuau(session, DUMP_CODE, 'server', { chunkName: 'telemetry', ...(bridgeDown ? { via: 'mcp' as const } : {}) }).catch((e: Error) => {
      if (isBridgeFailure(e.message)) return null;
      throw e;
    });
    // An idle bot never touched the bridge: a missing plugin shows up only
    // here, so read the dump on the MCP thread instead of failing the run.
    if (!d || (!d.ok && isBridgeFailure(d.error?.message ?? ''))) d = await runLuau(session, DUMP_CODE, 'server', { chunkName: 'telemetry', via: 'mcp' });
    raw = d.ok ? d.values[0] : null;
    const since = info!.startedAt - 1; // set by one of the two branches above
    const [sl, cl] = await Promise.all([collectLogs(session, 'server', since).catch(() => []), collectLogs(session, 'client', since).catch(() => [])]);
    const logs = summarizeLogs([...sl, ...cl]);
    // The bridge turns the server's HttpEnabled off while its probe (the bot)
    // runs: the game's HTTP calls failing then is the harness, not the game.
    const httpOff = bridgeBot ? logs.errors.filter((e) => HTTP_OFF.test(e.message)) : [];
    if (httpOff.length) {
      logs.errors = logs.errors.filter((e) => !HTTP_OFF.test(e.message));
      notes.push(`${httpOff.length} HTTP error(s) ignored: HTTP requests are off while the eval bridge runs the bot`);
    }
    errors = logs.errors.length;
    for (const e of logs.errors.slice(0, 5)) notes.push(`runtime error [${e.context}] ${e.message}`);
    for (const w of logs.warnings) if (w.message.includes('[blox bot]')) notes.push(`bot: ${w.message}`);
  } finally {
    await stopPlay(session).catch(() => false);
    await removeHosts(session).catch(() => {});
  }
  if (info?.players === 0) notes.push('no player joined the playtest');
  let results: MetricResult[];
  const dump = typeof raw === 'string' ? normalizeDump(JSON.parse(raw)) : null;
  if (!dump) {
    results = [{ id: `${o.mode}:telemetry`, ok: false, actual: null, detail: NO_TELEMETRY }];
    if (o.mode === 'soak') results.unshift({ id: 'soak:errors', ok: errors === 0, actual: errors, detail: `${errors} runtime error(s)` });
  } else if (o.mode === 'ftue') {
    results = evaluateFtue(dump, doc);
    if (errors) notes.push(`${errors} runtime error(s) during the FTUE run`);
  } else {
    results = evaluateSoak(dump, errors, { seconds: o.seconds, doc, archetype: o.archetype, tolerance: o.tolerance, maxMemGrowthMbPerMin: o.maxMemGrowthMbPerMin, expect: o.expect });
  }
  return { ranAt: new Date().toISOString(), mode: o.mode, seconds: o.seconds, bot: o.bot, results, notes };
}


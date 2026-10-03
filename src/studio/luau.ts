import { runLuauViaBridge } from './evalBridge.js';
import { StudioError, contextToDataModel, resultText, type DataModelContext, type StudioSession } from './session.js';

// Structured Luau execution on top of Studio's execute_luau.
//
// Raw execute_luau returns only tostring() of the FIRST return value, drops
// print() output into the global console, and reports errors against an
// anonymous "AssistantCommand" chunk. An agent can't reliably tell what
// happened. runLuau wraps the code so every call returns one JSON envelope:
// all return values (Instances/Vector3/tables serialized), the log lines the
// call emitted (typed: output/info/warning/error), and errors with line numbers
// mapped back to the caller's chunk.

export type LogLevel = 'output' | 'info' | 'warning' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  t?: number; // unix seconds
}

export interface LuauResult {
  ok: boolean;
  values: unknown[];
  logs: LogEntry[];
  error?: { message: string; traceback?: string };
  durationMs: number;
}

// Pick a long-bracket level whose closer does not occur in `s`.
export function longString(s: string): string {
  let eq = '';
  // The closer must not occur inside s, and s's tail must not fuse with the
  // closer into an earlier one (s ending in "]" + "]]" closes one char early).
  while ((s + `]${eq}]`).indexOf(`]${eq}]`) !== s.length) eq += '=';
  // A leading newline right after the opener is dropped by Luau; pad it so a
  // source starting with "\n" round-trips.
  const pad = s.startsWith('\n') || s.startsWith('\r') ? '\n' : '';
  return `[${eq}[${pad}${s}]${eq}]`;
}

// Serializer + log capture shared by every wrapped call. Kept as one Luau
// block so line offsets for the user chunk are computable.
export const LUAU_PRELUDE = `local __HS = game:GetService("HttpService")
local __LS = game:GetService("LogService")
local function __ser(v, depth, seen)
	depth = depth or 0
	local t = typeof(v)
	if t == "nil" then return nil end
	if t == "number" then if v ~= v or v == math.huge or v == -math.huge then return tostring(v) end return v end
	if t == "string" or t == "boolean" then return v end
	if t == "Instance" then return { ["$instance"] = v:GetFullName(), className = v.ClassName } end
	if t == "Vector3" then return { x = v.X, y = v.Y, z = v.Z } end
	if t == "Vector2" then return { x = v.X, y = v.Y } end
	if t == "CFrame" then return { x = v.X, y = v.Y, z = v.Z, rot = { v:ToEulerAnglesXYZ() } } end
	if t == "Color3" then return { r = math.floor(v.R * 255 + 0.5), g = math.floor(v.G * 255 + 0.5), b = math.floor(v.B * 255 + 0.5) } end
	if t == "UDim2" then return { xs = v.X.Scale, xo = v.X.Offset, ys = v.Y.Scale, yo = v.Y.Offset } end
	if t == "EnumItem" then return tostring(v) end
	if t == "table" then
		if depth >= 6 then return "<table depth limit>" end
		seen = seen or {}
		if seen[v] then return "<cycle>" end
		seen[v] = true
		local n = #v
		local count = 0
		for _ in pairs(v) do count += 1 end
		local out = {}
		if n > 0 and n == count then
			for i = 1, math.min(n, 500) do out[i] = __ser(v[i], depth + 1, seen) end
			if n > 500 then out[501] = "<" .. (n - 500) .. " more>" end
		else
			local k = 0
			for key, val in pairs(v) do
				k += 1
				if k > 500 then out["<truncated>"] = count - 500 break end
				out[tostring(key)] = __ser(val, depth + 1, seen)
			end
		end
		seen[v] = nil
		return out
	end
	return "<" .. t .. ">"
end
local function __lvl(mt)
	if mt == Enum.MessageType.MessageError then return "error" end
	if mt == Enum.MessageType.MessageWarning then return "warning" end
	if mt == Enum.MessageType.MessageInfo then return "info" end
	return "output"
end
-- Edit-context require() caches by instance, so after a sync a test would see
-- the OLD module code. __freshRequire loads ModuleScripts from their current
-- Source (memoized per call) with script/require bound for relative requires.
local __fresh = {}
local __freshRequire
__freshRequire = function(m)
	if typeof(m) ~= "Instance" or not m:IsA("ModuleScript") then return require(m) end
	local hit = __fresh[m]
	if hit ~= nil then
		if hit == __fresh then error("cyclic require of " .. m:GetFullName(), 2) end
		return hit
	end
	__fresh[m] = __fresh
	local fn, err = loadstring(m.Source, "=" .. m:GetFullName())
	if not fn then error(err, 2) end
	setfenv(fn, setmetatable({ script = m, require = __freshRequire }, { __index = getfenv(0) }))
	local ok, res = pcall(fn)
	if not ok then __fresh[m] = nil error(res, 0) end
	__fresh[m] = res
	return res
end
local __t0 = DateTime.now().UnixTimestampMillis / 1000 - 0.002
local __logs = {}
local __conn = __LS.MessageOut:Connect(function(m, mt)
	if #__logs < 400 then table.insert(__logs, { level = __lvl(mt), message = string.sub(m, 1, 2000) }) end
end)
`;

const PRELUDE_LINES = LUAU_PRELUDE.split('\n').length - 1;

// Program line where user line 1 sits, minus one (see wrapLuau).
export function userLineOffset(freshRequire: boolean): number {
  return PRELUDE_LINES + (freshRequire ? 2 : 1);
}

export function wrapLuau(code: string, opts: { freshRequire?: boolean } = {}): { program: string; userLineOffset: number } {
  const shadow = opts.freshRequire ? 'local require = __freshRequire\n' : '';
  const head = `${LUAU_PRELUDE}${shadow}local function __user()\n`;
  const offset = userLineOffset(!!shadow);
  const tail = `
end
local __started = os.clock()
local __r = table.pack(xpcall(__user, function(e) return { msg = tostring(e), tb = debug.traceback(nil, 2) } end))
task.wait() -- let deferred MessageOut events land
__conn:Disconnect()
local __env = { ok = __r[1], logs = __logs, ms = math.floor((os.clock() - __started) * 1000) }
if __r[1] then
	local vals = {}
	for i = 2, __r.n do vals["v" .. (i - 1)] = __ser(__r[i]) end
	__env.values = vals
	__env.n = __r.n - 1
else
	__env.error = { message = tostring(__r[2] and __r[2].msg), traceback = __r[2] and __r[2].tb }
end
local okEnc, enc = pcall(function() return __HS:JSONEncode(__env) end)
if okEnc then return enc end
return __HS:JSONEncode({ ok = false, logs = {}, error = { message = "result not serializable: " .. tostring(enc) } })
`;
  return { program: head + code + tail, userLineOffset: offset };
}

// Rewrite "AssistantCommand:<n>" / '[string "..."]:<n>' line refs to the caller's chunk.
export function mapLines(text: string, offset: number, chunk: string, userLines = Infinity): string {
  return text.replace(/(?:[\w.]*AssistantCommand|\[string "[^"]*"\]):(\d+)/g, (_m, n: string) => {
    const line = Number(n) - offset;
    return line >= 1 && line <= userLines ? `${chunk}:${line}` : '<blox-wrapper>';
  }).replace(/sabuiltin_Assistant\.rbxm[\w.]*:\d+: /g, '');
}

export interface RunLuauOptions {
  chunkName?: string;
  // Load ModuleScripts from current Source instead of the cached require.
  // Defaults to true in edit context (the only context with a stale cache —
  // each playtest builds a fresh DataModel).
  freshRequire?: boolean;
  timeoutMs?: number;
}

export async function runLuau(
  session: StudioSession,
  code: string,
  context: DataModelContext = 'edit',
  opts: RunLuauOptions = {},
): Promise<LuauResult> {
  // Opted-in projects run play probes through the dock plugin's eval bridge,
  // where require() of game modules works (execute_luau's play thread can't).
  if (context !== 'edit' && session.evalBridge) return runLuauViaBridge(code, context, { chunkName: opts.chunkName, timeoutMs: opts.timeoutMs });
  const chunk = opts.chunkName ?? 'luau';
  const { program, userLineOffset } = wrapLuau(code, { freshRequire: opts.freshRequire ?? context === 'edit' });
  const t0 = Date.now();
  const r = await session.call('execute_luau', { code: program, datamodel_type: contextToDataModel(context) }, opts.timeoutMs);
  const text = resultText(r);
  const durationMs = Date.now() - t0;
  const userLines = code.split('\n').length;
  const map = (t: string) => mapLines(t, userLineOffset, chunk, userLines);
  if (r.isError) {
    if (/not available in Play mode/i.test(text)) {
      throw new StudioError('wrong_mode', 'Edit context is unavailable while a playtest is running.', 'Stop the playtest first (play action "stop"), or target context "server"/"client".');
    }
    if (/(Server|Client).*not available|not in play|only available in play/i.test(text)) {
      throw new StudioError('wrong_mode', `${context} context needs a running playtest.`, 'Start one with play {action:"start"} or use playtest.');
    }
    // A syntax error fails the whole chunk with a bare "Failed to parse
    // command code". Recompile just the user code to recover the real message.
    if (/failed to parse/i.test(text)) {
      const diag = await session.call('execute_luau', {
        code: `local _, e = loadstring(${longString(code)}, ${JSON.stringify('=' + chunk)}) return tostring(e)`,
        datamodel_type: contextToDataModel(context),
      }, 15_000).catch(() => null);
      const msg = diag && !diag.isError ? resultText(diag) : '';
      return { ok: false, values: [], logs: [], error: { message: `syntax error: ${msg && msg !== 'nil' ? msg : text}` }, durationMs };
    }
    return { ok: false, values: [], logs: [], error: { message: map(text) }, durationMs };
  }
  let env: { ok: boolean; values?: Record<string, unknown>; n?: number; logs?: LogEntry[]; error?: { message: string; traceback?: string } };
  try {
    env = JSON.parse(text);
  } catch {
    return { ok: false, values: [], logs: [], error: { message: `unexpected execute_luau output: ${text.slice(0, 500)}` }, durationMs };
  }
  const values: unknown[] = [];
  const n = env.n ?? 0;
  const raw = (env.values ?? {}) as Record<string, unknown>;
  for (let i = 1; i <= n; i++) values.push(raw[`v${i}`] ?? null);
  return {
    ok: env.ok,
    values,
    logs: (env.logs ?? []).map((l) => ({ ...l, message: map(l.message) })),
    ...(env.error
      ? {
          error: {
            message: map(env.error.message),
            ...(env.error.traceback ? { traceback: map(env.error.traceback) } : {}),
          },
        }
      : {}),
    durationMs,
  };
}

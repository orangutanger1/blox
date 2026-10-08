import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { longString } from '../studio/luau.js';
import { testProgram, type SpecFile } from '../testing/runner.js';

// Luau the multiplayer lane injects into the edit DataModel (and removes after):
// a specs ModuleScript, a server harness Script and a client agent LocalScript.

export const MAX_CLIENTS = 8;

export interface MpSpecs {
  specs: SpecFile[];
  clients: number; // max of the files' `-- @clients N` headers, default 2
}

export function discoverMpSpecs(projectPath: string, filter?: string, testDir = 'tests'): MpSpecs {
  const root = join(projectPath, testDir);
  const specs: SpecFile[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir).sort()) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.mp\.luau$/i.test(e)) specs.push({ file: relative(projectPath, full).replace(/\\/g, '/'), context: 'server', source: readFileSync(full, 'utf8') });
    }
  };
  if (existsSync(root)) walk(root);
  const picked = filter ? specs.filter((s) => s.file.includes(filter)) : specs;
  let clients = 2;
  for (const s of picked) {
    const m = /^--\s*@clients\s+(\d+)/m.exec(s.source);
    if (m) clients = Math.max(clients, Number(m[1]));
  }
  return { specs: picked, clients: Math.min(MAX_CLIENTS, Math.max(1, clients)) };
}

// ModuleScript source: `return function(mp) <inlined spec runner> end`.
// specLines are 1-based lines inside that module.
export function specsModule(specs: SpecFile[], testTimeoutSec: number): { source: string; specLines: number[] } {
  const { code, specLines } = testProgram(specs, testTimeoutSec, { extraParams: ['mp'] });
  return { source: `return function(mp)\n${code}\nend\n`, specLines: specLines.map((l) => l + 1) };
}

export const HARNESS_SOURCE = `-- blox multiplayer harness: injected by \`blox multiplayer\`, removed afterwards.
local ServerStorage = game:GetService("ServerStorage")
local RunService = game:GetService("RunService")
local raw = ServerStorage:GetAttribute("BloxMpRun")
if not raw or not RunService:IsRunning() then return end
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local StudioTestService = game:GetService("StudioTestService")
local cfg = HttpService:JSONDecode(raw)

local rf = Instance.new("RemoteFunction")
rf.Name = "__BloxMpRF"
rf.Parent = ReplicatedStorage
local readyEvent = Instance.new("RemoteEvent")
readyEvent.Name = "__BloxMpReady"
readyEvent.Parent = ReplicatedStorage
local agents = {}
readyEvent.OnServerEvent:Connect(function(p) agents[p] = true end)

local function finish(v)
	StudioTestService:EndTest(HttpService:JSONEncode(v))
end

local ok, err = pcall(function()
	local deadline = os.clock() + (cfg.joinTimeout or 60)
	local ready = {}
	while os.clock() < deadline do
		ready = {}
		for _, p in Players:GetPlayers() do
			if agents[p] and p.Character and p.Character:FindFirstChild("HumanoidRootPart") then
				table.insert(ready, p)
			end
		end
		if #ready >= cfg.clients then break end
		task.wait(0.25)
	end
	if #ready < cfg.clients then
		error(string.format("only %d/%d clients joined with a character and the blox agent", #ready, cfg.clients), 0)
	end
	local mp = { players = ready }
	-- InvokeClient has no timeout; a client that stops answering would only
	-- surface as a vague test timeout, so bound every call.
	function mp.client(player, op, ...)
		local args = table.pack(...)
		local done, res = false, nil
		task.spawn(function()
			res = table.pack(pcall(function() return rf:InvokeClient(player, op, table.unpack(args, 1, args.n)) end))
			done = true
		end)
		local t = os.clock() + 10
		while not done and os.clock() < t do task.wait(0.03) end
		if not done then error(string.format("client %s did not answer %q within 10s", player.Name, tostring(op)), 2) end
		if not res[1] then error(res[2], 2) end
		return table.unpack(res, 2, res.n)
	end
	-- Prove each client agent answers before any spec runs.
	for _, p in ready do
		local t = os.clock() + 15
		local okPing = false
		while os.clock() < t and not okPing do
			okPing = pcall(mp.client, p, "ping")
			if not okPing then task.wait(0.5) end
		end
		if not okPing then error("client " .. p.Name .. " joined but its blox agent never answered a ping", 0) end
	end
	function mp.waitPlayers(n)
		local t = os.clock() + 30
		while #Players:GetPlayers() < n and os.clock() < t do task.wait(0.25) end
		return Players:GetPlayers()
	end
	local run = require(ServerStorage:WaitForChild("__BloxMp"):WaitForChild("Specs"))
	local res = run(mp)
	finish({ ok = true, players = #ready, results = res.results, fileErrors = res.fileErrors })
end)
if not ok then finish({ ok = false, error = tostring(err) }) end
`;

export const CLIENT_SOURCE = `-- blox multiplayer client agent: fixed ops only (no code execution on clients).
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local rf = ReplicatedStorage:WaitForChild("__BloxMpRF", 60)
local ready = ReplicatedStorage:WaitForChild("__BloxMpReady", 60)
if not rf or not ready then return end
local player = Players.LocalPlayer

local function resolve(path)
	local cur = game
	for name in string.gmatch(path, "[^%.]+") do
		if cur == game and name == "game" then continue end
		local nxt
		if cur == Players and name == "LocalPlayer" then
			nxt = player
		else
			nxt = cur:FindFirstChild(name)
			if not nxt and cur == game then
				local ok, svc = pcall(function() return game:GetService(name) end)
				nxt = ok and svc or nil
			end
		end
		if not nxt then error("not found: " .. path, 0) end
		cur = nxt
	end
	return cur
end

rf.OnClientInvoke = function(op, a, ...)
	if op == "ping" then
		return true
	elseif op == "invoke" then
		return resolve(a):InvokeServer(...)
	elseif op == "fire" then
		resolve(a):FireServer(...)
		return true
	elseif op == "get" then
		local prop = ...
		return resolve(a)[prop]
	elseif op == "attr" then
		return player:GetAttribute(a)
	elseif op == "moveTo" then
		local x, y, z = ...
		local hum = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
		if not hum then error("no humanoid", 0) end
		hum:MoveTo(Vector3.new(a, x, y))
		return true
	end
	error("unknown op " .. tostring(op), 0)
end
ready:FireServer()
`;

export const CLEANUP = `local SS = game:GetService("ServerStorage")
local f = SS:FindFirstChild("__BloxMp") if f then f:Destroy() end
SS:SetAttribute("BloxMpRun", nil)
local h = game:GetService("ServerScriptService"):FindFirstChild("__BloxMpHarness") if h then h:Destroy() end
local sps = game:GetService("StarterPlayer"):FindFirstChild("StarterPlayerScripts")
local c = sps and sps:FindFirstChild("__BloxMpClient") if c then c:Destroy() end
return true`;

// Edit-DataModel prep: clear any previous run, create the __BloxMp folder and
// the run config. The three scripts are created separately with Studio's
// multi_edit (mpScripts): since Studio's Sep 2026 capability sandbox the
// execute_luau thread may not parent scripts it creates.
export function installProgram(cfg: { clients: number; joinTimeout: number; token: string }): string {
  return `${CLEANUP.replace(/\nreturn true$/, '')}
local folder = Instance.new("Folder")
folder.Name = "__BloxMp"
folder.Parent = SS
SS:SetAttribute("BloxMpRun", ${longString(JSON.stringify(cfg))})
return true`;
}

export function mpScripts(specsSource: string): { path: string[]; className: string; source: string }[] {
  return [
    { path: ['ServerStorage', '__BloxMp', 'Specs'], className: 'ModuleScript', source: specsSource },
    { path: ['ServerScriptService', '__BloxMpHarness'], className: 'Script', source: HARNESS_SOURCE },
    { path: ['StarterPlayer', 'StarterPlayerScripts', '__BloxMpClient'], className: 'LocalScript', source: CLIENT_SOURCE },
  ];
}

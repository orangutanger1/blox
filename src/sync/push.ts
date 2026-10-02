import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { realSpawn, rojoBin, type SpawnFn } from './rojo.js';
import { longString } from '../studio/luau.js';
import { StudioError, resultText, type StudioSession } from '../studio/session.js';

// Direct file → Studio sync over execute_luau.
//
// The old path needed `rojo serve` AND a human clicking "Connect" in the Rojo
// Studio plugin every session; if nobody clicked, the agent's edits silently
// never reached Studio and its verify loop tested stale code. Here Rojo is only
// the *mapping oracle* (`rojo sourcemap` decides which file becomes which
// instance) and blox pushes the instances itself, so a sync is a deterministic,
// verifiable operation with a structured diff.
//
// Every instance blox creates carries the CollectionService tag "BloxManaged"
// plus attributes BloxKey (stable identity) and BloxHash (content hash). Only
// tagged instances are ever deleted, so hand-built or agent-built geometry in
// the place is never touched by a sync.
//
// World builders: `world/<Name>.luau` files return `function(model)` that
// populates a fresh Model named <Name> (default parent Workspace; first-line
// `-- @parent ServerStorage` overrides). They re-run only when their source
// changes, so maps/levels are code — versioned, diffable, reproducible.

export interface SourcemapNode {
  name: string;
  className: string;
  filePaths?: string[];
  children?: SourcemapNode[];
}

export interface DesiredInstance {
  key: string;
  path: string[]; // names from the DataModel child (service) down
  className: string;
  source?: string;
  value?: string;
  file?: string;
  hash: string;
  // Project-declared structural instance (StarterPlayerScripts, a $className
  // Model…): ensured to exist but never tagged, so a sync never deletes it.
  anchor?: boolean;
}

export interface WorldBuilder {
  key: string; // "world:<Name>"
  name: string;
  parent: string; // service name
  source: string;
  file: string;
  hash: string;
}

export interface SyncPlan {
  instances: DesiredInstance[];
  builders: WorldBuilder[];
  skipped: { file: string; reason: string }[];
}

export interface SyncResult {
  ok: boolean;
  created: string[];
  updated: string[];
  deleted: string[];
  unchanged: number;
  builders: { name: string; status: 'built' | 'unchanged' | 'error'; error?: string; parts?: number }[];
  skipped: { file: string; reason: string }[];
  errors: string[];
  durationMs: number;
}

const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript']);
const CONTAINER_CLASSES = new Set(['Folder', 'Model', 'Configuration', 'ScreenGui', 'Tool', 'Backpack']);

function sha(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

export async function readSourcemap(projectPath: string, spawn: SpawnFn = realSpawn): Promise<SourcemapNode> {
  const r = await spawn(rojoBin(), ['sourcemap', '--include-non-scripts'], { cwd: projectPath });
  if (r.code !== 0) {
    throw new StudioError('tool_error', `rojo sourcemap failed: ${(r.stderr || r.stdout).trim()}`, 'Fix default.project.json (or install rojo / set BLOX_ROJO_BIN).');
  }
  try {
    return JSON.parse(r.stdout) as SourcemapNode;
  } catch {
    throw new StudioError('tool_error', 'rojo sourcemap produced invalid JSON');
  }
}

// Luau table literal for a JSON value (Rojo maps *.json to a ModuleScript
// returning the decoded table).
export function jsonToLuau(v: unknown, indent = ''): string {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const next = indent + '\t';
  if (Array.isArray(v)) {
    if (v.length === 0) return '{}';
    return `{\n${v.map((x) => next + jsonToLuau(x, next)).join(',\n')}\n${indent}}`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, x]) => `${next}[${JSON.stringify(k)}] = ${jsonToLuau(x, next)}`).join(',\n')}\n${indent}}`;
}

function isProjectFile(p: string): boolean {
  return p.endsWith('.project.json');
}

export function planFromSourcemap(root: SourcemapNode, projectPath: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): SyncPlan {
  const instances: DesiredInstance[] = [];
  const skipped: SyncPlan['skipped'] = [];
  const walk = (node: SourcemapNode, path: string[], depth: number) => {
    const files = (node.filePaths ?? []).filter((f) => !f.endsWith('.meta.json'));
    if (depth >= 2) {
      const key = path.join('/');
      const fromProject = files.length === 0 || files.every(isProjectFile);
      const cls = node.className;
      if (SCRIPT_CLASSES.has(cls)) {
        const code = files.find((f) => /\.(luau|lua)$/i.test(f));
        const json = files.find((f) => f.endsWith('.json') && !isProjectFile(f) && !f.endsWith('.model.json'));
        if (code) {
          const source = read(join(projectPath, code));
          instances.push({ key, path, className: cls, source, file: code, hash: sha(`${cls}\0${source}`) });
        } else if (json && cls === 'ModuleScript') {
          let source: string;
          try {
            source = `return ${jsonToLuau(JSON.parse(read(join(projectPath, json))))}\n`;
          } catch (e) {
            skipped.push({ file: json, reason: `invalid JSON: ${(e as Error).message}` });
            return;
          }
          instances.push({ key, path, className: cls, source, file: json, hash: sha(`${cls}\0${source}`) });
        } else {
          skipped.push({ file: files[0] ?? key, reason: `no source file for ${cls}` });
          return;
        }
      } else if (cls === 'StringValue' && files.some((f) => f.endsWith('.txt'))) {
        const f = files.find((x) => x.endsWith('.txt'))!;
        const value = read(join(projectPath, f));
        instances.push({ key, path, className: cls, value, file: f, hash: sha(`${cls}\0${value}`) });
      } else if (cls === 'Folder') {
        instances.push({ key, path, className: cls, hash: sha(cls) });
      } else if (fromProject || (CONTAINER_CLASSES.has(cls) && files.length === 0)) {
        instances.push({ key, path, className: cls, hash: sha(cls), anchor: true });
      } else {
        // .model.json / .rbxm(x) / .csv etc: properties can't be applied here.
        skipped.push({ file: files[0] ?? key, reason: `${cls} from ${files[0] ?? 'project'} is not supported by blox sync — build it with a world/ builder instead` });
        return;
      }
    }
    for (const child of node.children ?? []) walk(child, [...path, child.name], depth + 1);
  };
  walk(root, [], 0);
  return { instances, builders: [], skipped };
}

const PARENT_RE = /^--\s*@parent\s+([A-Za-z]+)/;

export function planWorldBuilders(projectPath: string, worldDir = 'world'): WorldBuilder[] {
  const dir = join(projectPath, worldDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => /\.(luau|lua)$/i.test(f))
    .sort()
    .map((f) => {
      const file = join(dir, f);
      const source = readFileSync(file, 'utf8');
      const name = f.replace(/\.(luau|lua)$/i, '');
      const parent = PARENT_RE.exec(source.split('\n', 1)[0] ?? '')?.[1] ?? 'Workspace';
      return { key: `world:${name}`, name, parent, source, file: relative(projectPath, file), hash: sha(`${parent}\0${source}`) };
    });
}

const INVENTORY_LUAU = `local CS = game:GetService("CollectionService")
local out = {}
for _, inst in CS:GetTagged("BloxManaged") do
	local k = inst:GetAttribute("BloxKey")
	if typeof(k) == "string" then out[k] = { hash = inst:GetAttribute("BloxHash") or "", cls = inst.ClassName } end
end
return game:GetService("HttpService"):JSONEncode(out)`;

// Applies upserts/deletes/builders described by the JSON payload P.
const APPLY_LUAU = `local HS = game:GetService("HttpService")
local CS = game:GetService("CollectionService")
local SES = game:GetService("ScriptEditorService")
local P = HS:JSONDecode(PAYLOAD)
local res = { created = {}, updated = {}, deleted = {}, builders = {}, errors = {}, needCreate = {} }
local SCRIPT_CLASS = { Script = true, LocalScript = true, ModuleScript = true }
-- Builders run as loadstring chunks, which may not require() place modules
-- (capability sandbox); load module source instead, memoized per sync.
local fresh = {}
local function freshRequire(m)
	if typeof(m) ~= "Instance" or not m:IsA("ModuleScript") then return require(m) end
	local hit = fresh[m]
	if hit ~= nil then
		if hit == fresh then error("cyclic require of " .. m:GetFullName(), 2) end
		return hit
	end
	fresh[m] = fresh
	local fn, err = loadstring(m.Source, "=" .. m:GetFullName())
	if not fn then fresh[m] = nil error(err, 2) end
	setfenv(fn, setmetatable({ script = m, require = freshRequire }, { __index = getfenv(0) }))
	local ok, r = pcall(fn)
	if not ok then fresh[m] = nil error(r, 0) end
	fresh[m] = r
	return r
end
-- One undo step per sync (Ctrl+Z in Studio reverts it), when recording is available.
local CHS = game:GetService("ChangeHistoryService")
local rec
pcall(function() rec = CHS:TryBeginRecording("blox sync") end)
local byKey = {}
for _, inst in CS:GetTagged("BloxManaged") do
	local k = inst:GetAttribute("BloxKey")
	if typeof(k) == "string" then byKey[k] = inst end
end
local function mark(inst, key, hash)
	inst:SetAttribute("BloxKey", key)
	inst:SetAttribute("BloxHash", hash)
	CS:AddTag(inst, "BloxManaged")
	byKey[key] = inst
end
local function setSource(inst, src)
	local ok = pcall(function() SES:UpdateSourceAsync(inst, function() return src end) end)
	if not ok or inst.Source ~= src then inst.Source = src end
end
local function parentFor(path)
	local cur = game:GetService(path[1])
	for i = 2, #path - 1 do
		local key = table.concat(path, "/", 1, i)
		local nxt = byKey[key] or cur:FindFirstChild(path[i])
		if not nxt then
			nxt = Instance.new("Folder")
			nxt.Name = path[i]
			nxt.Parent = cur
		end
		cur = nxt
	end
	return cur
end
for _, d in P.upserts do
	local ok, err = pcall(function()
		local parent = parentFor(d.path)
		local name = d.path[#d.path]
		if d.anchor then
			if not parent:FindFirstChild(name) then
				local a = Instance.new(d.className)
				a.Name = name
				a.Parent = parent
				table.insert(res.created, d.key .. " (anchor)")
			end
			return
		end
		local inst = byKey[d.key]
		local adopted = false
		if not inst then
			local c = parent:FindFirstChild(name)
			if c and c.ClassName == d.className then inst = c adopted = true end
		end
		local created = d.fresh == true
		if SCRIPT_CLASS[d.className] and (not inst or inst.ClassName ~= d.className) then
			-- This thread may not parent a script it creates (Studio capability
			-- sandbox); the caller creates it with multi_edit and re-applies.
			if inst then inst:Destroy() byKey[d.key] = nil end
			table.insert(res.needCreate, { key = d.key, path = d.path, className = d.className })
			return
		end
		if inst and inst.ClassName ~= d.className then
			local fresh = Instance.new(d.className)
			for _, ch in inst:GetChildren() do ch.Parent = fresh end
			inst:Destroy()
			inst = fresh
			created = true
		elseif not inst then
			inst = Instance.new(d.className)
			created = true
		end
		inst.Name = name
		if d.source ~= nil then setSource(inst, d.source) end
		if d.value ~= nil then inst.Value = d.value end
		if inst.Parent ~= parent then inst.Parent = parent end
		mark(inst, d.key, d.hash)
		table.insert(created and res.created or res.updated, d.key .. ((adopted and not d.fresh) and " (adopted)" or ""))
	end)
	if not ok then table.insert(res.errors, d.key .. ": " .. tostring(err)) end
end
for _, b in P.builders do
	local entry = { name = b.name, status = "built" }
	local ok, err = pcall(function()
		local parent = game:GetService(b.parent)
		local old = byKey[b.key]
		if old then old:Destroy() end
		local stale = parent:FindFirstChild(b.name)
		if stale and stale:GetAttribute("BloxKey") == b.key then stale:Destroy() end
		local fn, cerr = loadstring(b.source, "=" .. b.file)
		if not fn then error("compile: " .. tostring(cerr), 0) end
		setfenv(fn, setmetatable({ require = freshRequire }, { __index = getfenv(0) }))
		local builder = fn()
		if typeof(builder) ~= "function" then error(b.file .. " must return function(model)", 0) end
		local model = Instance.new("Model")
		model.Name = b.name
		local bok, berr = pcall(builder, model)
		if not bok then model:Destroy() error(tostring(berr), 0) end
		model.Parent = parent
		mark(model, b.key, b.hash)
		local n = 0
		for _, x in model:GetDescendants() do if x:IsA("BasePart") then n += 1 end end
		entry.parts = n
	end)
	if not ok then entry.status = "error" entry.error = tostring(err) end
	table.insert(res.builders, entry)
end
for _, key in P.deletes do
	local inst = byKey[key]
	if inst and inst.Parent then
		inst:Destroy()
		table.insert(res.deleted, key)
	end
end
if rec then pcall(function() CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end) end
return HS:JSONEncode(res)`;

const BATCH_BYTES = 1_500_000;

export interface PushOptions {
  spawn?: SpawnFn;
  worldDir?: string;
  force?: boolean; // re-push everything and rebuild every world builder
}

export async function buildPlan(projectPath: string, opts: PushOptions = {}): Promise<SyncPlan> {
  const sm = await readSourcemap(projectPath, opts.spawn);
  const plan = planFromSourcemap(sm, projectPath);
  plan.builders = planWorldBuilders(projectPath, opts.worldDir);
  return plan;
}

async function luauJson<T>(session: StudioSession, code: string): Promise<T> {
  const r = await session.call('execute_luau', { code, datamodel_type: 'Edit' });
  const text = resultText(r);
  if (r.isError) {
    if (/not available in Play mode/i.test(text)) {
      throw new StudioError('wrong_mode', 'Cannot sync while a playtest is running.', 'Stop the playtest first (play {action:"stop"}); sync only targets the edit DataModel.');
    }
    throw new StudioError('tool_error', `sync execute_luau failed: ${text.slice(0, 1000)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new StudioError('tool_error', `sync returned non-JSON: ${text.slice(0, 500)}`);
  }
}

// Pure diff: what must change in Studio to match the plan.
export function diffPlan(plan: SyncPlan, inventory: Record<string, { hash: string; cls: string }>, force = false) {
  const desiredKeys = new Set([...plan.instances.map((i) => i.key), ...plan.builders.map((b) => b.key)]);
  const upserts = plan.instances
    .filter((i) => i.anchor || force || inventory[i.key]?.hash !== i.hash || inventory[i.key]?.cls !== i.className)
    .sort((a, b) => a.path.length - b.path.length);
  const builders = plan.builders.filter((b) => force || inventory[b.key]?.hash !== b.hash);
  // Deepest first so a parent's destroy doesn't orphan the report of a child.
  const deletes = Object.keys(inventory)
    .filter((k) => !desiredKeys.has(k))
    .sort((a, b) => b.split('/').length - a.split('/').length);
  const unchanged = plan.instances.filter((i) => !i.anchor).length - upserts.filter((i) => !i.anchor).length;
  return { upserts, builders, deletes, unchanged, unchangedBuilders: plan.builders.length - builders.length };
}

// Creates an empty script at path via Studio's multi_edit (scripts it creates
// get normal capabilities). Returns an error message, or null on success.
async function createScript(session: StudioSession, path: string[], className: string): Promise<string | null> {
  if (path.some((p) => p.includes('.'))) return `cannot create a script whose path contains "." (${path.join('/')}) — rename it`;
  const r = await session.call('multi_edit', {
    file_path: `game.${path.join('.')}`,
    className,
    datamodel_type: 'Edit',
    edits: [{ old_string: '', new_string: '-- blox sync\n' }],
  });
  return r.isError ? `multi_edit failed: ${resultText(r).slice(0, 300)}` : null;
}

export async function pushProject(session: StudioSession, projectPath: string, opts: PushOptions = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const plan = await buildPlan(projectPath, opts);
  const inventory = await luauJson<Record<string, { hash: string; cls: string }>>(session, INVENTORY_LUAU);
  const d = diffPlan(plan, Array.isArray(inventory) ? {} : inventory, opts.force);

  const result: SyncResult = {
    ok: true, created: [], updated: [], deleted: [], unchanged: d.unchanged,
    builders: plan.builders.filter((b) => !d.builders.includes(b)).map((b) => ({ name: b.name, status: 'unchanged' as const })),
    skipped: plan.skipped, errors: [], durationMs: 0,
  };

  type ApplyResult = { created?: string[]; updated?: string[]; deleted?: string[]; builders?: SyncResult['builders']; errors?: string[]; needCreate?: { key: string; path: string[]; className: string }[] };
  const apply = async (upserts: (DesiredInstance & { fresh?: boolean })[], builders: WorldBuilder[], deletes: string[]) => {
    const payload = {
      upserts: upserts.map(({ key, path, className, source, value, hash, anchor, fresh }) => ({ key, path, className, source, value, hash, anchor, fresh })),
      builders: builders.map(({ key, name, parent, source, file, hash }) => ({ key, name, parent, source, file, hash })),
      deletes,
    };
    const r = await luauJson<ApplyResult>(session, `local PAYLOAD = ${longString(JSON.stringify(payload))}\n${APPLY_LUAU}`);
    result.created.push(...(r.created ?? []));
    result.updated.push(...(r.updated ?? []));
    result.deleted.push(...(r.deleted ?? []));
    result.builders.push(...(r.builders ?? []));
    result.errors.push(...(r.errors ?? []));
    return r.needCreate ?? [];
  };

  // Batch upserts by payload size. New scripts come back as needCreate: the
  // execute_luau thread may not parent scripts it creates (Studio capability
  // sandbox, Sep 2026), so they are created with multi_edit and re-applied.
  // Builders + deletes run last so builders see every freshly-synced module.
  const batches: DesiredInstance[][] = [[]];
  let size = 0;
  for (const u of d.upserts) {
    const s = (u.source?.length ?? 0) + (u.value?.length ?? 0) + 200;
    if (size + s > BATCH_BYTES && batches[batches.length - 1].length > 0) {
      batches.push([]);
      size = 0;
    }
    batches[batches.length - 1].push(u);
    size += s;
  }
  for (const batch of batches) {
    if (!batch.length) continue;
    const need = await apply(batch, [], []);
    const made: (DesiredInstance & { fresh: boolean })[] = [];
    for (const n of need) {
      const u = batch.find((x) => x.key === n.key);
      if (!u) continue;
      const err = await createScript(session, n.path, n.className);
      if (err) result.errors.push(`${n.key}: ${err}`);
      else made.push({ ...u, fresh: true });
    }
    if (made.length) await apply(made, [], []);
  }
  if (d.builders.length || d.deletes.length) await apply([], d.builders, d.deletes);
  result.ok = result.errors.length === 0 && result.builders.every((b) => b.status !== 'error');
  result.durationMs = Date.now() - t0;
  return result;
}

export function formatSyncResult(r: SyncResult): string {
  const lines = [`sync ${r.ok ? 'ok' : 'FAILED'} (${r.durationMs}ms): +${r.created.length} created, ~${r.updated.length} updated, -${r.deleted.length} deleted, ${r.unchanged} unchanged`];
  for (const k of r.created) lines.push(`  + ${k}`);
  for (const k of r.updated) lines.push(`  ~ ${k}`);
  for (const k of r.deleted) lines.push(`  - ${k}`);
  for (const b of r.builders) {
    if (b.status !== 'unchanged') lines.push(`  world ${b.name}: ${b.status}${b.parts !== undefined ? ` (${b.parts} parts)` : ''}${b.error ? ` — ${b.error}` : ''}`);
  }
  for (const s of r.skipped) lines.push(`  skipped ${s.file}: ${s.reason}`);
  for (const e of r.errors) lines.push(`  ERROR ${e}`);
  return lines.join('\n');
}

// Read-only drift check: what a sync WOULD change (no writes to Studio).
export async function syncDrift(session: StudioSession, projectPath: string, opts: PushOptions = {}) {
  const plan = await buildPlan(projectPath, opts);
  const inventory = await luauJson<Record<string, { hash: string; cls: string }>>(session, INVENTORY_LUAU);
  const d = diffPlan(plan, Array.isArray(inventory) ? {} : inventory);
  return {
    pending: d.upserts.filter((u) => !u.anchor).map((u) => u.key),
    builders: d.builders.map((b) => b.name),
    deletes: d.deletes,
    skipped: plan.skipped,
  };
}

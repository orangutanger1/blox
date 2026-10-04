import type { StudioSession } from '../studio/session.js';
import { longString, runLuau } from '../studio/luau.js';
import { loadManifest, saveManifest, type AssetManifest } from './manifest.js';

// ref.path is where an asset sat when blox last looked; agents rename and move
// things. Each placed asset carries a CollectionService tag (ref.tag), and its
// path is re-read from the tag before blox relies on it. Entries recorded
// before tags existed get one from their path the first time it resolves.

export const assetTag = (id: string): string => `BloxAsset_${id}`;

// Lua resolver for a dot path; `error`s with "not found: <path>".
export const RESOLVE = `local function resolve(p)
	local cur = game
	for name in string.gmatch(p, "[^%.]+") do
		if cur == game and name == "game" then continue end
		local nxt = cur:FindFirstChild(name)
		if not nxt and cur == game then
			local ok, svc = pcall(function() return game:GetService(name) end)
			nxt = ok and svc or nil
		end
		if not nxt then error("not found: " .. p, 0) end
		cur = nxt
	end
	return cur
end`;

export interface LocateItem {
  id: string;
  tag: string;
  path?: string;
}

export function locateProgram(items: LocateItem[]): string {
  return `-- BLOX_LOCATE
local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
${RESOLVE}
local out = {}
for _, it in HttpService:JSONDecode(${longString(JSON.stringify(items))}) do
	local found, tagged = {}, false
	for _, x in CollectionService:GetTagged(it.tag) do table.insert(found, x:GetFullName()) end
	if #found == 0 and it.path then
		local ok, x = pcall(resolve, it.path)
		if ok and x ~= game and x.Parent ~= game then
			x:AddTag(it.tag)
			table.insert(found, x:GetFullName())
			tagged = true
		end
	end
	out[it.id] = { paths = found, tagged = tagged }
end
return HttpService:JSONEncode({ result = out })`;
}

export const locateItems = (m: AssetManifest, ids?: string[]): LocateItem[] =>
  m.assets
    .filter((a) => (a.ref.path || a.ref.tag) && (!ids || ids.includes(a.id)))
    .map((a) => ({ id: a.id, tag: a.ref.tag ?? assetTag(a.id), ...(a.ref.path ? { path: a.ref.path } : {}) }));

function commonAncestor(paths: string[]): string {
  const parts = paths.map((p) => p.split('.'));
  const out: string[] = [];
  for (let i = 0; parts.every((p) => i < p.length - 1 && p[i] === parts[0][i]); i++) out.push(parts[0][i]);
  return out.join('.');
}

// Updates ref.path/ref.tag in place; returns one note per change.
export function applyLocate(m: AssetManifest, raw: unknown): string[] {
  const parsed = JSON.parse(String(raw)) as { result: Record<string, { paths: string[]; tagged: boolean }> | unknown[] };
  const result = Array.isArray(parsed.result) ? {} : parsed.result;
  const notes: string[] = [];
  for (const [id, r] of Object.entries(result)) {
    const e = m.assets.find((a) => a.id === id);
    if (!e) continue;
    const paths = r.paths.map((p) => p.replace(/^game\./, ''));
    if (!paths.length) {
      // Tagged once and no instance carries the tag now: it was deleted.
      if (e.ref.tag && e.ref.path) {
        notes.push(`${id}: no longer in the place (was ${e.ref.path})`);
        delete e.ref.path;
      } else if (e.ref.path) notes.push(`${id}: not found at ${e.ref.path} — if it was renamed or moved, asset {action:"relink", id:"${id}", path:"<where it is now>"}`);
      continue;
    }
    if (!e.ref.tag) {
      e.ref.tag = assetTag(id);
      if (r.tagged) notes.push(`${id}: tagged ${e.ref.tag}`);
    }
    const now = e.ref.path && paths.includes(e.ref.path) ? e.ref.path : paths.length === 1 ? paths[0] : commonAncestor(paths) || paths[0];
    if (now !== e.ref.path) {
      notes.push(`${id}: ${e.ref.path ?? '(no path)'} → ${now}`);
      e.ref.path = now;
    }
  }
  return notes;
}

// Re-reads where tracked assets are (all of them, or `ids`) and saves the manifest.
export async function refreshRefs(session: StudioSession, P: string, ids?: string[]): Promise<string[]> {
  const items = locateItems(loadManifest(P), ids);
  if (!items.length) return [];
  const r = await runLuau(session, locateProgram(items), 'edit', { chunkName: 'assetLocate' });
  if (!r.ok) throw new Error(`locate failed: ${r.error?.message}`);
  const m = loadManifest(P);
  const notes = applyLocate(m, r.values[0]);
  saveManifest(P, m);
  return notes;
}

// Points an entry at the instance now at `path` (for entries whose path went
// stale before they were tagged): the tag moves there and the path is re-read.
export async function relinkAsset(session: StudioSession, P: string, id: string, path: string): Promise<string[]> {
  const e = loadManifest(P).assets.find((a) => a.id === id);
  if (!e) throw new Error(`no asset "${id}" in .blox/assets.json`);
  const tag = e.ref.tag ?? assetTag(id);
  const r = await runLuau(session, `-- BLOX_RELINK
local CollectionService = game:GetService("CollectionService")
${RESOLVE}
local target = resolve(${longString(path.replace(/^game\./, ''))})
if target == game or target.Parent == game then error("relink needs an instance, not a service", 0) end
for _, x in CollectionService:GetTagged(${longString(tag)}) do x:RemoveTag(${longString(tag)}) end
target:AddTag(${longString(tag)})
return "ok"`, 'edit', { chunkName: 'assetRelink' });
  if (!r.ok) throw new Error(`relink failed: ${r.error?.message}`);
  return refreshRefs(session, P, [id]);
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StudioSession } from '../studio/session.js';
import { longString, runLuau } from '../studio/luau.js';
import { loadManifest, saveManifest, type AssetEntry } from './manifest.js';
import { assetTag, refreshRefs, RESOLVE } from './locate.js';

// Adopted packs live only in the place file; Rojo and blox sync rebuild from
// files. `asset save` writes each one (every instance carrying its tag) to
// assets/packs/<id>.rbxm with SerializationService, and sync puts back any
// pack whose tag is missing from the place.

export const PACK_DIR = 'assets/packs';
// execute_luau replies past ~50KB get cut off; requests carry the same size.
const CHUNK = 40_000;

const packFile = (id: string) => `${PACK_DIR}/${id}.rbxm`;
const isPackFile = (f: string | undefined) => !!f && f.endsWith('.rbxm') && f.startsWith(`${PACK_DIR}/`);

// Placed Creator Store / imported models (not uploads of our own files).
export const packEntries = (assets: AssetEntry[]): AssetEntry[] =>
  assets.filter((a) => a.kind === 'model' && a.status !== 'rejected' && a.ref.path && !a.uploaded && (!a.ref.file || isPackFile(a.ref.file)));

async function luau(session: StudioSession, code: string, chunkName: string): Promise<unknown> {
  const r = await runLuau(session, code, 'edit', { chunkName, timeoutMs: 120_000 });
  if (!r.ok) throw new Error(r.error?.message ?? `${chunkName} failed`);
  return r.values[0];
}

export async function savePack(session: StudioSession, P: string, id: string, refresh = true): Promise<{ file: string; bytes: number; instances: number }> {
  if (refresh) await refreshRefs(session, P, [id]);
  const e = loadManifest(P).assets.find((a) => a.id === id);
  if (!e) throw new Error(`no asset "${id}" in .blox/assets.json`);
  if (!e.ref.path || !e.ref.tag) throw new Error(`"${id}" is not in the place (no tagged instance) — nothing to save`);
  const tag = longString(e.ref.tag);
  const head = JSON.parse(String(await luau(session, `-- BLOX_PACK_SAVE
local S = game:GetService("SerializationService")
local E = game:GetService("EncodingService")
local TAG = ${tag}
local list = game:GetService("CollectionService"):GetTagged(TAG)
if #list == 0 then error("no instance carries the tag", 0) end
_G.__bloxPackOut = _G.__bloxPackOut or {}
local s = buffer.tostring(E:Base64Encode(S:SerializeInstancesAsync(list)))
_G.__bloxPackOut[TAG] = s
return game:GetService("HttpService"):JSONEncode({ len = #s, n = #list })`, 'packSave'))) as { len: number; n: number };
  let b64 = '';
  try {
    for (let i = 0; i < head.len; i += CHUNK) {
      b64 += String(await luau(session, `local TAG = ${tag}\nreturn string.sub(_G.__bloxPackOut[TAG], ${i + 1}, ${i + CHUNK})`, 'packRead'));
    }
  } finally {
    await luau(session, `local TAG = ${tag}\nif _G.__bloxPackOut then _G.__bloxPackOut[TAG] = nil end return "ok"`, 'packFree');
  }
  if (b64.length !== head.len) throw new Error(`read ${b64.length} of ${head.len} base64 chars`);
  const bytes = Buffer.from(b64, 'base64');
  const file = packFile(id);
  mkdirSync(dirname(join(P, file)), { recursive: true });
  writeFileSync(join(P, file), bytes);
  const m = loadManifest(P);
  m.assets.find((a) => a.id === id)!.ref.file = file;
  saveManifest(P, m);
  return { file, bytes: bytes.length, instances: head.n };
}

// Saves every placed pack; one failure does not stop the rest.
export async function saveAllPacks(session: StudioSession, P: string): Promise<{ saved: string[]; errors: string[] }> {
  await refreshRefs(session, P);
  const saved: string[] = [];
  const errors: string[] = [];
  for (const e of packEntries(loadManifest(P).assets)) {
    try {
      const r = await savePack(session, P, e.id, false);
      saved.push(`${e.id} → ${r.file} (${r.instances} instance(s), ${Math.round(r.bytes / 1024)} KB)`);
    } catch (err) {
      errors.push(`${e.id}: ${(err as Error).message}`);
    }
  }
  return { saved, errors };
}

// Sync step: put back every saved pack none of whose instances is in the place.
// Runs before world builders, which often clone parts out of packs.
export async function restorePacks(session: StudioSession, P: string): Promise<{ restored: string[]; errors: string[] }> {
  let assets: AssetEntry[];
  try {
    assets = loadManifest(P).assets;
  } catch {
    return { restored: [], errors: [] };
  }
  const saved = assets.filter((a) => a.ref.path && isPackFile(a.ref.file) && existsSync(join(P, a.ref.file!)));
  if (!saved.length) return { restored: [], errors: [] };
  const tags = saved.map((a) => a.ref.tag ?? assetTag(a.id));
  const present = JSON.parse(String(await luau(session, `local CS = game:GetService("CollectionService")
local out = {}
for _, t in game:GetService("HttpService"):JSONDecode(${longString(JSON.stringify(tags))}) do table.insert(out, #CS:GetTagged(t) > 0) end
return game:GetService("HttpService"):JSONEncode(out)`, 'packCheck'))) as boolean[];
  const restored: string[] = [];
  const errors: string[] = [];
  for (const [i, e] of saved.entries()) {
    if (present[i]) continue;
    try {
      const b64 = readFileSync(join(P, e.ref.file!)).toString('base64');
      await luau(session, `_G.__bloxPackIn = "" return "ok"`, 'packStart');
      for (let k = 0; k < b64.length; k += CHUNK) {
        await luau(session, `_G.__bloxPackIn ..= ${longString(b64.slice(k, k + CHUNK))} return "ok"`, 'packWrite');
      }
      const path = e.ref.path!;
      const parent = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : path;
      const where = String(await luau(session, `-- BLOX_PACK_RESTORE
${RESOLVE}
local data = _G.__bloxPackIn
_G.__bloxPackIn = nil
local list = game:GetService("SerializationService"):DeserializeInstancesAsync(game:GetService("EncodingService"):Base64Decode(buffer.fromstring(data)))
-- one saved instance sat at ref.path; several (an unpacked GUI pack) sat under it
local dst = resolve(#list == 1 and ${longString(parent)} or ${longString(path)})
local out = {}
for _, x in list do
	x:AddTag(${longString(e.ref.tag ?? assetTag(e.id))})
	x.Parent = dst
	table.insert(out, x:GetFullName())
end
return table.concat(out, ", ")`, 'packRestore'));
      restored.push(`${e.id} → ${where}`);
    } catch (err) {
      errors.push(`pack ${e.id}: ${(err as Error).message}`);
    }
  }
  return { restored, errors };
}

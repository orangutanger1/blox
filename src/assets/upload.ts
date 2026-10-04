import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { NO_KEY, OpenCloud, openCloudKey } from '../opencloud/client.js';
import { loadManifest, saveManifest, type AssetEntry } from './manifest.js';

// Upload = publishing content to Roblox (moderated, public-facing). Three gates:
// the entry is approved by a human (CLI-only `blox asset approve`), the caller
// passes confirm, and a human-created API key is in the environment.

const TYPES: Record<string, { assetType: string; contentType: string }> = {
  '.fbx': { assetType: 'Model', contentType: 'model/fbx' },
  '.glb': { assetType: 'Model', contentType: 'model/gltf-binary' },
  '.gltf': { assetType: 'Model', contentType: 'model/gltf+json' },
  '.rbxm': { assetType: 'Model', contentType: 'model/x-rbxm' },
  '.png': { assetType: 'Decal', contentType: 'image/png' },
  '.jpg': { assetType: 'Decal', contentType: 'image/jpeg' },
  '.jpeg': { assetType: 'Decal', contentType: 'image/jpeg' },
  '.bmp': { assetType: 'Decal', contentType: 'image/bmp' },
  '.tga': { assetType: 'Decal', contentType: 'image/tga' },
  '.mp3': { assetType: 'Audio', contentType: 'audio/mpeg' },
  '.ogg': { assetType: 'Audio', contentType: 'audio/ogg' },
  '.wav': { assetType: 'Audio', contentType: 'audio/wav' },
  '.flac': { assetType: 'Audio', contentType: 'audio/flac' },
};

export interface UploadPlan {
  id: string;
  file: string;
  assetType: string;
  contentType: string;
  displayName: string;
  description: string;
  creator: { userId?: number; groupId?: number };
}

export function planUpload(projectPath: string, id: string): { plan: UploadPlan; entry: AssetEntry } {
  const m = loadManifest(projectPath);
  const entry = m.assets.find((a) => a.id === id);
  if (!entry) throw new Error(`unknown asset "${id}"`);
  if (entry.status !== 'approved') throw new Error(`"${id}" is ${entry.status}: a human must approve it first (run \`blox asset approve ${id}\` in a terminal)`);
  if (!entry.ref.file) throw new Error(`"${id}" has no ref.file to upload`);
  const file = join(projectPath, entry.ref.file);
  if (!existsSync(file)) throw new Error(`file not found: ${entry.ref.file}`);
  const found = TYPES[extname(file).toLowerCase()];
  if (!found) throw new Error(`unsupported upload type ${extname(file)} (supported: ${Object.keys(TYPES).join(' ')})`);
  // A KeyframeSequence .rbxm goes up as an Animation, not a Model.
  const t = entry.kind === 'animation' && extname(file).toLowerCase() === '.rbxm' ? { ...found, assetType: 'Animation' } : found;
  if (!m.creator?.userId && !m.creator?.groupId) throw new Error('set "creator": {"userId": N} or {"groupId": N} in .blox/assets.json');
  return {
    entry,
    plan: { id, file: entry.ref.file, ...t, displayName: id.slice(0, 50), description: `${entry.kind} (${entry.source}, ${entry.licence}) via blox`, creator: m.creator },
  };
}

export async function uploadAsset(projectPath: string, id: string, o: { confirm?: boolean; client?: OpenCloud; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ dryRun: true; plan: UploadPlan } | { dryRun: false; assetId: number; operation: string; assetType: string }> {
  const { plan } = planUpload(projectPath, id);
  if (!o.confirm) return { dryRun: true, plan };
  if (!o.client && !openCloudKey()) throw new Error(NO_KEY);
  const client = o.client ?? new OpenCloud();
  const op = await client.uploadAsset({ ...plan, file: readFileSync(join(projectPath, plan.file)), fileName: basename(plan.file) });
  const res = op.done ? op.response ?? {} : await client.waitOperation(op.path, { sleep: o.sleep });
  const assetId = Number(res.assetId);
  if (!Number.isFinite(assetId) || assetId <= 0) throw new Error(`upload finished without an assetId (operation ${op.path})`);
  const m = loadManifest(projectPath);
  const e = m.assets.find((a) => a.id === id)!;
  e.uploaded = { assetId, operation: op.path, at: new Date().toISOString() };
  e.ref.assetId = assetId;
  saveManifest(projectPath, m);
  return { dryRun: false, assetId, operation: op.path, assetType: plan.assetType };
}

// After a Decal upload: point ref.assetId at the Image inside it.
export function recordImageId(projectPath: string, id: string, imageId: number): void {
  const m = loadManifest(projectPath);
  const e = m.assets.find((a) => a.id === id);
  if (!e?.uploaded) throw new Error(`"${id}" has not been uploaded`);
  e.uploaded.imageId = imageId;
  e.ref.assetId = imageId;
  saveManifest(projectPath, m);
}

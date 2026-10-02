# Asset manifest + pipeline (pipeline item 7)

Research §H.1/§R.7: assets need provenance and licence records, free models hide
backdoors, and external meshes need normalising before upload. Spending credits,
final art sign-off and uploading are human decisions — they stay gates.

## `.blox/assets.json`
```
{ version: 1, creator?: { userId? | groupId? },
  assets: [{ id, kind: model|mesh|image|audio|animation,
             source: code|creator-store|generated|external,
             licence: roblox-creator-store|owned|generated-roblox|cc0|cc-by|proprietary|unknown,
             attribution?, ref: { assetId?, path?, file?, tag? },
             provenance: { tool, prompt?, url?, createdAt },
             sanitized?: { at, scriptsRemoved, findings[] },
             budget?: { tris?, parts? },
             status: candidate|approved|rejected,           // approval is human-only (CLI)
             uploaded?: { assetId, operation, at } }] }
```

## Tool `asset` (MCP + CLI)
- `list`, `add {entry}` (validated; status forced to `candidate`)
- `sanitize {path, id?, keep_scripts?}` — edit-context scan of an inserted model:
  every script with risk findings (`require(<number>)` remote modules, `getfenv/setfenv`,
  `loadstring`, `HttpService`, `TeleportService`, `InsertService`, `MarketplaceService`
  prompts, `:Kick(`, `string.char`/`\ddd` obfuscation, very long lines); scripts are
  removed unless `keep_scripts`; part/MeshPart/texture counts. Recorded on the entry
  (created as `creator-store` if `id` is new).
- `scan` — every asset id the place references (MeshId, TextureID/Texture/Image,
  SoundId, AnimationId) vs the manifest → `untracked` findings.
- `lint` — `asset:<rule>` synthetic tests: `licence` (no unknown; cc-by needs
  attribution), `provenance`, `sanitized` (creator-store entries), `budget` (tris > 20k
  error, > 10k warn; parts > 5000 warn), `rejected` (rejected assets still referenced by
  path), `untracked` (from the last scan, warn).
- `normalize {file, out?, tris?=10000, height?}` — `blender -b --python
  assets/normalize.py -- in out tris height` (BLOX_BLENDER overrides the binary):
  apply transforms, scale to height studs, pivot at base centre, decimate to the triangle
  budget, export FBX; records `budget.tris` from Blender's report.
- `upload {id, confirm}` — Open Cloud Assets API (`POST /assets/v1/assets`, multipart;
  poll the operation). Refused unless the entry is **approved** (`blox asset approve <id>`,
  CLI only — not exposed over MCP), `confirm: true`, and `ROBLOX_OPEN_CLOUD_KEY` +
  `creator` are set. Without confirm it prints the exact request (dry run).

`src/opencloud/client.ts` (shared with item 8): key from env, injectable `fetch`,
`uploadAsset`, `getOperation`, typed errors.

## Verification
Manifest/lint/sanitizer findings unit-tested; scan/sanitize Luau compile under Lune and
run against the fake Studio; normalize command construction + missing-Blender error;
`normalize.py` byte-compiles; upload tested with a fake fetch only (never real keys).
Live smoke pending: sanitize a real Creator Store model, Blender normalize, a human-run
upload.

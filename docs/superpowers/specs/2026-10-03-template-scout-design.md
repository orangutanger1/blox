# Template scout

Status: self-approved design (unattended run 2026-10-03; decisions recorded
below). Queue item 2 after spec C.

## Goal

Before the agent builds a map, a UI or a big prop from scratch, it can find
free Creator Store templates/packs, look inside the best ones safely, and
decide adapt-vs-build with evidence — with licence and provenance recorded in
`.blox/assets.json`. Free assets only; nothing is bought or uploaded.

## Live facts (probed 2026-10-03, ~/blox-fw)

- `search_asset {query, scope:"creator_store", priceFilter:"free", maxResults}`
  returns `{status, results:[{assetId (string), name, description, creatorName,
  assetType, isFree, priceCents, creatorStoreUrl, thumbnailUrl, source}],
  availableFacets}`.
- `insert_asset {assetId, assetType, assetName, parentPath}` returns
  `{status, insertedInstances:[{fullPath, name, className}]}`. Inserting into
  `ServerStorage` works; scripts there never run, so it is a safe quarantine.

## Tool: `scout`

| Call | Does |
|---|---|
| `search {need, kind, max?=8}` | 2–3 query variants per kind → `search_asset` (creator_store, free) → merge, drop non-free, dedupe, rank. Saves `.blox/scout/<need>-<kind>.json`. |
| `try {asset_id, id}` | asset_id must be in a saved search (proves free + gives provenance). Inserts into `ServerStorage.BloxScout`, inspects it (scripts + risk findings, parts, MeshParts, GUIs, size, sounds), records a manifest candidate, returns an adapt-vs-build verdict. Scripts are left in place (quarantine). |
| `adopt {id, to, keep_scripts?, unpack?}` | Strips scripts (unless keep_scripts, refused when risks were found), moves the copy (or its children with `unpack`) from quarantine to `to`, records `sanitized` + new path. |
| `discard {id}` | Destroys the quarantine copy, marks the manifest entry rejected and clears its path. |

`kind`: `map | ui | model | audio | image`. Query variants:
map → `<need> map template`, `<need> map`, `<need> kit`; ui → `<need> ui`,
`<need> gui pack`, `<need> ui template`; model → `<need>`, `<need> pack`;
audio → `<need>` (assetType Audio); image → `<need>`, `<need> icon`
(assetType Image).

Ranking (pure): +2 per query that returned the asset, +1 per need word in the
name, +1 if the name has a kind word (template, kit, pack, map, ui, gui, hud),
ties by original order.

Verdict (pure `adaptVerdict(kind, stats, findings)`): `build` when empty
(no parts and no GUI) or a ui kind with no GUI objects; `adapt-with-care` when
risky scripts, > 5000 parts, a map under 40 studs across, or > 0 scripts
(they will be stripped); else `adapt`. Reasons listed.

## Decisions (self-approved)

1. **New tool, not an `asset` action.** `asset` is already long; scout is a
   distinct workflow (search → try → adopt). Asset lint/manifest reused.
2. **`try` does not set `sanitized`.** A quarantined copy still has its
   scripts, so `asset:sanitized` correctly fails until `adopt` or `discard`.
   Quarantine findings live in the scout file instead.
3. **Free only, by construction.** `try` refuses ids not in a saved search
   result with `isFree && priceCents === 0`. No price filter override.
4. **No thumbnail fetch.** `thumbnailUrl` is an HTTP call outside Studio;
   blox blocks agent HTTP. The URL is shown for a human.
5. **`discard` may set `rejected`.** Approval stays human-only; rejecting
   cannot raise trust.
6. `adopt` destinations limited to Workspace, StarterGui, ReplicatedStorage,
   ServerStorage, Lighting (no player characters, no CoreGui).

## Testing

Pure: query variants, merge/rank/dedupe/non-free drop, verdict. Tool with the
fake Studio: search saves the file and lists ranked results; try refuses
unknown/paid ids, inserts under the quarantine, records a candidate without
`sanitized`; adopt refuses keep_scripts with risks, strips and records;
discard rejects. CLI flags. Live: one search + try + discard in ~/blox-fw.

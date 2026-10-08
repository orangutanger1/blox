# UI and map refine: old blox vs new blox (2026-10-07)

Proof run for `docs/superpowers/specs/2026-10-07-ui-map-refine-design.md`. The bake-off's blox arm
(`bench/results/quality-bakeoff-2026-10-07.md`, arm B) was repeated with the improved blox as arm C.

**Result: the user picked new blox (Y = C) blind for both the map and the UI.**

## What changed in blox between B and C

#133 Play fails fast when a locked PC blocks it · #134 BloxUI depth stack (Shadow → Face → Lift, no pills;
Tile, Panel, Dialog, Tabs) · #135 edit-mode `ui preview` / `ui lint` · #136 `image generate` (Qwen-Image-2.1
on Kaggle, FLUX fallback) · #137 BloxMap kit, `map check`, `map shots`, `map` release gate · #138
`map-building` skill and guide lines.

## Setup

| | B: old blox | C: new blox |
|---|---|---|
| agent | `claude -p`, Opus 5.5, subscription | same |
| MCP | official Studio MCP + blox MCP | same |
| instructions | `AGENTS.md` as shipped then | `AGENTS.md` as shipped now (`blox new` + `blox setup claude`) |
| place | `BakeoffB.rbxl`, fresh | `BakeoffC.rbxl`, fresh (same 736-byte empty place) |
| briefs | `quality-bakeoff-2026-10-07/{common,map,ui}.md` | same |

B was not re-run: its finished work was still open in Studio. Both places were **captured again** in
the same session with the same judge (`judge.py`, `make_sheets.py`, copied here), so Studio build, cameras
and device presets match. A coin flip set X = B, Y = C (`ui-map-refine-2026-10-07/blind.json`); the key was
read only after the user picked.

## Picks

| task | pick | sheets |
|---|---|---|
| Farm Town map | **Y = new blox** | [map](ui-map-refine-2026-10-07/sheet-map.jpg) |
| Shop UI | **Y = new blox** | [hud](ui-map-refine-2026-10-07/sheet-ui-hud.jpg) · [shop](ui-map-refine-2026-10-07/sheet-ui-shop.jpg) · [confirm](ui-map-refine-2026-10-07/sheet-ui-confirm.jpg) · [shop-broke](ui-map-refine-2026-10-07/sheet-ui-shop-broke.jpg) · [inventory](ui-map-refine-2026-10-07/sheet-ui-inventory.jpg) · [robux](ui-map-refine-2026-10-07/sheet-ui-robux.jpg) |

The user gave no reasons ("go with y for both").

## Cost, turns, time

| | B map | C map | B UI | C UI |
|---|---|---|---|---|
| turns | 67 | 67 | 204 (161 + 43 after a usage-limit resume) | 121 (3 segments) |
| cost (API-equivalent) | $3.83 | $3.04 | $12.55–21.41 (resume accounting unclear) | $6.99 |
| wall time | 14.7 min | 11.6 min | ~2.4 h | 33 min |

C's UI time includes a stall: a Windows screen-time limit locked the PC mid-run, Play stopped starting,
and the final test run had to wait (see Findings). After unlocking: 23/23 tests, 4/4 criteria.

## Judge metrics

| | B (old) | C (new) |
|---|---|---|
| rendered map saturation (mean HSV S of the 8 map captures) | 0.35 | **0.47** |
| reachable points above jump height ("roofs") | 279 | **31** |
| reachable covered points | 990 | **744** (enterable houses tagged) |
| floating parts | 1 | **0** |
| dog spawns reaching the player / boss reachable / pockets | 8/8, yes, 0 | 8/8, yes, 0 |
| visible parts | 828 | 717 |
| triangles (judge camera, shadow + opaque) | 221k | 262k |
| UI: overlapping buttons (all states × 4 devices) | 10 | **3** |
| UI: smallest text px | 11 | **14** |
| UI: tiny text / small tap targets | 0 / 0 | 0 / 0 |
| frame time avg (client) | 16.7 ms | 16.7 ms |

Offscreen counts (B 153, C 136) are mostly scroll-list rows clipped by their frames in both arms.
C's higher triangle count at the judge camera comes from a busier opaque pass (134k vs 98k); both are far
under any frame-time limit and `map check`'s own view budget passed.

## Findings

- **Screen-time lock is not LogonUI.** The Windows Family Safety "Give more time?" overlay blocks Play,
  but LogonUI does not run and LockApp stays suspended, so #133's probe misses it. Afterwards Studio's MCP
  kept answering `Start play hasn't finished yet` to every start/stop, until one real F5 in the Studio
  window cleared it. blox should recognise that reply and say so (fix queued).
- **Judge bridge:** with several Studios open, robloxstudio-mcp's plugins connect one by one; `rs.instance`
  now waits up to 60 s for the named place.

# Presentation pipeline (pipeline item 5)

Research §C/§R.5: store presentation drives acquisition and every AI tool skips it.
Goal: title/description drafts, five *distinct, truthful* thumbnails rendered from the
real place, an icon shot, and a policy lint — all deterministic. Choosing the final
title/art and publishing stay human (publish is item 8, behind a gate).

## `.blox/presentation.json`

```
{ version: 1, title, description,
  shots: [{ id, kind: "thumbnail"|"icon", theme: action|exploration|character|reward|social|logo,
            camera: { position: [x,y,z], lookAt: [x,y,z] },
            subject?: { at: [x,y,z], yaw?: deg, pose?: idle|cheer|carry|punch|run|point },
            hero?: { path: "Workspace.X", at: [x,y,z], scale?: n },
            overlay?: { text, sub?, color?: "#RRGGBB" },
            file?, provenance?: render|human|generated, renderedAt? }] }
```

## Generators (pure)
- `titleCandidates(design)`: "Verb A/An Object" (2026 dominant form), "+1 Stat Object"
  for incremental designs (stat = first non-spendable resource), and the current
  `meta.title`; deduped, ≤ 50 chars.
- `describe(design)`: the rising-game template — welcome line, "How to Play:" bullets
  from `design.loop`, offline line if `economy.offline`, rebirth line if `rebirth`,
  device line. No like/favourite-for-reward bait.
- `defaultShots(design)`: 5 thumbnails with different themes and camera framings around
  the spawn + 1 icon, for the agent to adjust.

## Policy lint (`present:<rule>` synthetic tests; errors gate)
Text: `title-length` (≤ 50), `title-roblox` (no "Roblox"), `title-tags` (≤ 1 leading tag/emoji
cluster), `title-caps` (no shouting > 60% caps when > 8 letters), `desc-length` (≤ 1000),
`desc-links` (no URLs/Discord invites), `scam` (free robux, admin, hacks…), `claims` (warn:
#1/best/official), `engagement-bait` (warn: rewards for likes/favourites), `emoji-spam`
(warn: > 15 emoji), `mature` (warn: gore/blood words — check the 9+ rating).
Shots: `thumb-count` (≥ 1 error, < 5 warn), `thumb-variety` (no two thumbnails share theme
and camera within 5 studs), `thumb-rendered` (file present, provenance `render`|`human`;
`generated` needs a human — truthfulness), `thumb-aspect` (16:9 ± 5%, read from
PNG/JPEG headers), `thumb-duplicate` (identical files), `icon` (one icon shot, overlay
≤ 12 chars / ≤ 2 words for 64 px).

## Render rig (`present render`)
Edit-context Luau builds `Workspace.__BloxRenderRig`: an R15 avatar from a default
HumanoidDescription (fallback: block rig) posed by Motor6D C0 presets, an optional hero
clone (scaled), and overlay text on an AlwaysOnTop BillboardGui placed in the upper
third of the view. Then `screen_capture` with the shot camera, saved to
`.blox/artifacts/present/<id>.<ext>`, recorded in presentation.json with provenance
`render`. The rig is always removed.

## Tool `present` (MCP + CLI)
`get` | `set {doc}` | `generate` (fills title/description/shots when empty; prints
candidates) | `render {ids?}` | `lint`.

## Verification
Generators, lint, image-header parsing unit-tested; render orchestration with the fake
Studio; rig Luau compile-checked under Lune. Live smoke pending (capture in edit mode,
CreateHumanoidModelFromDescription in edit mode).

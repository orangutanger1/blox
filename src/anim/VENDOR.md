# Vendored: Roqer animation core

Source: https://github.com/S4US/Roqer, commit 4dcb9a7fd9b884cae4ed10fe282ee359550c10b4,
`packages/core/src/animation/` and `packages/core/src/png-encoder.ts`.
Reused with the owner's permission. Roqer is AGPL-3.0; the blox owner chose to
proceed with reuse (2026-10-02).

Local changes:
- import specifiers: `../png-encoder.js` → `./png-encoder.js`; Node built-ins
  use the `node:` prefix.
- no code removed.

Tests ported to tests/anim.*.test.ts (jest → vitest imports). Cases that build
model-read rigs (parts-dog, parts-octopus fixtures via model-rig) are removed —
spec B: gait keeps its R15 and R6 cases, wave keeps its R15 case;
pose-compiler and motion-checks are ported whole.

Spec B (model rigs) adds model-rig, rig-declarations and body-plans, with
their tests (tests/anim.model-rig, anim.rig-declarations; gait and wave now
ported whole) and the parts-dog / parts-octopus fixtures
(tests/fixtures/anim/). Local changes: `RoqerRig` → `BloxRig`,
`RoqerModelAnimate` → `BloxModelAnimate`, "this Roqer reads" → "this blox
reads"; model-rig's GLB-preview assertions are removed (rig-glb is not
vendored): the one test only about mesh index widths is dropped, the two that
also check the contact sheet and welded parts keep those checks.

Not vendored: rig-build, rig-glb, rig-tool (spec C: building rigs).

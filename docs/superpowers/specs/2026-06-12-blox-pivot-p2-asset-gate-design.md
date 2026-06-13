# blox Pivot P2 — Asset Result Gate

**Date:** 2026-06-12
**Status:** Implemented (P2) — live smoke 2026-06-13: approve (dock) + timeout paths verified end-to-end. Two post-implementation fixes surfaced by the live smoke: panel `connectedWindowMs` must outlast the long-poll `holdMs` (else the result gate's `isConnected()` check bailed after generation), and the dock must reset its event cursor on a new `runId` (else a second run with the dock open skipped its events).

## 1. Context

P1 shipped the Studio dock panel: run status, streamed log, and interactive
pre-call gates — in `--ask` mode with the dock connected, a gated tool call
pauses on an Allow/Deny card before it executes (spec
`2026-06-11-blox-pivot-p1-studio-dock-panel-design.md`, merged `a848612`).

P2 adds the second half of asset control: **result approval**. The pre-call
gate decides whether a generation may run; the result gate shows the user what
was actually generated — in 3D, inside Studio — and lets them keep it, or
reject it with feedback the agent hears. This is the pivot roadmap's "asset
approve/deny in dock" slice and builds directly on P1's gate broker, event
protocol, and dock cards.

### Cost framing (corrected)

Earlier blox docs say asset generation "spends Roblox credits". As of June
2026 Roblox's mesh/model generation is free while in beta (rate-limited);
metering is announced but not live. The gates' value today is **control**, not
refunds: a `generate_mesh` call blocks ~29s, inserts content into the
DataModel, and the agent immediately builds on top of whatever came out.
Rejecting never refunds anything (spend happens at generation time), but it
stops a bad asset from staying in the game and steers the agent before
compounding. When metering lands, the money story is already wired: with both
gates, every retry is a fresh generation call that re-enters the P1 pre-gate,
so there is no silent spend loop.

## 2. Decisions (locked)

| Question | Decision |
|---|---|
| Pre-gate vs result-gate | **Both.** P1 pre-call Allow/Deny unchanged; P2 adds a post-generation approve/reject pause. |
| Reject disposition | **Stash, don't destroy.** Plugin moves the instance to `ReplicatedStorage._bloxRejected` (created on demand) with a ChangeHistoryService waypoint. Paid-for/slow-to-make artifact preserved for manual reuse. |
| Preview | **Both mechanisms.** ViewportFrame 3D thumbnail in the dock card, plus thumbnail click selects the instance and tweens the main Studio camera to frame it. (`screen_capture` rejected: play-mode-only, generation happens in Edit.) |
| Tool scope | **`generate_mesh` + `generate_procedural_model` only** — the slow, content-inserting generators. `insert_from_creator_store` and `generate_material` keep P1 pre-gate only. |
| Feedback | **Optional feedback text** on Reject; lands in the message the agent sees. |
| Pause mechanism | **PostToolUse hook park** (approach A below). |

### Mechanism alternatives considered

- **A. PostToolUse hook park (chosen):** CLI hook on the two tools reads the
  tool result, emits a result-gate event, and awaits the P1 GateBroker. Real
  enforcement, smallest new surface, reuses all P1 machinery, and honors the
  SP1c-d single-client rule (the hook never calls MCP — it only talks to the
  in-process broker).
- **B. Agent-protocol tool** (`await_asset_approval` SDK tool the agent must
  call): relies on agent compliance; a non-compliant agent skips approval.
  Rejected.
- **C. Plugin-autonomous DataModel watch:** plugin shows cards on its own;
  CLI never pauses, so the agent has moved on before the user decides and
  feedback has no injection point. Doesn't gate. Rejected.

## 3. Flow (`--ask` + dock connected)

```
agent → generate_mesh ──► P1 pre-gate card ── Allow ──► tool runs ~29s, MeshPart inserted
                                                            │
                              PostToolUse hook fires ◄──────┘
                              parses result tag ("Assistant-MeshGen-<uuid>")
                              emits result_gate_request, PARKS on GateBroker
                                                            │
        dock result card: ViewportFrame thumbnail + prompt summary
        [Approve] [Reject] [optional feedback text]
        thumbnail click → Selection:Set + tween main camera to frame
                                                            │
   Approve ──► hook returns continue, run resumes
   Reject  ──► plugin stashes instance → ReplicatedStorage._bloxRejected,
               POSTs {decision:'reject', feedback?} ──► hook returns a
               PostToolUse block whose reason tells the agent: rejected,
               already set aside, plus the user's feedback — adjust or continue
   Timeout ──► approve-with-note (asset stays; log event marks it unreviewed)
```

- **Async chain:** `generate_procedural_model` returns a job submission, not a
  model. Its result gate fires on the `wait_job_finished` PostToolUse instead
  — where the generated model actually lands.
- **Timeout asymmetry (deliberate):** pre-gate timeout denies (default-safe is
  *don't run the tool*); result-gate timeout approves (default-safe is *don't
  mutate the DataModel unattended* — the asset already exists). Timeout reuses
  `panel.gateTimeoutSeconds` (one knob, default 120).
- **Degenerate modes:** `--auto`, non-ask, or no panel → hook returns continue
  immediately; zero behavior change. Ask-without-dock: the P1 pre-gate already
  denies generation, so the result gate is unreachable. Consistent.
- **Never stall the run:** any hook/channel error → continue (P1 rule: a
  degraded panel beats a dead run).

## 4. CLI components

All additions reuse P1 machinery; no new module.

- **`src/panel/events.ts`** — new events:
  `result_gate_request {gateId, tool, tag: string|null, inputSummary}` and
  `result_gate_resolved {gateId, decision: 'approve'|'reject', source: 'dock'|'timeout', feedback?}`.
  `PROTOCOL_VERSION` 1 → 2 (P1 behavior on mismatch: plugin shows update hint,
  CLI runs unaffected).
- **`src/panel/gates.ts`** — GateBroker generalized to gate kinds
  `'tool' | 'result'`. Tool-gate API and semantics unchanged
  (`request`/`resolve`/`dockDeniedTools`). Result gates resolve to
  `{decision, source, feedback?}`; timeout resolves `approve`/`timeout`. New
  `resultDecisions()` accessor for the report.
- **`src/agent/hooks.ts`** — `buildAssetResultHook(gate)`: PostToolUse hook
  matching `mcp__Roblox_Studio__generate_mesh` and
  `mcp__Roblox_Studio__wait_job_finished`. Parses the tool result for the
  inserted instance's name: mesh result is `{"tag":"Assistant-MeshGen-<uuid>"}`
  (live-probed, known); `wait_job_finished` done-shape is **unprobed** — the
  parser is defensive, and a parse miss emits the gate with `tag: null`
  (preview-less card, still approve/reject-able; reject without a tag is
  feedback-only, no stash). Approve → `{}`/continue. Reject → PostToolUse
  `decision: 'block'` with reason: rejected + stashed (when stashed) + user
  feedback + "adjust or continue, do not re-insert the rejected asset".
- **`src/agent/buildOptions.ts`** — registers the hook only when mode is ask
  and a panel gate channel exists.
- **`src/panel/server.ts`** — `POST /api/v1/gate/{id}` body gains optional
  `feedback: string` (truncated at 2000 chars, ignored on tool gates);
  decision value validated against the gate's kind (`allow|deny` for tool,
  `approve|reject` for result).
- **`src/report.ts`** — assets section: per-tool approved/rejected lines,
  feedback echoed, timeout-approved noted.

## 5. Plugin (Luau)

Result card in the existing dock list:

- Header: tool name + input summary (the generation prompt).
- **ViewportFrame thumbnail:** find the instance via
  `Workspace:FindFirstChild(tag, true)`, clone into a `WorldModel` inside a
  `ViewportFrame`, camera fitted from the clone's bounding box. Not found →
  "preview unavailable" placeholder; buttons still live.
- Thumbnail click: `Selection:Set({instance})` + tween the main camera to
  frame the instance (bounding-box fit).
- Buttons: **Approve**, **Reject**; optional feedback `TextBox` (sent only
  with Reject).
- Reject order matters: stash the instance into
  `ReplicatedStorage._bloxRejected` (folder created on demand,
  ChangeHistoryService waypoint for undo) **before** POSTing the decision, so
  the agent's "already set aside" message is true when it resumes.
- Protocol v2 mismatch → existing update-hint behavior.

## 6. Edge cases

- **Concurrent gates:** broker already supports multiple pending; cards stack
  (P1 pattern).
- **Agent renames/moves the instance** between insert and gate: find fails →
  preview-less card.
- **CLI killed mid-gate:** dock disconnect on next poll (P1 behavior,
  live-verified).
- **Stash collision:** `_bloxRejected` children may share names; Roblox allows
  duplicate sibling names, no handling needed.
- **`wait_job_finished` fires for a non-asset job:** only the procedural-gen
  chain uses it today; if the parse finds no model identifier the gate still
  shows (tag null) — acceptable noise, revisit if other jobs appear.

## 7. Testing

- **Unit:** result parser (mesh tag, procedural defensive paths, malformed
  JSON), broker result-kind + feedback + timeout-approve, server decision/kind
  validation + feedback cap, report section, event translation.
- **Integration:** P1-style `panel.integration` test — fake agent loop parks
  in the hook, dock POST resolves, run resumes; reject path asserts the block
  reason carries the feedback.
- **Live (gated, `BLOX_LIVE_ASSETGATE=1`):** real generation, human clicks
  approve and reject, asserts stash folder contents.
- **Front-loaded live probe task:** the `wait_job_finished` done-result shape
  is the design's only unknown — the implementation plan probes it against a
  real Studio before the parser is written, and tightens the mock to match.

## 8. Out of scope

- Result gates for `insert_from_creator_store` and `generate_material`.
- Regeneration shortcuts in the dock ("retry with feedback" button) — the
  agent decides whether to retry; every retry re-enters the P1 pre-gate.
- Asset cache/manifest, image→model chain, quality tiers (SP3 deferrals,
  unchanged).
- Creator Store listing of the plugin (after P2 polish, per P1 spec).

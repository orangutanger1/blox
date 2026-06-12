# blox Pivot P1 — Studio Dock Panel

**Date:** 2026-06-11
**Status:** Implemented (P1) — live Studio smoke passed 2026-06-12 (Allow / Deny / kill-CLI disconnect)

## 1. Context: the pivot

blox is pivoting from a general "agentic CLI for Roblox" into a direct competitor
to the AI-builds-your-game products (Lemonade.gg, SuperbulletAI, LuaMotion, RoCode
et al.), positioned as **"Claude Code for Roblox"** — the prosumer/professional
option in a category whose incumbents all share the same shape: generate code,
inject into Studio, hope.

Market research (June 2026) found Lemonade's top verified complaints:

1. Outdated models that don't get updated; tokens deplete fast even on paid plans
   (Trustpilot 2.7/5, 50% one-star).
2. The AI "can and does change other parts of your game that you didn't prompt it
   to" — no real diff/rollback (prompt-iteration rollback only).
3. Poor per-prompt economics ($20 / 100 prompts vs. SuperbulletAI's $20 / ~5,500).
4. Imprecise edits (e.g. asked to paint a car logo, painted the whole car).
5. Playtest/verification still beta.

blox already ships the antidotes: direct Claude SDK (latest models, `--effort`),
git-per-change commits and real diffs, BYO-key economics, `--ask`/`--budget`/
`--max-turns` blast-radius controls, and a verify loop (headless `execute_luau`,
play mode, input sim, `screen_capture`) that incumbents list as beta or absent.

### Strategy decisions (locked)

- **Target user:** Rojo + git developers (beachhead, est. O(10k–50k) devs — the
  segment that ships top-earning games), expanding to small teams/studios (B2T/B2S).
- **Business model:** open core. CLI free + open source, BYO Claude key. Paid team
  tier later (shared policies, hosted CI agents, review dashboards, audit logs).
- **MVP surface:** CLI + a thin Studio dock panel (this spec). The CLI stays the
  engine; the dock is a window into it.
- **Files + git remain the source of truth.** Competitors' sync means "inject into
  DataModel, our cloud is truth." blox sync means "your repo is truth, Studio is
  the mirror" (managed `rojo serve`, SP1c-c). This is the moat.

### Pivot decomposition

| # | Sub-project | Scope (one paragraph each; separate specs to follow) |
|---|-------------|------------------------------------------------------|
| **P1** | **Studio dock panel core** | **THIS SPEC.** Run status, streamed agent log, diff summary, interactive approve/deny gates inside Studio. Implements (and supersedes) old SP4-d. |
| P2 | Asset approve/deny in dock | Gated asset generation surfaces in the dock with a viewport capture preview (SP2-b `screen_capture`) and camera-framing of the inserted asset via `execute_luau`; approve/reject resumes the run. Builds on P1's gate cards. |
| P3 | Screenshot→UI multimodality | Feed an image (CLI arg or dock upload) to the agent; it builds the matching Roblox UI. Claude vision + existing pipeline. Parity with Lemonade's headline 2026 feature. Independent of P1/P2. |
| P4 | `blox init` hardening | Make non-Rojo onboarding (SP4-b) bulletproof — it is the top of the adoption funnel for Studio-native devs without Rojo. Do before public launch. |
| P5 | Team tier alpha | Shared `blox.config.json` policies, commit conventions, run audit log. First B2T monetization signal. Needs P1's event telemetry. May add an optional hosted relay for remote/team dashboards. |

Old SP4-c (rich TUI) is **deprioritized**: the dock panel covers the "watch the
run" need where the target user actually looks, and the plain CLI stays for
headless/CI use.

## 2. Goal (P1)

A blox run is visible and controllable from inside Roblox Studio: live status,
streamed agent log, file-diff summaries, and interactive approve/deny for gated
actions — without the CLI ever depending on the panel.

The headline behavior change: in `--ask` mode with the dock connected, a gated
tool call **pauses** the run and asks in Studio; on Allow the run **continues**.
Today's behavior (deny + self-explain + stop) remains the fallback whenever the
dock is absent or the gate times out. Incumbents approve generated *code*; blox
gates *actions* mid-run and resumes.

## 3. Architecture

```
┌─ terminal ─────────────┐        ┌─ Roblox Studio ──────────┐
│ blox CLI               │        │ dock widget plugin (Luau)│
│  ├─ agent loop (SDK)   │  HTTP  │  ├─ status header        │
│  ├─ panel server ◄─────┼────────┼─ ├─ log view             │
│  │   127.0.0.1:35768   │ long-  │  ├─ diff list            │
│  │   event buffer      │  poll  │  └─ gate card Allow/Deny │
│  │   gate broker       │        │     (HttpService)        │
│  └─ rojo serve (mgd)   │        │  Rojo plugin (existing)  │
└────────────────────────┘        └──────────────────────────┘
```

Transport choice ("Approach A", approved): the CLI hosts a local HTTP server and
the plugin long-polls it — the proven Rojo plugin pattern. Rejected alternatives:
piggybacking the Studio MCP bridge (status writes would pollute the DataModel and
undo history, gates could not block synchronously, contends with the agent's own
channel) and a hosted relay (infra + accounts before product–market fit; wrong
for an open-core local-first tool; revisit for P5).

### 3.1 Panel server

- `src/panel/server.ts`, plain `node:http`. Zero new runtime deps.
- Binds `127.0.0.1` **only**. Default port **35768** (clear of Rojo's 34872),
  overridable via `blox.config.json` (`panel.port`).
- WSL2 note: with the CLI in WSL2 and Studio on Windows, the plugin's
  `127.0.0.1` request reaches the server via WSL2 localhost forwarding
  (`localhostForwarding`, on by default) — the same path the existing
  Rojo-serve sync already depends on. `blox doctor` should verify reachability.
- Lifetime = the run. Started by the CLI before the agent loop, closed after the
  report prints.

### 3.2 Studio plugin

- `plugin/` directory: Luau source + `default.project.json`, built to a `.rbxm`
  with Rojo.
- DockWidgetPluginGui with: status header (state, turns, cost-so-far), scrolling
  log view, diff list (path + add/del counts), gate card with Allow/Deny.
- Long-polls the server via `HttpService:RequestAsync`. Kept deliberately thin:
  poll + render only; all logic lives CLI-side where vitest reaches it.
- Installed via `blox panel install` (drops the `.rbxm` into the local Studio
  plugins folder). Creator Store listing deferred until after P2 polish.

## 4. Protocol (JSON over HTTP, v1)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/info` | Handshake: blox version, protocol version, project name, run id |
| `GET /api/v1/events?cursor=N` | Long-poll (~25 s hold): events after `cursor`, else empty array → client re-polls |
| `POST /api/v1/gate/{id}` | Body `{"decision": "allow" \| "deny", "reason"?: string}` — resolves a pending gate |

Event types:

| Event | Payload (summary) |
|-------|-------------------|
| `run_started` | run id, prompt summary, mode, budget/turn caps |
| `status` | turns so far, cost so far |
| `log` | agent text or tool-use one-liner |
| `file_diff` | path, lines added/removed |
| `gate_request` | gate id, tool name, input summary |
| `gate_resolved` | gate id, decision, source (dock / timeout) |
| `run_finished` | stop reason, turns, cost, report summary |

Events live in a ring buffer with monotonically increasing cursors; a
reconnecting plugin replays from its last cursor — no lost events. Protocol
version is returned in `info`; on mismatch the dock shows an update hint and the
CLI runs unaffected.

## 5. Agent integration

Two surgical touch points:

1. **Event emission.** `runAgent` (src/agent/runAgent.ts) today consumes only the
   SDK `result` message. It gains an optional `EventSink` parameter and emits
   every stream message (assistant text, tool_use, result) to it. The CLI wires a
   sink that writes to both the console (existing behavior) and the panel
   server's buffer. No sink ⇒ behavior identical to today.
2. **Gate broker.** `buildCanUseTool` (src/agent/permission.ts) gains an optional
   broker. On a gated tool with the dock connected: publish `gate_request`,
   **await** the decision; Allow ⇒ `{behavior: 'allow'}` and the run continues;
   Deny ⇒ today's deny message path. Dock not connected, or timeout (default
   120 s, `panel.gateTimeoutSeconds`) ⇒ exactly today's deny + self-explain +
   stop. No new CLI flag: `--ask` simply becomes interactive when the dock is
   present. `--auto` is untouched.

## 6. Data flow (happy path)

1. `blox --ask "task"` → panel server starts → CLI prints dock hint.
2. Plugin (already polling) receives `info` → header shows project + run id.
3. Run starts → `run_started`; each turn streams `log` + `status` to the dock.
4. A file edit lands → `file_diff` event → diff list grows.
5. Agent calls `generate_mesh` → `gate_request` → dock shows gate card → user
   clicks **Allow** → `POST /api/v1/gate/{id}` → `canUseTool` resolves allow →
   agent continues.
6. Run ends → `run_finished` → dock shows summary; full report in the terminal
   as today.

## 7. Error handling

- **The panel never blocks the run.** Server fails to start ⇒ warn and run
  headless. Plugin disconnects mid-run ⇒ events buffer; reconnect replays from
  cursor.
- **Gate timeout** (120 s default) ⇒ fall back to deny + stop; the report notes
  the gate timed out. No hung runs.
- **Port conflict** ⇒ fail with a clear message and config hint (Rojo's posture;
  no port-scanning).
- **HttpService disabled** ⇒ plugin detects the failure and shows a one-line fix
  hint in the dock.
- **Security:** bind 127.0.0.1 only; no auth in v1 — the same local trust model
  as the Rojo plugin. Auth token deferred to the team tier (P5).

## 8. Testing

- **Unit:** event ring buffer + cursor replay; gate broker (resolve, deny,
  timeout fallback); endpoint handlers via direct `fetch` against the server on
  an ephemeral port.
- **Integration:** mock-bridge run + a fake plugin client (Node fetch long-poll)
  driving the full loop, including approve-mid-run resuming the agent. No Studio
  required.
- **Live (gated):** `BLOX_LIVE_PANEL=1` smoke test with real Studio + plugin,
  matching the existing `BLOX_LIVE_*` convention.

## 9. Out of scope for P1

- Asset capture previews in the dock (P2).
- Full diff hunk rendering (v1 = path + counts; full diffs live in terminal/git).
- Starting runs / entering prompts from the dock (v1 = monitor + gate only).
- Remote access, auth, multi-user (P5).
- Creator Store listing (after P2 polish; v1 installs via `blox panel install`).

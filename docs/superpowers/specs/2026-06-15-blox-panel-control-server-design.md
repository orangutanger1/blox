# blox Panel Control Server — Dock-Driven Runs & Model Switching

**Date:** 2026-06-15
**Status:** Draft

## 1. Context

Today the blox dock panel is **run-scoped**: `blox "<prompt>"` builds the run
pipeline inline (`cli.ts:117-235` — digest → bridge → options → rojo serve →
`runAgent` → sync → commit) and spins up a `PanelServer` (`src/panel/server.ts`)
that lives only for that one run. `PanelServer` takes a `runId` in its
constructor and holds a single run's events. The plugin (`plugin/src/Ui.luau`,
protocol v3) connects to observe the run and answer gates — routes are
`GET /api/v1/info`, `GET /api/v1/events` (long-poll), `POST /api/v1/image`,
`POST /api/v1/gate/:id`. There is no way to start a run from the dock, and the
model is fixed at CLI launch.

Separately, blox can now be driven through `claude-code-router` (CCR) →
OpenRouter, giving access to non-Anthropic models (see `[[blox-byo-model-routing]]`).
Which model is used is decided by CCR, not blox. Users want to pick the model —
and launch runs — from the dock instead of the CLI.

## 2. Goal & Scope

Turn the dock into a **persistent control surface**: an always-on blox server the
plugin reaches between runs, a model dropdown sourced from CCR config, and the
ability to launch (and, as a stretch, cancel) runs from the dock.

**In scope (Phase 1):**
- Persistent daemon mode (`blox panel serve`).
- `GET /api/v1/models` — model list from CCR config.
- `POST /api/v1/run` — launch a run with a chosen prompt + model.
- Model plumbing via the `provider,model` request string (no CCR restart/rewrite).
- Plugin UI: model dropdown, prompt box, Launch button (protocol v3 → v4).

**Stretch:**
- `POST /api/v1/cancel` — abort the in-flight run (depends on the SDK exposing an
  interrupt path; verified during build).

**Out of scope:**
- Concurrent runs, run history/queue (one run at a time).
- Editing CCR config from the dock (model list is read-only).
- A `--model` CLI flag (orthogonal; not required by this feature).

## 3. Architecture

```
Studio plugin (Ui.luau, v4)
  │  HttpService → 127.0.0.1:35768
  ▼
blox panel daemon (src/panel/daemon.ts)        ── persistent
  ├─ GET  /api/v1/models   ← src/ccr.ts (reads ~/.claude-code-router/config.json)
  ├─ POST /api/v1/run      → runOnce(config{model}, …) (src/run.ts)   [async, not awaited]
  ├─ POST /api/v1/cancel   → interrupt in-flight run   (stretch)
  ├─ GET  /api/v1/events   ← EventBuffer  (unchanged long-poll)
  └─ POST /api/v1/gate/:id ← GateBroker   (unchanged)
                                  │
                                  ▼
                       runOnce → query(model="openrouter,<slug>")
                                  │
                                  ▼
                          CCR routes per-request by provider,model → OpenRouter
```

The daemon reuses `EventBuffer`, `GateBroker`, and the long-poll/gate routes
unchanged. It owns run state (`idle` | `running`) and assigns a fresh `runId`
per `/run`. The dock follows `runId` across runs via the existing event stream.

## 4. Components

### 4.1 Run pipeline extraction — `src/run.ts`
Extract the inline pipeline in `cli.ts:117-235` into:

```
runOnce(config: BloxConfig, opts: { prompt: string; image?: ImageInput },
        ctx: { sink?: EventSink; gate?: PanelGateChannel; bridge?: StudioBridge })
  : Promise<RunReport>
```

Covers digest → bridge → buildQueryOptions → ensureServe → `run_started` emit →
`runAgent` → syncProject → commit → `RunReport`. The model is taken from
`config.model` (already forwarded to `query()` at `buildOptions.ts:55`). Both
`blox "<prompt>"` (CLI) and the daemon `/run` call it — pure dedup, no behavior
change. `cli.ts` shrinks to arg-parsing + a `runOnce` call.

### 4.2 CCR reader — `src/ccr.ts`
```
readCcrModels(): { provider: string | null; models: string[]; current: string | null }
```
Reads `process.env.CCR_CONFIG ?? ~/.claude-code-router/config.json`, returns
`Providers[0].name` as `provider`, `Providers[0].models` as `models`, and the
slug from `Router.default` (`"provider,slug"` → `slug`) as `current`. Missing or
unparseable file → `{ provider: null, models: [], current: null }` (no throw).

### 4.3 Daemon — `src/panel/daemon.ts`
A persistent server reusing `EventBuffer` + `GateBroker`. Wraps/extends the
`PanelServer` route handler. State machine: `idle` ↔ `running`. New routes in §5.
On `/run` it sets `config.model = "${provider},${slug}"`, generates a `runId`,
emits `run_started`, and calls `runOnce` **without awaiting** (the handler returns
`202` immediately; events stream over `/events`). On completion (success or
throw) it emits `run_finished` and returns to `idle`. A thrown `runOnce` never
crashes the daemon. Runs use the daemon's loaded `config.mode` (`auto`/`ask`,
schema default `auto`); per-run mode selection from the dock is out of scope for
Phase 1.

### 4.4 Model plumbing
The chosen slug is sent to the model as `"${provider},${slug}"` (e.g.
`openrouter,google/gemini-2.5-pro`). CCR routes per-request by this `provider,model`
string, bypassing `Router.default` — no CCR restart, no config write. **Risk:**
this assumes CCR honors per-request `provider,model` routing (it is how Claude
Code's `/model` works). Verified by a direct curl before building the daemon
(§9). If CCR does not honor it, fall back to rewriting `Router.default` +
`ccr restart` on `/run` (heavier; documented as the contingency).

### 4.5 CLI — `blox panel serve`
New subcommand starts the daemon on `config.panel.port` and blocks. Existing
`blox panel install` and `blox "<prompt>"` paths unchanged.

### 4.6 Plugin — `plugin/src/Ui.luau` (protocol v3 → v4)
Add to the existing dock: a model **dropdown** populated from `GET /api/v1/models`
(shows `current` selected), a prompt **TextBox**, a **Launch** button
(`POST /api/v1/run` with `{prompt, model}`), and a **Cancel** button
(`POST /api/v1/cancel`, stretch). Launch is disabled while a run is `running`,
re-enabled on `run_finished`. Protocol bump to 4; the plugin already shows an
update hint on mismatch and the CLI runs unaffected.

## 5. HTTP contracts (additions)

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/api/v1/models` | — | `200 { provider, models: string[], current }` | — |
| POST | `/api/v1/run` | `{ prompt: string, model: string }` | `202 { runId }` | `409` busy; `400` empty prompt / model not in `models[]` |
| POST | `/api/v1/cancel` | — | `200 { ok: true }` (stretch) | `409` no run active |

`GET /api/v1/info` gains a `state: "idle" | "running"` field. `model` in `/run`
is the bare slug (e.g. `google/gemini-2.5-pro`); the daemon prepends the provider.

## 6. Protocol changes (v3 → v4)

- `PROTOCOL_VERSION = 4`.
- `run_started` event gains a `model: string` field (the resolved `provider,slug`)
  so the dock can display what's running.
- No other event shape changes; `run_finished` already signals run end (dock uses
  it to re-enable Launch).

## 7. Error handling

- `/run` while `running` → `409`; daemon stays on the current run.
- `/run` with a model not in the CCR `models[]` list → `400` (guards bad slugs).
- CCR config missing/unparseable → `/models` returns `models: []`; dock shows an
  empty dropdown with a "check claude-code-router" hint.
- `runOnce` throws → daemon emits `run_finished{status:"error", …}`, logs, returns
  to `idle`. The daemon process survives.
- Server binds `127.0.0.1` only — unchanged local trust model.

## 8. Reused vs. new

**Reused:** `EventBuffer`, `GateBroker`, gate/events/image routes, `runAgent`,
`buildQueryOptions`, CCR, rojo serve, commit/sync.
**New:** `src/run.ts` (extracted), `src/ccr.ts`, `src/panel/daemon.ts`,
`blox panel serve` subcommand, dropdown/prompt/launch UI in `Ui.luau`, the three
routes, `model` on `run_started`.

## 9. Testing

- **Unit:** `readCcrModels` (parse, missing file, malformed); daemon routes
  (`/models` shape, `/run` 409-busy, `/run` 400-bad-model, `/run` happy path sets
  `config.model = provider,slug`); `run_started` carries `model`. Reuse the mock
  bridge and ephemeral-port (`port: 0`) patterns from the existing panel tests.
- **Build-time verification (blocking §4.4):** curl CCR `/v1/messages` with
  `model: "openrouter,google/gemini-2.5-pro"` and confirm the response `model`
  reflects gemini — proves per-request routing before the daemon depends on it.
- **Live smoke (manual):** `blox panel serve` + Studio + CCR; pick gemini in the
  dropdown, type a prompt, Launch, observe the run stream and which model answered.

## 10. Open questions

- **Cancel feasibility:** does `@anthropic-ai/claude-agent-sdk` `query()` expose
  an interrupt/abort path? If yes, `/api/v1/cancel` ships in Phase 1; if not, it
  becomes a follow-up. Resolved during build, not blocking the rest.
- This persistent control server is the same surface the planned Electron
  companion app needs (`[[blox-desktop-app]]`) — keep the route contracts stable
  enough to reuse there.

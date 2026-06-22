# Desktop: run any model (Claude direct + OpenRouter + local) via managed CCR

Date: 2026-06-22
Status: approved, ready to plan

## Problem

The desktop companion can only run native Claude. The CLI already runs other
models (OpenRouter, DeepSeek, local, etc.) by routing through CCR
(claude-code-router), but the desktop can't expose that — and, on inspection,
**the direct CLI one-shot can't actually route either**.

Root cause: only the panel *daemon* points the SDK at CCR. The one-shot path
(`src/cli.ts:276`) passes `env: buildAuthEnv(...)`, which injects only Claude
credentials — no `ANTHROPIC_BASE_URL`, no `ensureCcr`. A `provider,slug` model
sent through the one-shot hits `api.anthropic.com` and 404s. The desktop forks
the one-shot CLI, so it inherits this gap: passing `--model openrouter,…` today
would fail.

Secondary gaps:
- `readCcrModels` (`src/ccr.ts`) reads only `Providers[0]`, so OpenRouter and a
  local provider can't both appear in a model picker.
- Configuring CCR means hand-writing `~/.claude-code-router/config.json` and
  installing CCR globally — unacceptable for a consumer desktop.

## Goals

- A desktop run can target native Claude **or** an OpenRouter model **or** a
  local (Ollama / LM Studio) model.
- The user never hand-edits CCR config; the wizard collects a provider + key (or
  base URL) and blox writes the config.
- The direct CLI one-shot routes to CCR for routed models — fixing bare-CLI
  non-Claude runs in the same change.

## Non-goals (YAGNI)

- Reimplementing the Anthropic↔OpenAI translation. CCR's transformers (the
  finicky streaming + tool-use part) stay; blox owns only CCR's **config and
  lifecycle**.
- Bedrock / Vertex / native-Gemini providers (not OpenAI-shaped). Deferred.
- Bundling CCR into the Electron app. v1 installs CCR on first use; bundling is a
  later hardening step (see Open decisions).
- Per-model cost/latency UI, model search, multi-provider simultaneous routing
  beyond a flat union list.

## Architecture

```
Wizard (renderer) ─IPC→ main ─runCli→ `blox model add …`  → writes/upserts CCR config.json
Run screen: dropdown ← `blox model list --json`           (native Claude + union of CCR providers)
   pick Claude  → run (no --model / native model)  → cli.ts: buildAuthEnv (unchanged)
   pick routed  → run --model provider,slug        → cli.ts: ensureCcr + ccrRunEnv → SDK routes via CCR
```

Reuse-not-rebuild: the translation layer (CCR) is unchanged. The new work is
(1) make the one-shot CLI route like the daemon already does, (2) a friendly
config writer, (3) install/ensure CCR, (4) desktop UI.

### Credential source of truth

- **Native Claude** → `~/.config/blox/auth.json` (engine's `buildAuthEnv` reads
  it). Unchanged.
- **Non-Claude** → `~/.claude-code-router/config.json` (blox already reads it for
  the model list; CCR holds the provider key). 

No third store. The comma in the model string (`provider,slug`) already encodes
which path a run takes (`buildOptions.ts:70`).

## Components touched

| File | Change |
|------|--------|
| `src/ccr.ts` | `readCcrModels` → union **all** `Providers` (not just `[0]`); add `writeProvider(kind, opts)` that upserts a provider block by name and sets `Router.default`. |
| `src/ccrServe.ts` | Export `ccrRunEnv()` (clone env, set `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` from `ccrEndpoint()`, delete `ANTHROPIC_AUTH_TOKEN`) — lifted from the daemon. Add `ensureCcrInstalled()` (install-on-first-use). |
| `src/panel/daemon.ts` | Use the shared `ccrRunEnv`; delete its private copy. |
| `src/cli.ts` | Routed model (`config.model.includes(',')`) → `ensureCcr(log)` then `env: ccrRunEnv()` into `runOnce`; else `buildAuthEnv` as today. |
| `src/model/index.ts` (new) + `cli.ts` dispatch | `blox model add openrouter --key … [--model …]*`, `blox model add local --base-url … --model …`, `blox model list [--json]`, `blox model remove <name>`. Mirrors the `blox auth` subcommand pattern. |
| `app/main/engine.ts` | `buildRunArgs` gains `--model <m>`; `runStart` forwards the chosen model. |
| `app/main/index.ts` + `app/shared/ipc.ts` + `app/main/preload.cjs` | IPC: `modelAdd`, `modelList` (drive `blox model …` via `host.runCli`). Channel names mirrored in `ipc.ts` and `preload.cjs`. |
| `app/renderer/onboard.ts` | Provider step: Anthropic (existing) \| OpenRouter (key) \| Local (base URL + model). Adding a provider is optional — native Claude alone still finishes onboarding. |
| `app/renderer/console.ts` | Model dropdown populated from `model list`; selected model sent with the run. |

### `writeProvider` — CCR config shapes

Confirmed against a live config. Upsert into `Providers[]` by `name`, then set
`Router.default = "<name>,<first model>"`.

- **OpenRouter** (`name: "openrouter"`):
  ```json
  { "name": "openrouter",
    "api_base_url": "https://openrouter.ai/api/v1/chat/completions",
    "api_key": "<key>",
    "models": ["<one or more slugs>"],
    "transformer": { "use": ["openrouter"] } }
  ```
  `--model` is repeatable; if none given, default to a small starter list
  (`anthropic/claude-sonnet-4.5`, `deepseek/deepseek-chat`,
  `google/gemini-2.5-pro`). User can edit later via another `model add`.
- **Local** (`name: "local"`, Ollama / LM Studio — OpenAI-compatible, no key):
  ```json
  { "name": "local",
    "api_base_url": "http://localhost:11434/v1/chat/completions",
    "api_key": "ollama",
    "models": ["<model name>"] }
  ```
  No `transformer` — a transformer-less CCR provider is treated as plain
  OpenAI-compatible, which is what Ollama/LM Studio speak. `--model` is required
  (no sensible default for a local box); base URL defaults to Ollama's
  `http://localhost:11434/v1/chat/completions` if omitted.

`Router.default` is set so a run that omits a model still works, but blox always
sends an explicit `provider,slug` per run, bypassing it.

## Data flow (routed run, end to end)

1. Wizard "Add models" → user picks OpenRouter, pastes key (and accepts/edits a
   starter model list) → IPC `modelAdd` → main `runCli(['model','add','openrouter','--key','…'])`
   → `writeProvider` upserts the block.
2. If `ccr` is absent, `ensureCcrInstalled()` runs `npm i -g
   @musistudio/claude-code-router` once. `host.runCli` returns only on
   completion (not streaming), so the wizard shows an optimistic "installing
   CCR…" then flips to done/failed on the result — no live progress promised.
3. Run screen mounts → `runCli(['model','list','--json'])` → `[native Claude] +
   union(all CCR provider models)` → dropdown.
4. User picks `openrouter,deepseek/deepseek-chat`, clicks run → `runStart`
   forwards it → `buildRunArgs` adds `--model openrouter,deepseek/deepseek-chat`.
5. CLI one-shot sees the comma → `ensureCcr(log)` (starts CCR if down,
   port-probe health) → `env: ccrRunEnv()` → `runOnce` → SDK routes through CCR.
   No comma → `buildAuthEnv()` native path, unchanged.

## Error handling

- **CCR not installed and install fails** → `ensureCcrInstalled` surfaces the
  failure + manual hint (`npm i -g @musistudio/claude-code-router`) to the
  wizard/log; provider add is rejected.
- **CCR installed but won't start** → `ensureCcr` returns false → run aborts,
  existing install/`ccr start` hint shown in the run log.
- **Bad OpenRouter key / local server down** → CCR upstream error → surfaces via
  the run's forwarded stderr to the log.
- **Routed model loops past completion** → `routedMaxTurns` cap (12) →
  `error_max_turns`, reported normally.
- **Mandatory-reasoning model 400s** → already handled: routed runs omit
  `thinking: adaptive` (`buildOptions.ts:83`). No new work.

## Testing

Unit (pure logic):
- `writeProvider`: OpenRouter and local inputs → correct CCR JSON; upsert
  replaces a same-named provider without dropping others; `Router.default` set;
  round-trips through `readCcrModels`.
- `readCcrModels`: union across multiple providers (regression on the old
  `[0]`-only behavior).
- `ccrRunEnv`: sets `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`, deletes
  `ANTHROPIC_AUTH_TOKEN` (moves with the lift; daemon test re-pointed).
- `buildRunArgs`: `--model` appended when set, omitted when not.

I/O (manual Windows smoke, no unit coverage):
- Wizard adds OpenRouter → routed prompt builds in Studio.
- Wizard adds local (Ollama running) → routed prompt builds.
- Native Claude run still works (no regression).
- CCR-absent box → install-on-first-use runs and the routed run then succeeds.

## Open decisions

- **CCR install (resolved):** install-on-first-use in v1
  (`npm i -g @musistudio/claude-code-router` when `ccr` absent, progress in the
  wizard, manual hint on failure). Assumes system node/npm present. Bundling CCR
  off Electron's node is a later hardening step if clean-box installs prove
  flaky.

## Future (tracked in `docs/superpowers/notes/future-features-backlog.md`)

Bedrock/Vertex/Gemini-native providers; bundle CCR; the broader native-routing
rework (own the proxy, drop external CCR) if CCR lifecycle proves the
robustness bottleneck.

# Tests and metrics through the eval bridge

Status: self-approved design (unattended run 2026-10-03). Queue item 4.

## Problem

Since Studio's Sep 2026 capability sandbox, server/client test specs and the
metrics bot can't run on the MCP execute_luau thread. Today blox injects
host scripts with `multi_edit` before Play, then scrapes results from
LogService in 3 KB chunks. That works, but it has costs. Every run needs
`multi_edit`, it restarts Play, results can come back cut off, and a spec
error points at the host script.

PR #69 added an opt-in plugin eval bridge (`bridge.eval: true`). It runs
code at game-script identity in a live playtest and returns the result
directly. Live 2026-10-03 in ~/blox-fw: a server probe took 1.3 s and a
client probe 0.3 s. `runLuau` already routes play contexts through the
bridge, but `run_tests` and `metrics` bypass it.

## Design

**Tests** (`runTests` play batches). When `session.evalBridge` is on, and every
play batch is *eligible*, the run goes through the bridge:
- Stop any running play and remove stale hosts. Then `startPlay`, which waits for a player and a character.
- Run each context's `testProgram` with `runLuau(…, ctx)`. This reuses `runBatch`, so the bridge returns results and maps error lines to spec files.
- Collect the logs as before, then stop play.

A batch is eligible when `bridgeDenyReason(program)` is null. The bridge
refuses HTTP, DataStores, loadstring and similar. Each bridge call is capped
at `BRIDGE_MAX_TIMEOUT_MS` (120 s); a suite that runs longer times out there
and reruns in hosts.

Ruling made during the live run: the first design also required the
worst-case deadline to fit in 120 s. That deadline is
`(timeout + 2 s) × 5 × specs + 30 s`, so any suite with two or more specs
missed it, and the bridge was never used.

**Fallback.** blox injects host scripts with `multi_edit`, exactly as today, in
two cases:
- A batch is ineligible. The bridge is never tried.
- The bridge throws: the plugin is missing, HTTP is off, or a pickup times
  out. blox stops play and reruns.

The result says which path ran in `via: 'bridge' | 'hosts'`, and `notes`
gives the reason for any fallback. `formatTestRun` prints both.

**Metrics.** With the bridge on, a non-idle bot is eligible when
`seconds + 15 ≤ 120` and the bot program passes the guardrail. In that case blox
starts Play, then runs a *blocking* bot program through the bridge. It has to
block: the bridge destroys its script when the probe returns, which would
kill a spawned bot. Then blox reads the dump. Otherwise it injects
`BloxBotHost` as today. If the bridge throws, blox stops play and falls back
to injection. The report notes record the path taken.

## Decisions

- **All-or-nothing per run.** Mixing bridge and hosts would need two Play
  sessions.
- **Fallback, not failure.** The bridge is an optimisation, and `multi_edit` injection is
  still the reference path.
- **No new config.** `bridge.eval` already means "use the bridge for play
  code".

## Testing

The bridge is mocked with `vi.mock` of `runLuauViaBridge`, using a fake
session with `evalBridge: true`. Cases:
- Bridge path: no `multi_edit`, results mapped, `via: bridge`.
- A denied spec forces hosts, with a note.
- A bridge throw falls back to hosts, with a note.
- The bridge off gives hosts, as before.
- Metrics, blocking bot through the bridge: no `multi_edit`, and the program
  has no `task.spawn`.
- Metrics, long run falls back to injection.

Live: `run_tests` in ~/blox-fw with server/client specs and the bridge on.

## Review rulings (2026-10-03)

- **HTTP during a bridge probe.** The plugin turns the server's
  `HttpEnabled` off while a probe runs, and a probe now spans the whole
  bot run or test batch.
  - For **metrics**, server errors matching `Http requests are not enabled`
    are dropped from `soak:errors` when the bot ran through the bridge.
    Each drop gets a note.
  - For **tests**, the output states that HTTP is off. A spec that needs
    live HTTP should mock it, or run with `bridge.eval` off.
- **Fallback scope.** blox falls back to injected scripts only for the
  bridge's own failures (`isBridgeFailure`): lane errors (now prefixed
  `eval bridge:`), guardrail refusals, and garbled replies. Anything else,
  such as no player joining or a Studio error, propagates. Otherwise the
  run would wait twice and the note would blame the bridge.

# P5-a: Team Policy + Audit Ledger (local-first)

Status: approved (design)
Date: 2026-06-23

## Context

P5 of the blox pivot roadmap is the "team tier alpha" — the first B2T
monetization signal. The full P5 spans several subsystems (shared policies,
audit log, optional hosted relay). This spec covers only the **local-first
slice**: shared policy enforcement via `blox.config.json` plus a per-run audit
ledger. The hosted relay (multi-user auth, remote dashboards, hard enforcement)
is a separate deferred slice.

Design borrows from enterprise AI governance: org/workspace **spend limits**
(including rolling/monthly caps, not just per-request), **model access
controls** (allowlists), and **usage logs with cost attribution** per user.
Mapped to a local-first tool: a committed `blox.config.json` is the "workspace
policy" a tech lead sets; the audit ledger is the usage log that makes a
*rolling* spend cap enforceable and gives cost attribution.

### What already exists (reused, not reinvented)
- `src/config.ts` — `BloxConfigSchema` + `loadConfig(cwd, overrides)` already
  reads `blox.config.json` and merges CLI overrides over file values. Fields:
  `model`, `maxTurns`, `maxBudgetUsd`, `mode`, `effort`, `panel`.
- `src/run.ts` — `runOnce(config, prompt, deps)` is the single chokepoint for
  both the CLI one-shot and the panel daemon. Returns a `RunReport` that already
  carries `costUsd`, `numTurns`, `commitSha`, `status`, `stopReason`,
  `sessionId`, `mode`, `effort`.
- `src/agent/guardrail.ts` — existing PreToolUse guardrail hook (path
  containment, HttpService/http_get blocks). Policy here is run-config
  enforcement, orthogonal to per-tool guardrails.
- Per-run budget today: SDK-native `maxBudgetUsd` stops the query with
  `error_max_budget_usd`. Cost + turns come back on the result
  (`total_cost_usd`, `num_turns`); raw token counts are NOT currently captured.

## Design

### 1. Config: add a `policy` block

Extend `BloxConfigSchema` with an optional `policy` object:

```jsonc
{
  "model": "claude-opus-4-8",          // team default (overridable per-run)
  "maxBudgetUsd": 5,
  "policy": {                           // the caps — set by lead, committed
    "models": ["claude-opus-4-8", "claude-sonnet-4-6"],  // allowlist
    "maxBudgetUsd": 10,                 // per-run ceiling
    "maxTurns": 60,                     // per-run ceiling
    "mode": "ask",                      // floor: can't downgrade ask -> auto
    "rollingBudget": { "windowDays": 30, "maxUsd": 200 },  // team cumulative cap
    "commitConvention": "blox: {prompt}" // optional commit msg template
  }
}
```

All `policy` fields optional; an absent field means "no constraint" for that
dimension. An absent `policy` block = current behavior unchanged (back-compat).

### 2. Enforcement: reject, do not silently clamp

New `enforcePolicy(effective: BloxConfig): void` (in `src/config.ts` or a small
`src/policy.ts`). Precedence is unchanged for the merge (CLI/dock override file
defaults), then the *effective* config is validated against `policy`:

- `model` not in `policy.models` (when set) -> reject.
- `maxBudgetUsd` > `policy.maxBudgetUsd` -> reject.
- `maxTurns` > `policy.maxTurns` -> reject.
- `mode` downgrades the policy floor (`policy.mode === 'ask'` but effective
  `mode === 'auto'`) -> reject.

Rejection is **loud** (thrown `PolicyError` with a clear message naming the
field, the requested value, and the cap), not a silent clamp — the user must
know their run was constrained. The CLI prints it and exits non-zero; the daemon
surfaces it as a run error to the dock.

`commitConvention`, when set, replaces the default commit message template used
in `runOnce` (`blox: ${prompt}`). `{prompt}` is the only supported token.

### 3. Audit ledger: `.blox/audit.jsonl` (committed)

New `src/audit.ts`. After a run completes, `runOnce` appends one JSON line:

```jsonc
{"ts":"2026-06-23T12:00:00.000Z","user":"tashany@gmail.com",
 "model":"claude-opus-4-8","turns":12,"costUsd":0.83,"status":"success",
 "commit":"a1b2c3d","prompt":"add a leaderboard","stopReason":"end_turn"}
```

- `user` = `git config user.email` (best-effort; `"unknown"` if unset).
- `prompt` stored verbatim (already committed to git as the commit message; no
  new disclosure).
- Path `.blox/audit.jsonl`, committed to the repo so the team shares visibility
  and cost attribution. Created on first run if absent.
- Append is the run's own write; it lands in the same auto-commit the run
  already makes (`commitChanges`), so the ledger entry ships with the change it
  describes.

`ponytail:` `.blox/audit.jsonl` is committed and append-only. Concurrent
team members can produce a git conflict on the trailing line; JSONL append
conflicts are rare and trivially resolved (keep both lines). Upgrade path if it
becomes painful = a merge driver or the hosted relay owning the ledger.

### 4. Rolling cap enforcement

Before a run (in the same place `enforcePolicy` runs): if
`policy.rollingBudget` is set, read `.blox/audit.jsonl`, sum `costUsd` of
entries with `ts` within `windowDays` of now, and if the sum is already
`>= maxUsd`, block the run with a `PolicyError`.

`ponytail:` this is an "already over?" check, not a predictive reservation —
the run's own cost is unknown until it finishes, so a run can overshoot the cap
by up to its own cost. Upgrade path = pre-run cost estimation or a hosted
reservation system. Named ceiling, acceptable for an alpha signal.

### Honesty about teeth (the real ceiling)

`blox.config.json` and `.blox/audit.jsonl` are committed files. A member can
edit the policy or skip `git pull`, so this slice is **strong-advisory +
honest usage signal**, not a hard multi-user gate. True enforcement requires
the hosted relay (deferred P5 slice). The value of building this now: the
policy schema and ledger format are exactly what the relay later consumes — so
it is foundation, not throwaway. This limitation is stated plainly in user docs.

## Components

- `src/config.ts` — extend `BloxConfigSchema` with `policy`; export `PolicySchema`.
- `src/policy.ts` (new) — `enforcePolicy(config)`, `PolicyError`, rolling-cap
  check (reads via `src/audit.ts`).
- `src/audit.ts` (new) — `appendAuditEntry(projectPath, entry)`,
  `readWindowSpend(projectPath, windowDays)`. Pure fs + JSONL; no deps.
- `src/run.ts` — call `enforcePolicy` before `runAgent`; append ledger after
  the report; use `policy.commitConvention` for the commit message.
- `src/panel/daemon.ts` — catch `PolicyError`, emit as a run error to the dock.
- `src/cli.ts` — catch `PolicyError`, print message, exit non-zero.

## Data flow

1. `loadConfig` merges file + CLI overrides -> effective `BloxConfig`.
2. `runOnce` calls `enforcePolicy(effective)`:
   - allowlist / ceiling / mode-floor checks -> reject loud on violation.
   - rolling-cap check via `readWindowSpend` -> reject if already over.
3. Run proceeds (unchanged).
4. After report assembled, `appendAuditEntry` writes the ledger line.
5. `commitChanges` (with `commitConvention` template) commits the change set
   including the new ledger line.

## Error handling

- `PolicyError` carries `{ field, requested, cap }` and a human message.
- CLI: print and exit non-zero before any agent work begins.
- Daemon: emit `run_finished` (or a dedicated `run_rejected`) error event so the
  dock shows why the run did not start.
- Audit append failure must NOT fail the run (visibility is best-effort):
  log a warning, continue. The run already succeeded; losing one ledger line is
  preferable to failing a completed run.
- Missing/corrupt ledger lines on read: skip unparseable lines, do not throw.

## Testing

- `enforcePolicy`: allowlist hit/miss, budget/turns at/over ceiling, mode
  downgrade rejected, absent policy = no-op, absent individual fields = no
  constraint.
- Rolling cap: window sum includes in-window, excludes out-of-window, blocks
  at/over `maxUsd`, passes under.
- `audit.ts`: append creates file, append round-trips, `readWindowSpend`
  skips malformed lines, handles missing file (returns 0).
- `runOnce` integration: policy reject short-circuits before `runAgent`;
  successful run appends exactly one ledger line; commit message uses the
  convention template.
- One runnable self-check covering the money/security path (policy reject +
  rolling-cap block) per the project's test conventions.

## Out of scope (deferred)

- Hosted relay, multi-user auth, remote dashboards, hard server-side
  enforcement (the other P5 slice).
- Raw token accounting (only cost + turns are captured today).
- Predictive cost reservation for the rolling cap.
- Per-field `locked` vs `default` granularity (rejected during brainstorming in
  favor of the simpler ceiling/allowlist model).
- Roles/RBAC (no server to host identity; git user.email is the only identity).

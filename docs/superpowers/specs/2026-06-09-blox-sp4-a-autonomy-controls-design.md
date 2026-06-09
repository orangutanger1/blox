# blox SP4-a — Per-Run Autonomy Controls

**Date:** 2026-06-09
**Status:** Design approved → ready for implementation planning

## 1. Context

SP4 is the "polish" phase of blox (master design §7/§8). It decomposes into four
independent slices:

- **A — Per-run autonomy controls** (THIS SPEC)
- **B — Non-Rojo onboarding**
- **C — Rich TUI**
- **D — Studio dock panel**

A, B, and D are mutually independent; C softly *consumes* A's controls (graceful
if A is absent). This spec covers **slice A**, chosen first because it is the
smallest, fully self-contained, and de-risks C (the TUI will surface these
controls).

Today the agent loop is fully autonomous and one-shot:

- `maxTurns` (default 40) and `maxBudgetUsd` (default 5) live in
  `BloxConfigSchema` and are settable only via `blox.config.json` — **not**
  exposed per run.
- Permission mode is `bypassPermissions` + `allowDangerouslySkipPermissions` —
  so the **stop-to-ask** behavior called for in master design §6 is **not
  implemented** at all today.
- Model effort is fixed at `thinking: { type: 'adaptive' }`; no high/xhigh knob.

## 2. Goal

Expose autonomy as **per-run overrides** on the CLI, and add the missing
stop-to-ask gate, without breaking the existing one-shot non-interactive flow.

Four knobs, all overridable per run:

| Flag | Maps to | Default |
|------|---------|---------|
| `--max-turns <N>` | `maxTurns` | 40 |
| `--budget <USD>` | `maxBudgetUsd` | 5 |
| `--effort <high\|xhigh>` | model effort | current (adaptive) |
| `--auto` / `--ask` | autonomy mode | `auto` |

**Precedence:** per-run flag > `blox.config.json` > schema default.

## 3. Autonomy mode (`--auto` / `--ask`)

`--auto` (default) preserves today's behavior exactly: `bypassPermissions`,
everything allowed, no prompts. Existing tests and e2e runs that assume full
autonomy are unaffected.

`--ask` gates a fixed set of **risky/expensive** actions. The inner code loop
(edit `.luau` + headless `execute_luau` asserts) stays fully autonomous; only
the slow/irreversible/credit-spending actions gate.

### 3.1 Gated set

Gated when the unqualified tool name (strip `mcp__<server>__` prefix) is one of:

- **Asset generation** (costs Roblox credits, irreversible spend):
  `generate_mesh`, `generate_material`, `generate_procedural_model`,
  `insert_from_creator_store`
- **Play-mode & input-sim** (side-effectful, slow, occasionally flaky):
  `start_stop_play`, `character_navigation`, `user_keyboard_input`,
  `user_mouse_input`

**Not gated** (read-only / polling / core loop): `search_creator_store`,
`wait_job_finished`, `get_console_output`, `execute_luau`, and the file tools
(`Read`/`Write`/`Edit`/`Grep`/`Glob`).

The gated list is **declared by the bridge** (`gatedTools()` on `StudioBridge`),
co-located with tool registration so it cannot drift as tools are added.

### 3.2 Enforcement — `canUseTool` deny-with-feedback

Chosen over a PreToolUse hook or pre-flight tool stripping because `canUseTool`
is the SDK's purpose-built permission seam and lets us (a) feed a structured
reason back to the model and (b) capture the exact blocked action + inputs for
the report.

In `--ask` mode `buildOptions` drops `bypassPermissions` and installs a
`canUseTool` callback:

- **Non-gated tool** → `{ behavior: 'allow' }`. Inner loop untouched.
- **Gated tool (first hit)** → `{ behavior: 'deny', message: ... }` where the
  message tells the agent the action needs approval, not to retry, and to
  summarize its intent and stop. The attempt (tool name + inputs) is recorded.

The agent receives the denial as feedback, self-explains in its final message,
and the run ends cleanly. Work completed before the gate is already committed by
the normal flow. To proceed, the user re-runs with `--auto` (or, later, slice
C's interactive approval / `resume`).

A task that genuinely requires a gated tool will always stop in `--ask` — this
is correct: it surfaces the expensive action for explicit approval.

### 3.3 Forward-compatibility hook

`runAgent` captures the SDK result `session_id` and surfaces it in the report so
slice C can add true `resume` later without rework. Implementing `resume` is a
**non-goal** here.

## 4. Components

Small, well-bounded edits plus one new pure module.

| File | Change |
|------|--------|
| `src/args.ts` | parse + validate `--max-turns`, `--budget`, `--effort`, `--auto`/`--ask`; reject invalid (e.g. `--max-turns 0`, non-positive budget, effort ∉ {high,xhigh}) |
| `src/config.ts` | extend `BloxConfigSchema`: add `mode` (`'auto'`/`'ask'`, default `'auto'`) and `effort` (default = current adaptive). `maxTurns`/`maxBudgetUsd` already present. `loadConfig` already applies flag-over-file-over-default precedence |
| `src/bridge/types.ts` + `mcpBridge.ts` + `mockBridge.ts` | add `gatedTools(): string[]` to `StudioBridge`; return the 8 suffixes, co-located with tool registration |
| `src/agent/permission.ts` **(new)** | pure builder: construct the `canUseTool` callback from a gated set; allow/deny logic; collect blocked attempts. Unit-testable in isolation |
| `src/agent/buildOptions.ts` | branch on `mode`: `auto` → `bypassPermissions` (today); `ask` → `canUseTool` callback + non-bypass mode. Wire `effort`, `maxTurns`, `maxBudgetUsd` from config |
| `src/agent/runAgent.ts` | capture `session_id`; collect blocked attempts; `classifyStop` gains `'gated'` |
| `src/report.ts` | render `mode` + `effort`; on gated stop list blocked actions + session id + "re-run with --auto to proceed" hint |
| `src/cli.ts` | thread parsed flags → `loadConfig` overrides |

## 5. Data flow (`--ask`)

```
user prompt + --ask
  → agent runs inner loop (edit .luau, execute_luau asserts) — all allowed
  → agent calls a gated tool (e.g. generate_mesh)
  → canUseTool denies w/ feedback, records {tool, input}
  → agent summarizes intent + stops
  → result: stopReason = 'gated'
  → report: blocked action(s), session id, "re-run with --auto to proceed"
```

`--auto` flow is unchanged from today.

## 6. Testing

**Unit:**
- arg parsing + precedence (flag > file > default) for all four knobs
- gated predicate: each of the 8 gated names → gated; each non-gated name → not
- `canUseTool` callback: allow non-gated; deny + record gated
- `classifyStop` maps the gated subtype → `'gated'`

**Mock-bridge e2e:**
- `--ask` + an asset-gen prompt → stop+report naming the blocked tool
- `--auto` → behavior unchanged

## 7. Non-goals (this slice)

- Interactive mid-run approval (readline / TTY prompt) — slice C
- Session `resume` — slice C (only the `session_id` capture hook lands here)
- Per-tool granular allowlists / denylists
- Any config UI

## 8. Open items for the plan phase

- Confirm the exact Agent SDK field for `--effort` high/xhigh (vs the current
  `thinking: { type: 'adaptive' }`) — verify against the SDK / claude-api skill
  during writing-plans rather than guessing here.
- Confirm the SDK's `canUseTool` return shape and how a deny surfaces as a
  result subtype (to wire `classifyStop`'s `'gated'` mapping).

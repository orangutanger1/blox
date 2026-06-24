# P5-b: Usage Report (local-first)

Status: approved (design)
Date: 2026-06-24

## Context

P5 of the blox pivot roadmap is the team-tier alpha. [[P5-a]] (PR #27 → ee2a19e)
shipped the plumbing: a `policy` block in `blox.config.json` and a committed
`.blox/audit.jsonl` usage ledger. The ledger is **written** every run and
**read** by `readWindowSpend` to enforce the rolling cap — but nothing surfaces
it to a human. A tech lead commits the ledger yet can only see spend or
attribution by eyeballing JSONL.

This slice (P5-b) closes that gap: a usage report that aggregates the committed
ledger into per-user / per-model / rolling-window cost attribution, rendered in
three places — CLI, the existing panel HTTP endpoint, and the Electron desktop
app.

It is deliberately **local-first**, like P5-a: it reads the committed ledger, no
server, no auth. The aggregation it produces (`UsageSummary`) is the same shape a
future hosted-relay dashboard (P5-c) will serve, so this slice also locks the
relay's payload format. Foundation, not throwaway.

### What already exists (reused, not reinvented)
- `src/audit.ts` — `AuditEntry` (ts, user, model, turns, costUsd, status,
  commit, prompt, stopReason), `appendAuditEntry`, and `readWindowSpend`, which
  already opens `.blox/audit.jsonl`, splits lines, and best-effort-parses each
  (skipping malformed). The per-line parse loop is the thing to extract and
  reuse.
- `src/config.ts` — `PolicySchema.rollingBudget` is `{ windowDays, maxUsd }`
  (both positive). This is the report's default window + cap.
- `src/panel/server.ts` — `PanelServer` already routes `GET /api/v1/*`, binds
  `127.0.0.1` only, and holds `opts.project` (the project path → the ledger).
- `app/shared/panelClient.ts` — `createPanelClient(base)` is the renderer's HTTP
  client; `app/renderer/console.ts` already fetches the panel over
  `window.blox.panelBase()` (`http://127.0.0.1:35768`).
- **Naming:** `src/report.ts` is already taken (the per-*run* `RunReport` /
  `formatReport`). The new module is `src/usageReport.ts`; the user-facing CLI
  word `report` is still free as a subcommand.

## Design

### 1. The one shape: `UsageSummary`

One pure module `src/usageReport.ts` owns the shape and the two pure functions
that produce/render it. Four consumers (CLI table, `--json`, HTTP endpoint,
renderer) share it, and it is the future relay payload.

```ts
export interface UsageBucket {
  key: string;      // user email or model id; '(unknown)' when the field is absent
  costUsd: number;
  runs: number;
}

export interface UsageSummary {
  window: { days: number | null; since: string | null }; // null/null = all-time
  totalUsd: number;
  capUsd: number | null;   // policy.rollingBudget.maxUsd, else null
  capPct: number | null;   // totalUsd / capUsd, else null
  runCount: number;
  errorCount: number;      // entries with status === 'error'
  byUser: UsageBucket[];   // sorted by costUsd desc, then key asc
  byModel: UsageBucket[];  // sorted by costUsd desc, then key asc
}
```

### 2. Aggregation (pure)

```ts
export function aggregateUsage(
  entries: AuditEntry[],
  opts: { now: Date; windowDays?: number | null; capUsd?: number | null },
): UsageSummary;
```

- **Windowing:** if `windowDays` is a positive number, keep entries with
  `Date.parse(ts) >= now - windowDays*86_400_000`; entries with an unparseable
  `ts` are dropped from a windowed report (same rule `readWindowSpend` uses) and
  kept in an all-time report (`windowDays` null/absent). `window.since` is the
  ISO cutoff when windowed, else null.
- **Bucketing:** group by `user` and by `model`; a missing/empty field buckets
  under `(unknown)`. Sum `costUsd`, count runs per bucket. `costUsd` non-number →
  treated as 0 for the sum (mirrors `readWindowSpend`’s guard).
- **Totals:** `totalUsd` = sum of bucket costs; `runCount` = entries in window;
  `errorCount` = those with `status === 'error'`.
- **Cap:** `capUsd` passed through from `policy.rollingBudget.maxUsd`;
  `capPct = capUsd ? totalUsd / capUsd : null`.
- Pure: no fs, no clock of its own — `now` injected. Trivially testable.

### 3. Ledger reader (extract + reuse)

Extract `src/audit.ts`'s per-line parse into:

```ts
export function readAuditEntries(projectPath: string): AuditEntry[];
```

Returns `[]` when the file is absent; skips malformed lines (best-effort, as
today). Refactor `readWindowSpend` to call it (or share the loop) so there is one
parser. Behavior-preserving — existing P5-a tests must still pass.

### 4. Render (pure)

```ts
export function renderUsageTable(s: UsageSummary): string;
```

A plain-text terminal table: a header with the window, a `used $X / cap $Y
(NN%)` line with an ASCII bar when a cap is set (`used $X` only when not), then
`By user` and `By model` sections (key, cost, runs), then a footer with run and
error counts. Money formatted to 2 decimals. No color, no deps.

### 5. CLI: `blox report`

Add `report` to the `command` union in `src/args.ts`, plus two flags:
- `--since <Nd>` — window override (e.g. `--since 7d`; bare integer = days).
  Parsed to a positive integer day count; rejects non-positive.
- `--json` — emit `JSON.stringify(summary, null, 2)` instead of the table.

In `src/cli.ts`, a `command === 'report'` branch:
1. `loadConfig(cwd, …)` — for `policy.rollingBudget` (default window + cap).
2. Window = `--since` if given, else `policy.rollingBudget?.windowDays ?? null`
   (null = all-time). Cap = `policy.rollingBudget?.maxUsd ?? null`.
3. `readAuditEntries(config.projectPath)` → `aggregateUsage(entries, { now,
   windowDays, capUsd })`.
4. `--json` ? print JSON : print `renderUsageTable(summary)`. Exit 0.

`--since` and `--json` are report-only flags; they reuse the existing flag-parse
loop in `args.ts` and are ignored by other commands (consistent with how
`--force`, `--image`, etc. already coexist).

### 6. Panel endpoint: `GET /api/v1/usage`

Add one route to `PanelServer.route`:

```
GET /api/v1/usage?since=<Nd>   → 200 UsageSummary (JSON)
```

- Reads the ledger from `this.opts.project` via `readAuditEntries`.
- Window: `since` query param if valid, else null (all-time). The daemon does
  **not** currently hold the parsed policy, so v1 keeps the endpoint
  config-light: `capUsd` null unless `since` is supplied — *or* pass the cap in
  when the daemon constructs the server (see Open question). Either way the
  endpoint never throws: read failure → `500 { error }`; the daemon stays up
  (same "observability never breaks the run" rule the rest of the server holds).
- `127.0.0.1`-only inherited from the existing server bind — usage data never
  leaves the machine.

### 7. Renderer: Usage view

- `app/shared/panelClient.ts`: add `usage(sinceDays?: number)` →
  `getJson<UsageSummary>('/usage' + (sinceDays ? `?since=${sinceDays}d` : ''))`.
  Returns null on any error (existing graceful-degrade contract). Import the
  `UsageSummary` type from a shared location (see Open question on type sharing).
- `app/renderer/console.ts`: add a collapsed **Usage** section below the run
  console — a "Refresh usage" button that calls `client.usage()` and renders the
  summary as an HTML table plus a spend bar (`capPct`). On null, show "usage
  unavailable". No live polling — refresh on demand (lazy; the ledger only
  changes when a run finishes).

## Data flow

```
.blox/audit.jsonl
   │  readAuditEntries(projectPath)         (src/audit.ts, shared parser)
   ▼
AuditEntry[]
   │  aggregateUsage(entries, {now, windowDays, capUsd})   (pure)
   ▼
UsageSummary ──► renderUsageTable  → CLI stdout (table)
             ├─► JSON.stringify    → CLI stdout (--json)
             ├─► GET /api/v1/usage → renderer / dock (HTTP)
             └─► (future) hosted relay dashboard payload
```

## Error handling

| Case | Behavior |
| --- | --- |
| No ledger file | empty `UsageSummary` (zeros, empty buckets), exit 0 / 200 |
| Malformed JSONL line | skipped (best-effort, as P5-a) |
| Missing `user`/`model` | bucketed under `(unknown)` |
| Non-number `costUsd` | counted as a run, contributes 0 to cost |
| Bad `--since` | CLI error, exit 2 (matches existing flag-validation pattern) |
| Endpoint read failure | `500 { error }`, daemon stays up |
| Renderer fetch failure | `usage()` returns null, view shows "usage unavailable" |

## Testing

- **Unit `aggregateUsage`** — windowing (in/out by ts, unparseable ts dropped
  when windowed / kept all-time), user+model bucketing, `(unknown)` bucket,
  cap% math, `capUsd` null, non-number cost, empty input, sort order.
- **Unit `renderUsageTable`** — cap vs no-cap line, bar, empty summary.
- **Unit `readAuditEntries`** — absent file → `[]`; skips malformed; and
  `readWindowSpend` unchanged (existing P5-a tests stay green).
- **CLI** — temp ledger → `blox report` table, `--json` shape, `--since`
  override, bad `--since` exits 2.
- **Endpoint** — `GET /api/v1/usage` returns a summary against a `PanelServer`
  with a temp project (supertest-style, as existing server tests); read-failure
  path → 500.
- **Renderer** — `panelClient.usage()` parses a summary / returns null on error
  (vitest, as `panelClient.test.ts`).

## Scope / YAGNI

**In:** the four consumers above; per-user + per-model + rolling-window cost
attribution; run + error counts.

**Deferred:** per-run table dump (that is the raw JSONL); trends/charts over
time; CSV/export; Studio dock tab (the in-Studio Luau plugin — separate
out-of-repo surface, live-smoke needed); predictive cost reservation and raw
token accounting (carried over from P5-a deferrals); auth / multi-user / remote
enforcement (that is P5-c, the hosted relay).

## Open questions (resolve during planning)

1. **Type sharing for `UsageSummary`** — the renderer (`app/`) and engine
   (`src/`) are separate TS projects. Options: (a) re-declare the interface in
   `app/shared/` (duplication, simplest, matches how `PanelInfo` is already
   mirrored there); (b) a shared types file. Lean (a) to match the existing
   `panelClient.ts` mirroring pattern.
2. **Endpoint cap** — whether the daemon passes `policy.rollingBudget` into the
   server at construction so `/api/v1/usage` can report `capUsd`/`capPct`
   without a `since` param, or v1 ships cap only on explicit `since`. Lean:
   thread the policy in once at `startDaemon` (cheap, and the cap is the most
   useful number in the UI).

# design.json + economy simulator — design

Pipeline item 1 of the build order in `docs/research/2026-10-01-roblox-game-pipeline.md` §R
(report §K "Pre-launch balancing", §P "Game design spec" / "Economy balance" rows).

## Goal

Give any agent a machine-checked game design document (`.blox/design.json`) and an
offline, deterministic economy simulator that turns it into pacing curves and
pass/fail assertions ("first egg ≤ 60 s", "first rebirth at 45–60 min",
"no stall > 5 min") **before** anything is built or playtested. The same document
compiles into a Luau module the game reads, so the simulated numbers and the shipped
numbers cannot drift. Later pipeline items (format kits, FTUE metrics, live-ops) read
and tune this same file.

Success:

- An agent can `set` a design, `simulate` it, read which assertions fail and why,
  edit tunables, re-simulate, and `codegen` — all through one tool, over MCP or CLI,
  with no Studio session.
- The two example designs (+1 incremental, steal tycoon) validate and pass their own
  assertions.
- Sim runs are deterministic per seed; 50 runs × 7 days finish in about a second.

## Decisions

- **Source of truth:** design.json tunables are code-generated into
  `src/ReplicatedStorage/Design/Tunables.luau`; game code requires it. No in-Studio
  drift check in v1.
- **Model:** one generic, data-only resource graph + policy bots (not per-format sim
  code, not closed-form only). Exotic loops (rounds, survival) extend later.
- **Language:** TypeScript (runs in vitest, no Lune dependency).
- **Gating:** sim assertions are deterministic and may gate task criteria. Prices and
  monetization choices stay human decisions; the doc holds monetization *effects*
  only, never prices.

## Architecture

All new code in `src/design/`, pure (no Studio, no network):

| File | Responsibility |
|---|---|
| `schema.ts` | zod schema + `DesignDoc` type; `validateDesign(raw)` → `{ ok, doc, errors[] }` with JSON paths; semantic checks |
| `sim.ts` | `simulate(doc, { archetype, horizonSec, seed }) → Trace` (event list + sampled curves) |
| `metrics.ts` | trace → metric values; Monte-Carlo aggregation → p10/p50/p90 |
| `assert.ts` | evaluate `doc.assertions` against aggregated metrics |
| `codegen.ts` | `renderTunables(doc) → string` (Luau source) |
| `report.ts` | text summary for the tool; JSON written to `.blox/sim-report.json` |

**Registry tool `design`** in `src/tools/registry.ts` (served over MCP and as
`blox design <action>` via the existing CLI mapping). The handler never touches
`ctx.session`.

| Action | Args | Effect |
|---|---|---|
| `get` | — | print `.blox/design.json` (or "no design") |
| `set` | `doc` (object) | validate; on success write `.blox/design.json`; on failure write nothing, return errors |
| `validate` | — | validate the stored doc |
| `simulate` | `archetypes?: string[]`, `horizon?: number` (s), `runs?: number`, `seed?: number` | run sims, evaluate all assertions, write `.blox/sim-report.json`, return pass/fail table + key curve points |
| `codegen` | — | refuse if invalid; write `Tunables.luau`; report path |

**Task criteria binding.** A task criterion with `tests: ["design:<assertionId>"]` gets
its status from the last `simulate` (read from `sim-report.json`), mirroring how
test-bound criteria read `last-tests.json`. `evaluateCriteria` gains this source.

**Agent guide.** `src/agentGuide.ts` gets a short section: design → simulate → fix
curves → codegen → build; game code must read numbers from `Tunables`, not literals.

## Schema (`version: 1`)

Two halves. **Descriptive** fields are shape-validated and consumed by later items.
**Economy**, **archetypes** and **assertions** drive the simulator.

```jsonc
{
  "version": 1,
  "meta": { "title": "Carve a Snow Beast", "format": "steal-tycoon", "verb": "Carve", "object": "snow beast", "serverSize": 6 },
  "loop": ["train", "raid", "hatch", "upgrade", "rebirth"],
  "ftue": [{ "id": "first-action", "text": "Step on the treadmill", "targetSec": 5 }],
  "monetization": [{ "id": "cash2x", "kind": "pass", "effect": "upgrade:cash2x" }],
  "economy": {
    "resources":  [{ "id": "cash", "start": 0 }, { "id": "speed", "start": 16, "spendable": false }],
    "actions":    [{ "id": "step", "yields": { "speed": 1 }, "perSec": 2 }],
    "generators": [{ "id": "dropper", "produces": { "cash": 1 }, "cost": { "res": "cash", "base": 10, "growth": 1.15 }, "max": 50, "requires": "gate:zone2" }],
    "upgrades":   [{ "id": "cash2x", "cost": { "res": "cash", "base": 500, "growth": 1 }, "effect": { "target": "cash", "mult": 2 }, "max": 1 }],
    "gates":      [{ "id": "zone2", "needs": { "res": "speed", "amount": 100, "consume": false } }],
    "chance":     [{ "id": "egg1", "cost": { "res": "cash", "base": 25, "growth": 1 }, "outcomes": [{ "id": "common", "weight": 90, "grants": { "income:cash": 0.5 } }, { "id": "rare", "weight": 10, "grants": { "income:cash": 3 } }] }],
    "rebirth":    { "needs": { "res": "cash", "base": 10000, "growth": 2.5 }, "mult": { "target": "*", "per": 1.5 }, "resets": ["cash", "generators", "upgrades"] },
    "offline":    { "fraction": 0.5, "capSec": 28800 },
    "drains":     [{ "id": "theft", "res": "cash", "fractionPerHour": 0.05 }]
  },
  "tunables": { "shieldSec": 60, "guardianSpeed": 18 },
  "archetypes": [{ "id": "active", "session": { "lengthSec": 900, "perDay": 2 }, "policy": "roi", "owns": [] }],
  "assertions": [
    { "id": "first-egg", "archetype": "active", "metric": "timeTo", "target": "chance:egg1", "op": "<=", "value": 60 },
    { "id": "rebirth1", "archetype": "active", "metric": "timeTo", "target": "rebirth:1", "op": "between", "value": [2700, 3600], "pct": 50 },
    { "id": "no-stall", "archetype": "active", "metric": "maxIdleGap", "horizon": 86400, "op": "<=", "value": 300 }
  ]
}
```

### Field semantics

- **resources** — currencies and stats in one list. `spendable: false` (stat) may be a
  gate requirement but never a cost.
- **actions** — active verbs; yield only while the archetype is in a session.
  `perSec` is the action rate. Optional `requires`.
- **generators** — passive income per owned unit. Cost of the n-th unit (0-based
  owned count n) = `base · growth^n`. Optional `max`, `requires`.
- **upgrades** — multiplier (`mult`) or flat (`add`) effect on a resource's income
  (`target` = resource id or `*` for all income). Optional `max`, `requires`.
- **gates** — zones/tiers. `needs` a resource amount; `consume: true` spends it.
  A gate opens once and stays open (until a rebirth resets it, if listed in `resets`).
- **chance** — paid rolls (eggs, crates). Outcomes are weighted; `grants` adds
  `income:<res>` per second or a one-off `res:<res>` amount. Rolled with the seeded PRNG.
- **rebirth** — n-th rebirth needs `base · growth^n` of `res`. Each rebirth multiplies
  the `target` income by `per` (compounding). `resets` lists resource ids and the
  keywords `generators`, `upgrades`, `gates`, `chance`.
- **offline** — between sessions, generators accrue at `fraction` of the online rate
  for at most `capSec` per gap.
- **drains** — continuous loss as a fraction of the balance per hour, on- and offline.
  Social pressure such as theft is modelled as a rate, not real PvP.
- **monetization `owns`** — the sim applies `upgrade:` effects (granted at max, re-granted
  after rebirth); other effect kinds validate but are ignored by the sim in v1.
- **tunables** — non-economy numbers/strings/booleans; codegen only.
- **archetypes** — `session` (`lengthSec`, `perDay`; sessions evenly spaced over the
  day), purchase `policy`, and `owns` (monetization ids applied from t=0, to compare
  payers against free players).
- **assertions** — `metric` ∈ `timeTo` (target: `gate:<id>`, `chance:<id>`,
  `generator:<id>[:n]`, `upgrade:<id>`, `rebirth:<n>`), `countAt` (target + `at`
  seconds), `balanceAt` (res + `at`, wall clock only), `maxIdleGap` (longest in-session span with
  no progression event: no purchase, gate opening, roll or rebirth), `ratio` (metric `of` on two
  archetypes: `archetype` / `vs`). `op` ∈ `<=`, `>=`, `between`. `pct` ∈ 10/50/90,
  default 50. `clock` ∈ `play` (default: in-session seconds) / `wall`.
  `horizon` (wall seconds) on `maxIdleGap` limits the window and extends the sim
  horizon if needed.

### Semantic validation

Beyond shape: every ref (`gate:`, `upgrade:`, `res`, `effect`, `owns`, archetype ids)
resolves; ids unique per kind; `growth ≥ 1`; weights > 0 and sum > 0; costs only on
spendable resources; `between` has `[lo, hi]` with lo ≤ hi; every gate's `needs.res`
can increase (some action, generator or chance produces it). Errors are a list of
`{ path, message }`.

## Simulator

- **Clock.** 1 s ticks, with event skipping: when nothing is affordable and the state
  only changes by constant rates, jump analytically to the earliest of (next
  affordable purchase, next gate threshold, session edge, horizon).
- **In session:** actions + generators × multipliers, minus drains; the policy then
  buys (possibly several items per tick). **Out of session:** offline accrual, then
  drains.
- **Policies.**
  - `roi`: buy the affordable item with the lowest payback (cost ÷ income gained);
    take a gate or rebirth as soon as it is available. Gates with
    `consume: false` open automatically when the threshold is reached.
  - `cheapest`: buy the cheapest affordable item.
  - `saver`: like `roi`, but goals (consumable gates, rebirth) score at half their
    time-to-afford, so it saves for them more readily.
  - Every policy falls back to the cheapest affordable item when no candidate has a
    finite score (no income yet).
  Chance rolls use the expected income gain for ROI ranking.
- **Randomness.** mulberry32 seeded per run (`seed + runIndex`). Same seed → identical
  trace.
- **Defaults.** runs 50, horizon 86400 s, seed 1; percentiles p10/p50/p90.
- **Guardrails.** Event cap (2,000,000 per run) → "runaway economy" error naming the
  last purchased item. Non-finite balance → error naming the source. Targets never
  reached → metric `Infinity`, reported "never (within horizon)", assertion fails.

## Codegen

`src/ReplicatedStorage/Design/Tunables.luau`:

```luau
-- GENERATED from .blox/design.json by `blox design codegen`. Do not edit.
return table.freeze({
	economy = table.freeze({ ... }),
	tunables = table.freeze({ ... }),
	monetization = table.freeze({ ... }),
})
```

Deep-frozen tables, keys sorted, ids as string keys, arrays as Luau arrays, numbers
printed exactly (`1e4` → `10000`). Idempotent: same doc → byte-identical file.
`simulate` never writes it; `codegen` is explicit.

## Errors

- Invalid doc on `set`/`validate`/`codegen` → `isError`, nothing written, errors
  listed with paths.
- Missing `.blox/design.json` on `validate`/`simulate`/`codegen` → `isError` with hint
  to `set` one.
- Sim guardrail errors as above.

## Testing (vitest, TDD)

- Schema: accept/reject fixtures for each semantic rule.
- Sim on toy economies with closed-form answers: one generator (time-to-N),
  offline cap, drains, rebirth reset + multiplier, gate with `consume`,
  seeded chance determinism, event skipping matches the plain 1 s loop.
- Metrics and assertion ops, including `Infinity`, `between`, `ratio`, `pct`.
- Codegen golden snapshot; output is deterministic; braces balanced.
- Tool handler through `invokeTool` on a temp project (set → simulate → codegen;
  invalid set writes nothing).
- Criteria binding: `design:<id>` criterion status follows the last sim report.
- Examples `docs/examples/design/incremental.json` and `steal-tycoon.json` validate
  and pass their own assertions. They seed format kits (item 2).
- Performance: 50 runs × 7 days under 2 s in CI.
- `npx tsc --noEmit` clean.

## Out of scope

Real multiplayer theft (item 4), in-game FTUE measurement (item 3), live-ops tuning
(item 8), dashboard charts (the report JSON is written now, rendered later), prices
and monetization decisions (human gate), in-Studio drift check.

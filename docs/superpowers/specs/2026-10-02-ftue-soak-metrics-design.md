# FTUE + soak playtest metrics (pipeline item 3)

Research §J/§R.3: discovery now weighs retention, so the agent must measure game feel,
not just "no errors". Deterministic numbers from a real playtest gate; nothing here is
LLM judgment.

## Pieces

1. **BloxTelemetry.luau** (server ModuleScript in `src/ReplicatedStorage/`), installed by
   `metrics {action:"install"}` and by every kit apply (`kits/_common`).
   - `start()` (idempotent): records each player's join clock; auto step
     `auto:first-currency` on the first increase of any `leaderstats` value; samples
     every 5 s: `Stats:GetTotalMemoryUsageMb()` and leaderstats values; exposes
     `ServerStorage.BloxTelemetry` (BindableFunction, `Invoke("dump")` → JSON).
   - `step(player, id)`: first occurrence only, seconds since that player joined; also
     `AnalyticsService:LogOnboardingFunnelStepEvent(player, index, id)` when `id` is in
     the design's FTUE order (`Tunables.ftue`, codegen now emits it) — production
     funnel dashboards for free.
   - `event(player, name, value?)`: timeline (kits log `purchase:<ref>`, `rebirth`).
2. **Pure evaluation** (`src/metrics/gamefeel.ts`):
   - FTUE: each `design.ftue[i]` → `ftue:<id>` passes when the step happened within
     `targetSec`; `ftue:auto:first-currency` ≤ 60 s budget (format default).
   - Soak: `soak:errors` (0 runtime errors), `soak:memory` (least-squares growth over
     the second half of samples ≤ 10 MB/min, ≥ 3 samples), `soak:pace` (optional,
     `archetype` given: for each item the simulator buys within the soak window,
     observed first `purchase:<ref>` time within `[sim/tol − 15 s, sim·tol + 15 s]`,
     default tol 2).
3. **`metrics` tool** (MCP + CLI): `ftue {seconds=60, bot?}` | `soak {seconds=300, bot?,
   archetype?, tolerance?}` | `install`. Starts a playtest, launches the bot on the
   server immediately, waits, dumps telemetry, collects logs, stops, evaluates, writes
   `.blox/metrics-report.json`, and returns pass/fail. Failing checks = `isError`.
   Results are synthetic tests (`ftue:<id>`, `soak:<check>`) so task criteria bind to
   them exactly like `design:<id>` (store helper renamed `withSyntheticResults`).
4. **Bots**: `bot` = `"walk"` (built in: back-and-forth MoveTo), `"idle"`, or a project
   file returning `function(player, deadline)` that runs on the server (inlined, since
   playtest DataModels have no loadstring). The incremental kit ships
   `bots/active.luau` (walk the track + buy the cheapest affordable item, i.e. the
   simulator's `cheapest` policy) and its design gains a `bot` archetype matching it.

## Non-goals
Client-side steps, multi-client soak (item 6), frame-time capture (no API), modal counting (item 4 UI lint).

## Verification
Pure evaluation unit tests; tool orchestration against `tests/fakeStudio.ts`; Telemetry
recorder logic compile-checked under Lune. Live smoke pending: kit project →
`metrics ftue --bot walk` and `metrics soak --bot bots/active.luau --archetype bot`.

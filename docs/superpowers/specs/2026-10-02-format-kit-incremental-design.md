# Format kit: +1 incremental (pipeline item 2)

Research report §R.1: agents are far more reliable assembling and customizing tested
systems than inventing them. A **format kit** is a proven-loop reference
implementation an agent drops into a project and then reskins/tunes. This spec covers
the kit mechanism plus the first kit, `incremental` (the "+1 Speed" family: move →
gain a stat → break walls → buy pets → rebirth).

Steal tycoon is deferred to after the multiplayer lane (item 6): theft cannot be
verified solo.

## Goals

- `kit` tool (MCP + CLI): `list` kits, `apply` one into the project non-destructively.
- Apply = Luau source + world builder + specs + `.blox/design.json` + generated
  `Tunables.luau`, so the game's numbers are the simulated numbers from day one.
- The kit's runtime economy is **the same math as the simulator** (item 1): rates,
  cost growth, upgrade mult/add, rebirth reset + multiplier, gate thresholds, offline
  accrual, drains. A parity test runs both on the same states and compares.
- Pure-logic Luau modules are verified offline (Lune) in the blox test suite, and in
  Studio by the project's own `edit` specs. Server/client glue is verified in Studio
  (`server` specs) — a pending live smoke when Studio is not reachable.

## Non-goals

- Polished UI (item 4 replaces the kit HUD with the UI kit).
- Monetization wiring (MarketplaceService) — product human gate; the kit only reads
  `owns` for archetype simulation. A `grantPass(player, id)` server hook exists so a
  human can wire real purchases later.
- Multiplayer behaviour beyond "each player has independent state".

## Kit layout (in the blox repo)

```
kits/incremental/
  kit.json                       {name, title, format, description, next[]}
  design.json                    default design (passes its own assertions)
  files/                         copied into the project (paths relative to project)
    src/ReplicatedStorage/Kit/Economy.luau     pure: state, cost, rates, purchase, tick, rebirth, offline
    src/ReplicatedStorage/Kit/Format.luau      pure: number abbreviation, time
    src/ServerScriptService/Kit/KitService.luau  server: data load/save, tick loop, remotes, leaderstats
    src/ServerScriptService/KitMain.server.luau  KitService.start()
    src/StarterPlayerScripts/KitHud.client.luau   minimal HUD (currencies, shop, rebirth), gate walls passable
    world/Track.luau                              spawn + walls per gate, labelled with thresholds
    tests/kit_economy.spec.luau   (edit)  pure economy behaviour
    tests/kit_format.spec.luau    (edit)
    tests/kit_server.spec.luau    (server) join → state/leaderstats; grant → gate opens; purchase; rebirth
```

`kits/` ships with the package (repo-relative lookup from the compiled module).

## Economy.luau contract

State: `{ bal = {res=n}, owned = {[ref]=n, rebirth=n}, open = {[gateId]=true}, chanceIncome = {res=n} }`
— JSON-able, so it is the saved data shape too.

- `Economy.new(T)` where T is the Tunables table (id-keyed maps from codegen).
- `newState()`; `cost(state, ref) -> amount, res`; `available(state, ref) -> bool, reason?`
- `purchase(state, ref, rng?) -> ok, err` — validates requires/max/affordability; deducts;
  increments; chance rolls with `rng()` in [0,1) (defaults to `math.random`); consume-gates open.
- `rates(state, online) -> {res=perSec}` — identical formula to `sim.ts` rates.
- `tick(state, dt, online) -> opened{}` — closed-form advance (linear, or exponential
  approach under drains), then auto-open threshold gates; returns newly opened gate ids.
- `offline(state, elapsedSec)` — generator income × fraction, capped, plus drains.
- `canRebirth(state)`, `rebirth(state) -> ok, err` — cost, resets per `resets`, count+1.
- `grant(state, monetizationId)` — pass effect `upgrade:<id>` → owned at max (mirrors sim).
- `items()` — refs sorted by base cost (stable display order).

## kit tool

`kit {action:"list"}` → table of kits.
`kit {action:"apply", name}` → copies `files/` (skips existing files; reports kept),
writes `.blox/design.json` if absent (else keeps it), regenerates Tunables from the
project's design, prints created/kept and next steps (`kit.json.next`). Unknown kit →
readable error listing kits. CLI: `blox kit [list]`, `blox kit apply <name>`.

## Verification

- vitest: kit tool (apply into temp dir, idempotent second apply, keeps an edited
  file, unknown name), kit design passes its own sim assertions.
- vitest + Lune (skipped when no `lune` binary; `BLOX_LUNE` overrides): runs the kit's
  `edit` specs offline through a small spec harness that maps
  `game:GetService("ReplicatedStorage")` to `src/ReplicatedStorage` files, and a
  parity test comparing Luau `rates`/`tick`/`cost` to the TS simulator on scripted
  purchase sequences.
- Live Studio smoke (pending): `kit apply incremental` in a fresh project →
  `run_tests` all green → `playtest` walk into wall1.

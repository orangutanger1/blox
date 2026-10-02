# Steal-tycoon kit — design

Second format kit (`blox kit apply steal`), the 2025–26 breakout format (Steal a
Brainrot → Steal An Egg; see docs/research/2026-10-01-roblox-game-pipeline.md).
Same contract as the incremental kit: every number in `.blox/design.json`, a
server-authoritative economy that matches `design simulate`, edit specs that run
offline (Lune), a multiplayer spec on the mp lane, a soak bot.

## Loop

buy a pet at the market → it sits in your base and earns cash/sec (also offline)
→ buy rarer pets / income upgrades → steal pets from other bases and carry them
home → lock your base when raiders come → rebirth.

## Economy (Economy.luau, shared with the incremental kit via kits/_common)

- Resource `cash`.
- Generators = pet rarities: `common`, `rare`, `epic`, `legendary`
  (produces cash, cost grows per owned, per-kind max).
- Upgrade `income` (cash ×1.25, max 10). Rebirth (×1.5 all income).
- The market has one stand per rarity, always buyable, so the simulator's model
  (buy any affordable item) is the live game; random conveyor offers are a
  reskin choice that would need a sim change.

## Stealing (StealRules.luau, pure, clock injected; KitService applies it)

- Steal: thief ≠ owner, owner's base not locked, owner owns ≥1 of that kind,
  thief not already carrying, thief within `stealRange` studs of the owner's
  plot. The pet leaves the owner at once (in transit) and rides on the thief.
- Deliver: thief's root within `plotRadius` of their own plot → +1 to the thief
  if they have a free slot (total ≤ `baseSlots` and per-kind max), else it
  returns.
- Fail → the pet returns to the owner: thief dies or leaves, carry exceeds
  `carryMaxSec`, the owner touches the thief (within `tagRange`).
- Carrying slows the thief (`carrySpeedMult`).
- Lock: `lockSec` of protection, then `lockCooldownSec` before the next lock.
- Generator counts are the only pet state, so stealing is a ±1 on
  `owned["generator:<kind>"]`, and saves/offline work unchanged.

## World

`world/Bases.luau`: `serverSize` plots in a ring (Plot1..N, PlotIndex attribute,
slot positions, lock pad) around a central market with one stand per rarity.
The server assigns plots on join (Owner attribute) and renders each owner's pets
on their slots; each pet carries a "Steal" ProximityPrompt.

## Surfaces

- Remotes: Purchase(ref), Rebirth(), Steal(ownerUserId, kind), Lock().
- ServerStorage.KitApi (specs, bots): getState, grant, purchase, rebirth, steal,
  deliver, lock, carry, plot.
- HUD (BloxUI): cash bar, rail (Shop, Lock, Rebirth), carry/lock status line.

## Tests

- `kit_rules.spec` (edit): StealRules.
- `kit_economy.spec`, `kit_format.spec` (edit, now in _common).
- `kit_server.spec` (server): plot assignment, buy → pet on slot, earning,
  lock, steal+deliver via KitApi.
- `kit_steal.mp.luau` (2 clients): steal through the real remote and deliver;
  a locked base refuses; the owner tagging the thief returns the pet.
- Soak bot `bots/active.luau`: buys the cheapest affordable pet; pace vs the
  sim's `bot` archetype.

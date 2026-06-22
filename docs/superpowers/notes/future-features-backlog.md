# blox — future features backlog

Captured 2026-06-22 during multi-model-desktop brainstorming. Not specced yet;
parked here so they aren't lost. Ranked by leverage.

## Competitive positioning

blox = **external harness** (real file tools + git + Rojo sync + Studio MCP +
autonomous agent loop, model-agnostic). Competitors (Lemonade.gg, Superbullet,
etc.) = **in-Studio plugins** calling an LLM. blox's moat: real toolchain,
model choice, autonomy. blox's tax: setup friction, two-app dance, CCR
fragility.

## Efficiency / robustness levers

1. **Native model routing** — stop depending on a hand-configured external CCR
   daemon for non-Claude. (Desktop slice is being specced now; the deeper
   CLI+desktop rework is a separate, larger effort — see "Native routing,
   deeper" below.)
2. **Incremental digest** — `buildDigest` rebuilds project context every run;
   cache + diff only changed instances → fewer tokens/run.
3. **Warm Studio channel** — persistent Rojo serve + MCP + verify loop instead
   of cold spin-up per run; batch `execute_luau` verifies.
4. **Asset cache** — mesh/procedural jobs are slow + async; dedupe by
   prompt-hash.
5. **Eval harness** — benchmark a set of Roblox build tasks → objectively tune
   `routedMaxTurns` per model and prove model quality instead of guessing.
6. **Resume / replay** — record run transcript; resume after Studio disconnect
   (Codex-like).

## Larger rework candidates (own specs later)

- **Native routing, deeper** — desktop AND CLI stop depending on external CCR;
  blox owns the provider registry + proxy end-to-end. Superset of the
  multi-model-desktop slice.
- **Vision / strategy doc** — full competitive-positioning + roadmap writeup
  across all six levers before committing to feature order.

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
2. ~~**Incremental digest**~~ — KILLED 2026-06-26. Premise was wrong: the
   digest is a path/kind listing only (no script bodies) and already truncated
   at `MAX_PER_GROUP=30`, so its per-run token cost is small and fixed.
   `buildDigest`'s cost is a filesystem walk (ms), not tokens — caching it
   saves a directory scan, not tokens. YAGNI.
   - **Prompt caching** (the real "biggest token win") is ALSO not buildable —
     it's already on. blox runs on the Agent SDK (`query()`), handing it a
     `systemPrompt` string; the SDK/Claude Code sets `cache_control`
     breakpoints internally for native Claude. The SDK's `total_cost_usd`
     already reflects cache read/write pricing, which is what blox ledgers.
     There is no `messages.create` for blox to place breakpoints on. Nothing
     to build on the native path; CCR-routed (non-Claude) caching depends on
     the downstream provider, also outside blox's control.
   - Only residual: native `AuditEntry` records `costUsd`/`turns`, not
     `cache_read_input_tokens`, so cache hit-rate isn't *observable* (cost
     already benefits). Small optional observability follow-up, not a
     token-savings feature — do only if cache effectiveness needs measuring.
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

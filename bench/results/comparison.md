# Core-suite comparison (2026-10-01)

Three tasks (t2-coins, t6-door, t7-shop), one run per agent per task, against the same
throwaway Studio place. The place is reset before each task. Raw data:
`baseline-legacy.json` (t2), `baseline-legacy-t6t7.json`, `after-blox.json`,
`after-claude-code.json`.

**Cost basis (all sections below).** Every Claude run (Opus 4.8/5.5, blox runner and
Claude Code) used a Claude Pro subscription, not an API key. Their dollar figures are
the API-equivalent price the SDK computes from tokens: nothing was charged, but the
runs counted against plan limits. OpenRouter runs (GPT-6 Luna, GLM, MiMo) are real
charges reported by the provider. Comparing at API prices is fair across models; just
don't read the Claude column as spend. Results from now on carry a `billing` column.

| agent | model | tasks passed (live) | live checks | cost | time | turns |
|---|---|---|---|---|---|---|
| legacy blox (ba9206e) | claude-opus-4-8 | 0/3 | 2/16 | $4.27 | 1560s | 110 |
| blox runner (agent-native) | claude-opus-5-5 | **3/3** | **16/16** | **$0.75** | **154s** | 30 |
| Claude Code + blox MCP | claude-opus-5-5 | **3/3** | **16/16** | $0.92 | 172s | 26 |

Per task:

| task | legacy (live · cost · time) | blox runner | Claude Code + blox MCP |
|---|---|---|---|
| t2-coins | 0/4 · $1.31 · 332s | 4/4 · $0.31 · 49s | 4/4 · $0.33 · 64s |
| t6-door | 1/3 · $1.52 · 311s | 3/3 · $0.15 · 40s | 3/3 · $0.26 · 55s |
| t7-shop | 1/9 · $1.44 · 917s | 9/9 · $0.29 · 65s | 9/9 · $0.33 · 53s |

Tokens for the new runs (input / cache read / cache write / output, summed over 3
tasks):
- blox runner: 30 / 302k / 57k / 11.3k
- Claude Code + blox MCP: 36 / 496k / 74k / 11.4k

## What the data shows

- **Correctness comes from the environment.** Legacy passed 16/16 checks on disk (synced)
  but 2/16 live. Its code never reached Studio
  without a human clicking Rojo Connect. Both agent-native agents pass everything live.
- **Cost drops about 5×, time about 10×, turns about 4× (110 → 26–30).** The two new agents (one built-in, one
  third-party) land within about 20% of each other. That points to the tools, not the
  agent loop, as the source of the gain.
- **Spend is almost all cached input.** Fresh input is a few dozen tokens. Cache reads
  (tool definitions, guide and history resent each turn) dominate the input volume.
  Claude Code reads about 64% more cache than the blox runner; its own system prompt
  and tool set are larger. Further savings should come from shrinking what is resent
  (tool schemas, guide, tool output), not from fresh-input tricks.

## Caveats

- **n = 1 per cell.** No variance estimate. Treat differences under about 30% between
  the two new agents as noise.
- **Model confound.** Legacy ran on Opus 4.8 ($5/$25 per M tokens); the new runs used
  Opus 5.5 ($4/$20). Price alone explains about 20% of the cost gap, not 5×. Legacy's
  failures were sync failures, which a model change does not fix. Isolating the model
  effect would mean rerunning legacy on Opus 5.5 (about $4).
- **One model family so far.** The bench is agent-agnostic (`--agent custom`,
  `$BLOX_BENCH_STATS`), but only Claude-based agents have run it. A GPT- or
  Gemini-based agent run is the next comparison worth having.

# Multi-model + trim round (2026-10-01)

Same core suite and place reset. New: `--agent openai`, a small vendor-neutral agent
(`src/bench/openaiAgent.ts`: OpenAI-compatible chat completions + blox MCP over stdio +
four file tools), run through OpenRouter. It learns Roblox/blox only from the MCP
server's instructions and tool schemas. Raw data: `trim-blox-opus55.json`,
`trim1-blox-opus55.json`, `mm-glm-5.3-flash.json`, `mm-gpt-6-luna.json`,
`mm-mimo-v2.6-pro.json`.

| agent | model | tasks passed (live) | live checks | cost | time | turns | blox calls (err) |
|---|---|---|---|---|---|---|---|
| blox runner, before trim | claude-opus-5-5 | 3/3 | 16/16 | $0.75 | 154s | 30 | 10 (0) |
| blox runner, after trim | claude-opus-5-5 | 3/3 | 16/16 | $0.94 | 214s | 44 | 21 (2) |
| openai-compat agent | openai/gpt-6-luna | 3/3 | 16/16 | **$0.014** | 295s | 46 | 30 (6) |
| openai-compat agent | z-ai/glm-5.3-flash | 3/3 | 16/16 | $0.074 | 871s | 44 | 39 (3) |
| openai-compat agent | xiaomi/mimo-v2.6-pro | 2/2 (t7 stopped) | 7/7 | $0.078 | 2494s | 16 | 13 (1) |

Per task (live · cost · time):

| task | Opus 5.5 (blox runner, trimmed) | GPT-6 Luna | GLM 5.3 Flash | MiMo 2.6 Pro |
|---|---|---|---|---|
| t2-coins | 4/4 · $0.34 · 64s | 4/4 · $0.005 · 87s | 4/4 · $0.014 · 235s | 4/4 · $0.029 · 766s |
| t6-door | 3/3 · $0.17 · 51s | 3/3 · $0.002 · 59s | 3/3 · $0.010 · 134s | 3/3 · $0.049 · 1728s* |
| t7-shop | 9/9 · $0.43 · 99s | 9/9 · $0.008 · 149s | 9/9 · $0.050 · 502s | stopped |

\* finished the work, then its last model call hung until the bench timeout. The agent
now has a 5-minute per-request timeout. MiMo 2.6 Pro's t7 and MiMo 2.6 Flash were
dropped to save time.

## What the data shows

- **The environment carries across model families.** Three non-Claude models, through an
  agent that is not Claude Code and not the blox runner, pass every live check they
  finished. Nothing in the tools or guide had to change for them.
- **Cost is set by the model's price, time by the provider's speed.** GPT-6 Luna did the
  suite for $0.014 (about 1/50 of Opus 5.5) in about 1.4× Opus's wall time. GLM 5.3
  Flash is 5× Luna's cost and 3× its time. MiMo 2.6 Pro spends minutes reasoning per
  turn (47k output tokens over 16 turns).
- **The static trim is real but small.** Tool descriptions went 7.7k → 6.5k chars and the
  guide 4.4k → 3.3k (about 640 tokens less per turn, about $0.01 per suite on Opus 5.5).
  Run-to-run variance in turns swamps it: the trimmed Opus run cost more because on t7
  it chose to verify the shop by clicking the real button (26 turns vs 15).
- **Real-UI verification exposed an interface gap, now fixed.** The first trimmed t7 run
  guessed `user_mouse_input`'s argument format 8 times and gave up: `studio_tool list`
  showed only required arg names. Now `studio_tool {name:"list", args:{tool}}` returns
  a tool's full schema, a rejected raw call comes back with the schema, and `playtest`
  `inputs` documents the mouse/keyboard action names. The rerun needed 2 tries.
- **One more bug found by a non-Claude model:** `explore` failed with "datamodel_type is
  required" (a Studio schema change). It now sends the datamodel (edit at rest, server
  in play; `context` overrides).

## Caveats

- n = 1 per cell, again. Turn counts vary ±50% between runs of the same agent.
- The non-Claude runs use a different agent loop than the Opus runs, so model and agent
  are confounded across those rows. The models themselves are compared on the same agent.
- Cost for OpenRouter runs is OpenRouter's reported `usage.cost`; provider caching
  differs (GLM reported no cache writes).

# Built-in openai runner + turn cuts (2026-10-01, later)

Core suite, live checks, one run each. Raw: `runner-openai-gpt-6-luna.*`, `turns-blox-opus55.*`.

| agent | model | tasks | live checks | cost | time | turns |
|---|---|---|---|---|---|---|
| blox runner `--runner claude`, before turn cuts | Opus 5.5 | 3/3 | 16/16 | $0.94 | 214s | 44 |
| blox runner `--runner claude`, after turn cuts | Opus 5.5 | 3/3 | 16/16 | **$0.68** | **146s** | **26** |
| blox runner `--runner openai` (new) | GPT-6 Luna | 3/3 | 16/16 | $0.02 | 395s | 47 |

| task | Opus before | Opus after | Luna `--runner openai` |
|---|---|---|---|
| t2-coins | 10 turns · $0.34 | 10 · $0.32 | 17 · $0.006 |
| t6-door | 8 · $0.17 | 7 · $0.15 | 9 · $0.002 |
| t7-shop | 26 · $0.43 | **9 · $0.21** | 21 · $0.008 |

## What changed

- **`--runner openai`**: the built-in runner on a vendor-neutral loop over any
  OpenAI-compatible endpoint (shared with the bench agent). It uses the same toolset,
  prompt, path guardrails, `--ask` gates and budget, calls tools in-process, and needs
  no CCR translation. Luna through it matches the bench-agent result (3/3).
- **Turn cuts, aimed at the t7 replay** (26 turns, about 20 of them spent on a manual
  UI click: run_luau to set coins, a raw `user_mouse_input` rejected for
  `datamodel_type:"client"`, a `Players.LocalPlayer…` path Studio can't resolve):
  - `playtest` inputs gained `click {target}` (a real click on a GUI button, with paths
    normalized to the `LocalPlayer.…` form Studio resolves, and an explained failure
    when the click lands on Roblox's CoreGui) and `luau {context, code}` (arrange or
    check state between inputs).
  - `studio_tool` fixes `datamodel_type` casing.
  - The guide shows a UI flow as one playtest call and says to batch independent calls.
  The rerun verified the whole shop in one playtest: a click at 0 coins (rejected),
  then a coin pickup, then a click at 12 coins (bought). t7 went from 26 turns to 9.
- ~~Opus still makes one tool call per turn~~: wrong, a counting artifact. See below.

## Turn counts were not comparable (corrected)

The Claude runner's "turns" came from the Agent SDK's `num_turns`, which counts
about one per tool call. The openai runner counts model requests. Opus does batch:
recounting distinct assistant message ids in the session transcripts gives the real
number of model requests, with 1.5–2.5 tool calls each.

| run | reported turns (SDK) | model requests | tool calls |
|---|---|---|---|
| blox runner, first round (`after-blox`) | 30 | 15 | 27 |
| Claude Code + blox MCP (`after-claude-code`) | 26 | 18 | 23 |
| blox runner, before turn cuts (`trim-blox-opus55`) | 44 | 28 | 41 |
| blox runner, after turn cuts (`turns-blox-opus55`) | 26 | **13** (4 / 4 / 5) | 23 |
| Luna `--runner openai` (already requests) | 47 | 47 | — |

So Opus needs about 4 requests per core task and Luna about 16. Batching guidance
has little left to win for Opus; its cost is per-request context, mostly cache reads.
Both runners and the `claude-code` bench profile (now `--output-format stream-json`)
count turns as model requests from now on.

## Bugs found on the CCR-routed path (dock smoke, Luna via the Claude runner)

- The Agent SDK prices a routed `provider,slug` model at Claude rates: it reported
  $1.64 for 12 Luna turns (real cost about $0.003) and stopped a $0.5-capped run after
  about 8 tool calls. Routed runs no longer pass the SDK budget cap (the routed turn
  cap bounds them), and their cost is recorded as unknown, not ledgered at Claude prices.
- After yielding that error result the SDK threw, so the dock showed 0 turns / $0. The
  runner now keeps a result the SDK yielded before throwing.
- Through CCR, Luna mangled absolute file paths. `--runner openai` (relative paths,
  no translation) did not.

## Caveats

- n = 1 per cell; turn counts vary ±50% between runs of the same agent, so the Opus
  t2/t6 deltas are noise. The t7 change has a mechanism (one playtest instead of a
  manual click session) and matches the replay.

# Core-suite comparison (2026-10-01)

Three tasks (t2-coins, t6-door, t7-shop), one run per agent per task, against the same
throwaway Studio place. The place is reset before each task. Raw data:
`baseline-legacy.json` (t2), `baseline-legacy-t6t7.json`, `after-blox.json`,
`after-claude-code.json`.

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

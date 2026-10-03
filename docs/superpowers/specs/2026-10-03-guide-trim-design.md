# Agent guide trim

Status: self-approved design (unattended run 2026-10-03). This is queue item 6.

## Problem

`AGENT_GUIDE` (src/agentGuide.ts) reaches every agent in three ways:

- it is the MCP server's `instructions`;
- it is written into each scaffolded project as `AGENTS.md`;
- it is embedded in the built-in runner's system prompt.

That makes it a fixed cost in every session. It had grown to 7052
characters, roughly 1.8k tokens.

## Design

- **Rewrite for density, not removal.** Every rule, tool pointer and
  workflow step stays. Prose is folded into the tool flows and the
  layout lines, and repeated explanation is cut.
- **Guard test** (`tests/agentGuide.test.ts`) with three checks:
  - a `MUST_KEEP` list of every rule or pointer phrase must be present
    (whitespace-normalised, because line wrapping carries no meaning);
  - every registered agent tool must be named;
  - the guide's length must stay ≤ 5600 characters.

  Any future addition then has to fit the budget or raise it on purpose.

## Result

7052 → 5590 characters (−21%, about 370 tokens per session). Nothing in
`MUST_KEEP` was lost. Some descriptive detail was dropped: "returns typed
errors/warnings", "each ftue step within targetSec", and the per-context
description of logs. The tools' own descriptions still say all of this.

## Decisions

- The budget is 5600, not lower. Going further would mean dropping rules,
  such as the economy design section, which is the main game-design
  contract.
- Scaffolded projects keep their old `AGENTS.md`. `blox setup` writes it
  only when it is missing, so delete it and rerun setup to refresh. MCP
  clients get the new text at once, because it is the server's
  `instructions`.

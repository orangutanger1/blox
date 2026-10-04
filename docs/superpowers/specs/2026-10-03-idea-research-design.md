# Idea research

Status: approved in chat 2026-10-03 (approach 1, human picks from top N).
Component-first item 1.

## Goal

Before a real build, blox decides *what* to build with evidence: what is on
the Roblox charts right now, how crowded each genre is, how comparable games
monetize, and how well blox can build it. The human picks one of ~5 ranked
ideas; blox writes `.blox/brief.json`, which the agent turns into
`.blox/design.json` via `design set` (validated there).

Code owns facts and scores. The model owns the creative part (theme, hook,
loop) and must cite games from the snapshot — no invented evidence.

## Live facts (probed 2026-10-03, unauthenticated GET)

- `https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=<uuid>&device=<all|computer|high_end_phone|…>&country=all`
  → `{sorts:[{sortId, sortDisplayName, games:[{universeId, rootPlaceId, name,
  playerCount, totalUpVotes, totalDownVotes, isSponsored, genreL1,
  contentMaturity}]}]}`. Sorts: `top-trending` (98), `up-and-coming` (54),
  `top-playing-now` (97), `fun-with-friends` (91), `top-revisited` (79). A
  `filters_v5` sort carries no games.
- `https://games.roblox.com/v1/games?universeIds=<csv>` → `{data:[{id, name,
  description, creator{name,type}, playing, visits, maxPlayers, created,
  updated, genre_l1, genre_l2}]}`. Batches of 50.
- `https://apis.roblox.com/game-passes/v1/universes/<id>/game-passes?passView=Full&pageSize=50`
  → `{gamePasses:[{id, name, isForSale, price}]}`. (The old
  `games.roblox.com/v1/games/<id>/game-passes` returns an error.)
- Developer products are not public. Monetization evidence = passes only.

## Tool: `idea` (agent tool + CLI `idea <action>`)

| Call | Does |
|---|---|
| `research {fresh?, device?="all"}` | Fetch sorts → details → passes for the top 40 by CCU. Write `.blox/research/<YYYY-MM-DD>.json` (reuse today's file unless `fresh`). Print the stats summary + theme table + the compact game list the agent needs to propose. |
| `propose {ideas:[…]}` | Validate 3–6 ideas against the latest snapshot, score, rank, save `.blox/ideas.json`. Refuse with the bad ids if any citation is not in the snapshot. |
| `list` | Ranked table: score with its parts, cited games (CCU, passes). For the human to pick. |
| `brief {id}` | Write `.blox/brief.json` from the idea + its evidence, with a `designHints` block (title, format, loop, monetization names). Does not write `design.json`: that needs an economy and resolvable refs, so the agent writes it with `design set` from the brief. |

Idea shape (zod, strict):
`{id, title, format, genre_l1, genre_l2?, theme, hook, loop: string[≥3],
monetization: [{kind: pass|product|subscription, name, priceRobux?}],
cites: universeId[≥2], risks?: string[]}` where `format` is the
`design.json` meta.format enum.

## Modules (`src/idea/`)

- `fetch.ts` — `gatherSnapshot(fetch: FetchLike, {device, now})`. Sequential
  requests (~10–45 per run), UA header as in `scoutWeb.ts`. Sponsored games
  dropped. Charts failing = hard error; details or passes failing = partial
  snapshot with `notes[]`.
- `snapshot.ts` — snapshot type + read/write + `latestSnapshot`,
  `previousSnapshot` (for deltas).
- `stats.ts` (pure) — per genre_l1 and genre_l1/l2: game count, CCU sum and
  median, top-game share of CCU, freshness (% created within 180 days of the
  snapshot), median like ratio, median pass count, pass price p25/p50/p75.
- `themes.ts` (pure) — normalize names (strip `[..]`/`(..)` tags, emoji,
  update words like UPD/NEW/x2/%), tokenize names + descriptions, drop
  stopwords, count words and word pairs weighted by CCU (log), top 25, and
  rising/falling vs the previous snapshot when one exists. No embeddings
  (corpus ~300 noisy names; the model reads them directly; revisit when
  snapshots accumulate).
- `fit.ts` (pure) — fixed table format → blox support: kit exists
  (`incremental`, `steal-tycoon`) = 1.0; other design formats (`round`,
  `survival`, `collection`, `battlegrounds`) = 0.6; `other` = 0.3.
- `score.ts` (pure) — per idea, from the cited games' genre stats:
  demand (log CCU of the genre, normalized to the snapshot max), freshness,
  saturation penalty (top-game share > 0.6 scales down), like ratio, fit.
  Weighted sum with weights in one exported constant; parts kept for display.
- `brief.ts` (pure) — idea + snapshot → brief: idea fields, evidence
  (cited games: name, CCU, visits, created, pass names/prices), price anchors
  (comparable pass p25/p50/p75), device note, open questions, `designHints {title, format, loop, monetization}`.

## Agent guide

One line: "No game yet? `idea research` → `idea propose` → ask the human to
pick from `idea list` → `idea brief`. If `.blox/brief.json` exists, read it
before `design`." `brief` is never called by the agent without the human's
pick in interactive runs (guide rule, not enforced).

## Limits

Roblox public JSON endpoints only; no YouTube, no third-party trackers, no
HTML scraping. One run ≈ 45 requests, sequential. Snapshot cached per day.

## Testing

Fixtures trimmed from real responses (2026-10-03). Unit: stats, theme
normalize/count/delta, fit, score ordering + parts, citation refusal,
brief contents (evidence, price anchors, designHints format in the `DesignSchema` meta.format enum).
Tool with fake fetch: research writes + reuses the snapshot, partial notes on
passes failure, hard error on charts failure; propose/list/brief round trip.
CLI wiring. Live smoke in ~/blox-playground: real `research`, one agent
`propose` turn, `brief` (≈ 1 short model turn).

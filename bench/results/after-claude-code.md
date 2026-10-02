# Bench: after-claude-code

agent: `claude-code + blox MCP` · 2026-10-02T02:08:02.315Z → 2026-10-02T02:12:03.057Z

| task | level | live checks | synced checks | pass | agent exit | turns | cost | time | tokens in / cache read / cache write / out | blox calls (err) |
|---|---|---|---|---|---|---|---|---|---|---|
| t2-coins | 2 gameplay mechanic | 4/4 | 4/4 | PASS | 0 | 10 | $0.33 | 64s | 12 / 166k / 25k / 4592 | 4 (0) |
| t6-door | 6 iterative runtime debugging | 3/3 | 3/3 | PASS | 0 | 8 | $0.26 | 55s | 12 / 163k / 23k / 2225 | 4 (0) |
| t7-shop | 7 existing-project feature | 9/9 | 9/9 | PASS | 0 | 8 | $0.33 | 53s | 12 / 167k / 26k / 4603 | 4 (0) |

**3/3 tasks fully passing (live)** · live checks 16/16 · synced checks 16/16

totals: cost $0.92 · time 172s · turns 26 · model claude-opus-5-5

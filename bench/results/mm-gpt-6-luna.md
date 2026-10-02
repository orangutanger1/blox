# Bench: mm-gpt-6-luna

agent: `openai-compat agent + blox MCP` · 2026-10-02T03:42:45.498Z → 2026-10-02T03:48:17.744Z

| task | level | live checks | synced checks | pass | agent exit | turns | cost | time | tokens in / cache read / cache write / out | blox calls (err) |
|---|---|---|---|---|---|---|---|---|---|---|
| t2-coins | 2 gameplay mechanic | 4/4 | n/a | PASS | 0 | 15 | $0.00 | 87s | 45 / 76k / 8701 / 5697 | 10 (3) |
| t6-door | 6 iterative runtime debugging | 3/3 | n/a | PASS | 0 | 12 | $0.00 | 59s | 36 / 41k / 3481 / 1847 | 7 (0) |
| t7-shop | 7 existing-project feature | 9/9 | n/a | PASS | 0 | 19 | $0.01 | 149s | 57 / 148k / 14k / 8470 | 13 (3) |

**3/3 tasks fully passing (live)** · live checks 16/16 · synced checks 0/0

totals: cost $0.01 · time 295s · turns 46 · model openai/gpt-6-luna

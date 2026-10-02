# Bench: mm-glm-5.3-flash

agent: `openai-compat agent + blox MCP` · 2026-10-02T03:27:38.368Z → 2026-10-02T03:42:45.038Z

| task | level | live checks | synced checks | pass | agent exit | turns | cost | time | tokens in / cache read / cache write / out | blox calls (err) |
|---|---|---|---|---|---|---|---|---|---|---|
| t2-coins | 2 gameplay mechanic | 4/4 | n/a | PASS | 0 | 7 | $0.01 | 235s | 21k / 69k / 0 / 17k | 5 (0) |
| t6-door | 6 iterative runtime debugging | 3/3 | n/a | PASS | 0 | 11 | $0.01 | 134s | 25k / 67k / 0 / 8077 | 9 (0) |
| t7-shop | 7 existing-project feature | 9/9 | n/a | PASS | 0 | 26 | $0.05 | 502s | 81k / 720k / 0 / 33k | 25 (3) |

**3/3 tasks fully passing (live)** · live checks 16/16 · synced checks 0/0

totals: cost $0.07 · time 871s · turns 44 · model z-ai/glm-5.3-flash

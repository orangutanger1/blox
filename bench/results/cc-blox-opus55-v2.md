# Bench: cc-blox-opus55-v2

agent: `claude-code + blox MCP` · 2026-10-05T07:46:11.111Z → 2026-10-05T07:52:14.420Z

| task | level | live checks | synced checks | pass | agent exit | turns | cost | billing | time | tokens in / cache read / cache write / out | blox calls (err) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| t2-coins | 2 gameplay mechanic | 4/4 | 4/4 | PASS | 0 | 6 | $0.35 | subscription | 70s | 12 / 170k / 28k / 4918 | 5 (0) |
| t6-door | 6 iterative runtime debugging | 3/3 | 3/3 | PASS | 0 | 8 | $0.31 | subscription | 79s | 16 / 230k / 24k / 3354 | 5 (2) |
| t7-shop | 7 existing-project feature | 10/10 | 10/10 | PASS | 0 | 11 | $0.52 | subscription | 150s | 22 / 371k / 34k / 9031 | 10 (1) |

**3/3 tasks fully passing (live)** · live checks 17/17 · synced checks 17/17

totals: cost $1.18 API-equivalent (subscription, not charged) · time 299s · turns 25 · model claude-opus-5-5

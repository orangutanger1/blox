# Bench: cc-studio-plain-opus55

agent: `claude-code + Studio MCP (no blox)` · 2026-10-05T07:24:26.310Z → 2026-10-05T07:30:07.186Z

| task | level | live checks | synced checks | pass | agent exit | turns | cost | billing | time | tokens in / cache read / cache write / out | blox calls (err) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| t2-coins | 2 gameplay mechanic | 4/4 | n/a | PASS | 0 | 19 | $0.55 | subscription | 96s | 38 / 687k / 32k / 7587 | - |
| t6-door | 6 iterative runtime debugging | 2/3 | n/a | fail | 0 | 13 | $0.52 | subscription | 62s | 26 / 571k / 42k / 3544 | - |
| t7-shop | 7 existing-project feature | 7/9 | n/a | fail | 0 | 28 | $0.93 | subscription | 148s | 56 / 1404k / 50k / 13k | - |

**1/3 tasks fully passing (live)** · live checks 13/16 · synced checks 0/0

totals: cost $2.00 API-equivalent (subscription, not charged) · time 306s · turns 60 · model claude-opus-5-5

## Live check failures
- **t6-door**
  - door: opens when a player steps on the plate: fail — .bench-checks/door.spec.luau:14: waitFor timed out: door did not open
- **t7-shop**
  - coins: touching a coin gives exactly +1 and disables that coin: fail — .bench-checks/02-coins-regression.spec.luau:33: waitFor timed out: Coins did not go up by 1 (now 4)
  - shop: refuses with fewer than 10 coins and changes nothing: fail — .bench-checks/03-shop.spec.luau:19: expected 3, got 4

# Bench: baseline-legacy-t6t7

agent: `legacy (/home/myen/blox-legacy/dist/cli.js)` · 2026-10-02T01:30:25.160Z → 2026-10-02T01:52:18.105Z

| task | level | live checks | synced checks | pass | agent exit | turns | cost | time | blox calls (err) |
|---|---|---|---|---|---|---|---|---|---|
| t6-door | 6 iterative runtime debugging | 1/3 | 3/3 | fail | 0 | 36 | $1.52 | 311s | - |
| t7-shop | 7 existing-project feature | 1/9 | 9/9 | fail | 0 | 41 | $1.44 | 917s | - |

**0/2 tasks fully passing (live)** · live checks 2/12 · synced checks 12/12

## Live check failures
- **t6-door**
  - door: opens when a player steps on the plate: fail — .bench-checks/door.spec.luau:10: expected a value/instance, got nil
  - door: closes again after ~3 seconds: fail — Door is not a valid member of Workspace "Workspace"
- **t7-shop**
  - coins: leaderstats.Coins IntValue exists: fail — .bench-checks/02-coins-regression.spec.luau:6: waitFor timed out: no leaderstats.Coins
  - coins: at least 5 anchored Coin parts under Workspace.Coins: fail — .bench-checks/02-coins-regression.spec.luau:22: expected >= 5, got 0
  - coins: touching a coin gives exactly +1 and disables that coin: fail — .bench-checks/02-coins-regression.spec.luau:6: waitFor timed out: no leaderstats.Coins
  - shop: BuySpeed is a RemoteFunction: fail — .bench-checks/03-shop.spec.luau:11: waitFor timed out: no ReplicatedStorage.BuySpeed
  - shop: refuses with fewer than 10 coins and changes nothing: fail — .bench-checks/03-shop.spec.luau:11: waitFor timed out: no ReplicatedStorage.BuySpeed
  - shop: with 15 coins deducts 10 and sets WalkSpeed 24: fail — .bench-checks/03-shop.spec.luau:11: waitFor timed out: no ReplicatedStorage.BuySpeed
  - shop: HUD has a BuySpeedButton TextButton: fail — .bench-checks/03-shop.spec.luau:6: waitFor timed out: no ScreenGui named HUD in PlayerGui
  - regression: CoinsLabel still shows current coins: fail — .bench-checks/03-shop.spec.luau:6: waitFor timed out: no ScreenGui named HUD in PlayerGui

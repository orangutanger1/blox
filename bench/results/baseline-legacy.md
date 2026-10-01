# Bench: baseline-legacy

agent: `legacy (/home/myen/blox-legacy/dist/cli.js)` · 2026-10-01T03:08:33.498Z → 2026-10-01T03:41:06.654Z

| task | level | live checks | synced checks | pass | agent exit | turns | cost | time | blox calls (err) |
|---|---|---|---|---|---|---|---|---|---|
| t1-basic | 1 basic creation | 0/4 | 4/4 | fail | 0 | 35 | $1.27 | 315s | - |
| t2-coins | 2 gameplay mechanic | 0/4 | 4/4 | fail | 0 | 33 | $1.31 | 332s | - |
| t3-hud | 3 UI integration | 0/6 | 6/6 | fail | 0 | 42 | $1.54 | 368s | - |
| t4-obby | 4 world building | 0/3 | 3/3 | fail | 0 | 37 | $1.56 | 350s | - |
| t5-debug-points | 5 debugging | 2/2 | 2/2 | PASS | 0 | 33 | $1.28 | 257s | - |
| t6-door | 6 iterative runtime debugging | 1/3 | 1/3 | fail | 1 | - | - | 47s | - |
| t7-shop | 7 existing-project feature | 1/9 | 5/9 | fail | 1 | - | - | 3s | - |

**1/7 tasks fully passing (live)** · live checks 4/31 · synced checks 25/31

## Live check failures
- **t1-basic**
  - Baseplate: anchored BasePart, >=100x100, top near Y=0: fail — .bench-checks/basic.spec.luau:6: expected a value/instance, got nil
  - SpawnLocation exists: fail — .bench-checks/basic.spec.luau:14: expected a value/instance, got nil
  - player spawns and stands on the baseplate: fail — .bench-checks/basic.spec.luau:20: expected true, got false
  - server printed "Game ready" this session: fail — .bench-checks/basic.spec.luau:29: expected true, got false
- **t2-coins**
  - coins: leaderstats.Coins IntValue exists: fail — .bench-checks/coins.spec.luau:6: waitFor timed out: no leaderstats.Coins
  - coins: at least 5 anchored Coin parts under Workspace.Coins: fail — .bench-checks/coins.spec.luau:22: expected >= 5, got 0
  - coins: touching a coin gives exactly +1 and disables that coin: fail — .bench-checks/coins.spec.luau:6: waitFor timed out: no leaderstats.Coins
  - coins: a collected coin comes back after ~5s: fail — .bench-checks/coins.spec.luau:6: waitFor timed out: no leaderstats.Coins
- **t3-hud**
  - coins: leaderstats.Coins IntValue exists: fail — .bench-checks/01-coins-regression.spec.luau:6: waitFor timed out: no leaderstats.Coins
  - coins: at least 5 anchored Coin parts under Workspace.Coins: fail — .bench-checks/01-coins-regression.spec.luau:22: expected >= 5, got 0
  - coins: touching a coin gives exactly +1 and disables that coin: fail — .bench-checks/01-coins-regression.spec.luau:6: waitFor timed out: no leaderstats.Coins
  - hud: CoinsLabel is a visible TextLabel in the top-left quadrant: fail — .bench-checks/02-hud.spec.luau:5: waitFor timed out: no ScreenGui named HUD in PlayerGui
  - hud: text reads "Coins: N" for the current value: fail — .bench-checks/02-hud.spec.luau:5: waitFor timed out: no ScreenGui named HUD in PlayerGui
  - hud: label updates live when Coins changes: fail — .bench-checks/02-hud.spec.luau:5: waitFor timed out: no ScreenGui named HUD in PlayerGui
- **t4-obby**
  - obby: Model with anchored Platform1..Platform6: fail — .bench-checks/obby.spec.luau:3: waitFor timed out: no Workspace.Obby
  - obby: platforms climb, each jump reachable (rise <= 4.5, gap <= 10): fail — .bench-checks/obby.spec.luau:3: waitFor timed out: no Workspace.Obby
  - obby: touching Finish sets the Finished attribute and prints: fail — .bench-checks/obby.spec.luau:3: waitFor timed out: no Workspace.Obby
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

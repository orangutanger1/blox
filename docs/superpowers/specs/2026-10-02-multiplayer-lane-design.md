# Multiplayer test lane (pipeline item 6)

Research §J/§R.4: theft, trading and rounds cannot be verified solo. Studio's
`StudioTestService:ExecuteMultiplayerTestAsync(n ≤ 8)` runs a real server + n clients,
but it is plugin-security — the Studio MCP cannot call it. blox's dock plugin can.

## Flow (`multiplayer {action:"run", clients?=2, filter?, timeout?=120}`)
1. Sync the project (same push as `run_tests`).
2. Discover `tests/**/*.mp.luau` (first line `-- @context multiplayer`; optional
   `-- @clients N` raises the client count for the batch).
3. Install into the edit DataModel (removed afterwards):
   - `ServerStorage.__BloxMp.Specs` — ModuleScript `return function(mp) … end` built
     from the same inlined spec runner as `run_tests` (`testProgram`), spec functions
     receive an extra `mp` argument;
   - `ServerScriptService.__BloxMpHarness` — server Script that only acts when
     `ServerStorage` has the `BloxMpRun` attribute (attributes survive into the test
     session, sidestepping the `GetTestArgs` nil bug): waits for n players with
     characters, creates `ReplicatedStorage.__BloxMpRF`, runs the specs, and calls
     `StudioTestService:EndTest(json)`;
   - `StarterPlayer.StarterPlayerScripts.__BloxMpClient` — LocalScript agent answering
     the RemoteFunction with fixed ops (no code execution on clients):
     `invoke`/`fire` a remote by path with args, `get` a property by path,
     `attr` a player attribute, `moveTo` a position.
4. **Lane**: blox listens on `127.0.0.1:35769` for the duration of the job:
   `GET /lane/job` (the plugin takes it once), `POST /lane/result`. The dock plugin
   polls the lane every 1.5 s and runs `ExecuteMultiplayerTestAsync(n, {})`, posting
   its return value. No plugin pick-up in 20 s → readable error (update/enable plugin).
5. Results → `.blox/mp-report.json`; synthetic tests named by spec file + test name, so
   criteria bind with `tests:["tests/theft.mp.luau"]` like normal specs.

`mp` API inside specs: `mp.players` (array, join order), `mp.client(player, op, ...)`
→ the client agent's return values, `mp.waitPlayers(n)`.

## Kit
Incremental kit adds `tests/kit_multiplayer.mp.luau`: two players have independent
state; one player's purchase never changes the other's balance; junk remote input is
rejected for real clients.

## Verification
Lane server tested over real localhost HTTP; generated harness/agent/specs compile
under Lune; tool orchestration with the fake Studio and a fake plugin (HTTP client
taking the job and posting a result). Live smoke pending: plugin update installed,
`blox multiplayer` on the kit project with 2 clients.

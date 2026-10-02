# Multiplayer lane Implementation Plan

> Executed inline (superpowers:executing-plans), TDD per task.

**Spec:** `docs/superpowers/specs/2026-10-02-multiplayer-lane-design.md`

## Tasks
1. `src/multiplayer/lane.ts` — `LANE_PORT`, `runLaneJob(job, {port, pickupMs, timeoutMs})` (HTTP server, job taken once, result promise, pickup/total timeouts, always closes). Tests over real HTTP (`fetch`).
2. `testProgram` gains `opts.extraParams` (passes `mp` to spec functions); `src/multiplayer/program.ts` — `discoverMpSpecs`, `specsModule(specs)`, `HARNESS_SOURCE`, `CLIENT_SOURCE`, `installProgram(...)`, `CLEANUP`. Tests: discovery/clients header, Lune compile of every generated source.
3. `src/multiplayer/run.ts` — `runMultiplayer(session, projectPath, opts)` (sync → install → lane → cleanup → parse → map positions). Tests with fake Studio + fake plugin.
4. Plugin lane poller in `plugin/src/init.server.luau`; registry tool `multiplayer`, `withSyntheticResults` reads `mp-report.json`, CLI `blox multiplayer [filter] [--clients N]`, guide, MCP list. Kit mp spec. Lune compile of plugin + kit spec.
5. Verify + PR.

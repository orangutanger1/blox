# blox Desktop — Phase 0 spike findings

Run on a native Windows machine (cmd.exe, not WSL), real Roblox Studio with the
MCP server toggle on, and a linked Claude **subscription** (pro). 2026-06-21.

## Spike A — native-Windows engine run

- doctor ATTACHED: **yes** — `status: CONNECTED (proxy)`, `studio: ATTACHED`, 27 tools, `execute_luau -> 2`.
- launcher used: win32 path — `cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat` (the bridge's `studioLauncher()` on `win32`).
- real build completed: **yes** — `blox "<prompt>" --auto` ran natively, edited a script, auto-committed.
- engine changes needed (all shipped to main):
  - #5 `auth.ts` — `spawnSync('claude')` needs the `.cmd` resolved on Windows (later refined to `cmd.exe /c` in #13 to drop a DEP0190 warning).
  - #6 `bridge/mcpBridge.ts` — the MCP launcher cwd defaulted to `/mnt/c` (WSL-only); native Windows needs `%SystemRoot%`/`C:\` or spawn throws `spawn cmd.exe ENOENT`.
  - #7 `onboard/pull.ts` — script-dump pages budgeted by raw bytes; JSON escaping inflated them past the ~100KB transport cap → truncated dump. Budget by encoded size.
  - #10 `onboard/layout.ts` — init onboarded a PluginDebugService script; Rojo can't sync a Script there (`Child of PluginDebugService must be a Plugin`). Skip unsyncable services.
- **GO.**

## Spike B — Electron forks the CLI

- forked engine completed a build: **yes** — `utilityProcess.fork(dist/cli.js, [...])` ran the SDK-spawning engine; `[engine]` stdout streamed; report `stop: completed` / `detail: success`; engine exited 0.
- `/info` reachable mid-run: **yes** — a separate `node` process read `GET http://127.0.0.1:35768/api/v1/info` while the forked run was live → `{"protocol":4,"runId":"…","project":"my-game","auth":{"mode":"subscription","label":"Subscription (pro)"}}`. `protocol:4` matches the plugin `PROTOCOL`. Confirms the renderer can be a panel client of the forked engine.
- packaging concern noted: a CLI run **embeds its own panel server on :35768**. Do NOT also run a standalone `blox panel serve` daemon — they collide (`EADDRINUSE`, non-fatal warning, run continues). The desktop renderer should talk to the fork's embedded server, not a separate daemon.
- also fixed #12: only autonomy-gate (`isGated`) denials mark a run `gated`. AskUserQuestion (headless, no answerer) and guardrail path-blocks are now `blocked (non-fatal, agent continued)` — a recovered+completed run exits success instead of false-`gated`. Verified live.
- **GO** (highest-risk spike).

## Spike C — Sign in with Claude (auth path)

- `claude` on PATH from engine context (native Windows): **yes** — `where claude` resolves `claude.cmd`; engine reaches it via `cmd.exe /c claude`.
- `blox auth login` browser flow on Windows: **works** (post-#5); subscription linked (pro, tashany@gmail.com).
- run works with **no** `ANTHROPIC_API_KEY` (subscription only): **yes** — `auth status` shows `active mode: subscription`; runs use the stored `~/.claude` creds.
- Windows fix needed (PATH / launcher plumbing): the `.cmd` resolution + DEP0190 cleanup (#5/#13); no auth redesign.
- **Decision:** v1 offers **both** "Sign in with Claude" (wrap `blox auth login` / `claude auth login`) and key-paste (wrap `blox auth key set`). The auth *paths* are settled; the desktop app shells these out, it does not reimplement auth.

## Decision

- **Proceed to Phase 1: YES.** Spike A and Spike B are GO; C settled (both auth paths).
- Open follow-up filed: issue #8 — bundle/auto-detect rojo so it isn't a manual install (ties to Phase 2 `BLOX_ROJO_BIN`).

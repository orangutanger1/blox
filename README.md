# blox

**A Roblox development runtime for AI agents.** blox connects any coding agent
(Claude Code, Codex, Cursor, the built-in runner, …) to a running Roblox Studio
and gives it the loop a game developer needs: *edit files → sync → run the game →
observe → test → fix → verify* — with structured results at every step and
tests, not the agent's own claims, as the measure of "done".

```
agent ──MCP / CLI──▶ blox ──Studio MCP (studio_id, attach, retries)──▶ Roblox Studio
                      │  sync  · run_tests · playtest · run_luau · screenshot · task
                      └─▶ <project>/.blox/  events.jsonl, last-tests.json, task.json, artifacts/
                                    ▲
                          blox dashboard (read-only)
```

## Why (what changed, Sept 2026)

The previous blox was a Claude-only agent wrapper around raw Studio MCP tools. Measured
against a live Studio it had three fatal problems for autonomy (see
[`bench/results`](bench/results) and [`docs/agent-native.md`](docs/agent-native.md)):

1. **Code never reached Studio without a human.** Files only synced via `rojo serve` +
   a manual *Connect* click in the Rojo plugin. Baseline run: 46 turns / $2.65 spent
   fighting Rojo, then the agent pasted its code into `execute_luau` and reported
   success — 0/4 checks passed in the actual place.
2. **Broken by Studio updates.** Studio MCP now requires `studio_id` on every call and
   renamed asset tools; Studio auto-updates can leave `mcp.bat` pointing at a deleted
   version → every connection fails.
3. **No ground truth.** No test runner, no typed logs (play-mode errors arrive as an
   untyped console blob), stale `require` caches in edit probes, no record of what
   was verified.

## Quick start

Requirements: Node ≥ 20, [Rojo](https://rojo.space) on PATH, Roblox Studio with
*Assistant → Settings → Studio as MCP server* enabled and a place open. On WSL,
Studio runs on Windows; blox finds `StudioMCP.exe` itself.

```bash
npm install && npm run build && npm link   # provides the `blox` command

blox new my-game && cd my-game             # Rojo project + world/ + tests/ + AGENTS.md
blox status                                # Studio attached? in sync? tests? task?
blox setup claude                          # or: cursor | codex  (wires `blox mcp`)
claude                                     # the agent now has the blox tools
```

Without MCP every tool is also a CLI command (`blox test`, `blox playtest --seconds 5
--screenshot`, `blox luau 'return #game.Players:GetPlayers()' --context server`, …);
`blox help` lists them.

## The toolset (MCP server `blox`, also `blox <cmd>`)

| tool | what it does |
|---|---|
| `status` | one-call report: Studio attach + mode, files not yet in Studio, last tests (stale?), last playtest errors, task checklist |
| `sync` | push files into Studio: scripts per `default.project.json` (Rojo is the mapping oracle; no plugin needed) + `world/` builders. Incremental, hash-verified, one undo step, only touches blox-tagged instances |
| `run_tests` | sync, then run `tests/**/*.spec.luau` inside Studio — `edit` specs directly, `server`/`client` specs inside one playtest. Per-test pass/fail with `file:line`, runtime errors from the playtest, timeouts |
| `playtest` | start play → wait for player+character → wait N s → optional input → server/client Luau probes → optional screenshot → typed server+client logs → stop |
| `run_luau` | Luau in `edit`/`server`/`client`; all return values serialized (Instances, Vector3, tables), its log lines, errors mapped to your lines; edit-context `require` loads current source |
| `play` / `logs` / `screenshot` / `explore` | direct control and observation |
| `studio_tool` | any raw Studio MCP tool (`studio_id` injected): assets (`search_asset`, `insert_asset`, `generate_mesh`, …), `inspect_instance`, … |
| `task` | goal + acceptance criteria bound to tests (auto pass/fail from `run_tests`), notes, blockers needing a human — persisted in `.blox/task.json` |
| `scaffold` | create the standard layout non-destructively |

Project conventions (also in every scaffolded `AGENTS.md`):

- `src/<Service>/…` — `.server.luau` Script, `.client.luau` LocalScript, `.luau` ModuleScript
- `world/<Name>.luau` — `return function(model) … end`: geometry as code, rebuilt when the file changes
- `tests/*.spec.luau` — `-- @context edit|server|client`; `test`, `describe`, `expect(v).toBe/…`, `waitFor`

## Observability

Every tool call from every agent is appended to `.blox/events.jsonl`; results land in
`.blox/last-{sync,tests,playtest}.json`, screenshots in `.blox/artifacts/`. `blox
dashboard` (http://127.0.0.1:35780) renders the same files: what needs attention
(blockers, failing tests, runtime errors, Studio detached), goal/criteria, test
pass-rate history, last playtest logs, screenshots, and the activity timeline. Agents
never depend on it.

## Benchmark

`bench/` holds 7 tasks (basic creation → existing-project feature with regressions).
Each has a seed project, a prompt, **hidden** Luau checks run by the harness through
the same test runner, and a reference solution. Agent runs cost real money, so they
default to a 3-task **core** suite (t2-coins, t6-door, t7-shop); `--tasks all` runs
all 7.

```bash
blox bench --validate                       # checks must FAIL on seed, PASS on reference
blox bench --agent blox --label after       # built-in runner
blox bench --agent claude-code              # Claude Code + blox MCP
blox bench --agent openai --model z-ai/glm-5.3-flash   # any OpenAI-compatible model
blox bench --agent legacy --legacy-cli ../old-blox/dist/cli.js
blox bench --agent custom --agent-cmd '["codex","exec","{prompt}"]'
```

`--agent openai` is a small vendor-neutral agent (`src/bench/openaiAgent.ts`): any
OpenAI-compatible `/chat/completions` endpoint (`OPENAI_BASE_URL`, default OpenRouter;
key in `OPENAI_API_KEY` or `OPENROUTER_API_KEY`), four file tools, and blox's MCP
server over stdio. Everything it knows about Roblox comes from the MCP server's
instructions and tool schemas, the same surface any MCP client gets.

The bench measures the environment, not one vendor: any agent command works. Per run
it records pass/fail, cost, time, turns, model and tokens (fresh input / cache read /
cache write / output). Agents report stats by writing JSON to `$BLOX_BENCH_STATS`
(`{turns, costUsd, billing, model, tokens}`); stdout of the blox runner and `claude -p`
is parsed too. If only tokens are reported, cost is derived from the pricing table when
the model is known.

`billing` says who pays. On `subscription` (a linked Claude plan), cost is the
API-equivalent price of the tokens: nothing is charged, but the run counts against plan
limits. `apiKey`, `relay` and `provider` costs are real charges. Reports keep the two
totals apart. Run reports (`blox "<prompt>"`) print the same `billing:` line.

Scores are reported twice: **live** (Studio exactly as the agent left it — what a
player gets) and **synced** (after the harness pushes the agent's files). The harness
resets the open place between tasks — **point it at a throwaway place.**

Latest core-suite results (2026-10-01, one run each): legacy blox 0/3 tasks, 2/16 live
checks, $4.27, 26 min; blox runner 3/3, 16/16, $0.75, 2.6 min; Claude Code + blox MCP
3/3, 16/16, $0.92, 2.9 min. Non-Claude models through `--agent openai`: GPT-6 Luna
3/3, 16/16, $0.014, 4.9 min; GLM 5.3 Flash 3/3, 16/16, $0.07, 14.5 min. Later the
same day, after turn cuts: blox runner (Opus 5.5) 3/3, 16/16, $0.68, 2.4 min, 13 model
requests; `--runner openai` with GPT-6 Luna 3/3, 16/16, $0.02, 6.6 min, 47 requests.
Claude figures are API-equivalent prices on a subscription (not charged); OpenRouter
figures are billed. Details:
[`bench/results/comparison.md`](bench/results/comparison.md).

## Built-in runner (optional)

`blox "<prompt>" [--auto|--ask] [--budget USD] [--max-turns N] [--model …] [--runner claude|openai]`
runs an agent loop over the same toolset (in-process), then commits the project and
leaves Studio synced. `--ask` gates credit-spending asset generation (dock panel can
approve).

- `--runner claude` (default): the Claude Agent SDK. Non-Claude models can still be
  routed through claude-code-router (`blox model add …`, `--model provider,slug`).
- `--runner openai`: a vendor-neutral loop (`src/agent/chatLoop.ts`) over any
  OpenAI-compatible `/chat/completions` endpoint, with no translation layer.
  `--model provider,slug` uses a provider added with `blox model add`
  (e.g. `openrouter,openai/gpt-6-luna`); a bare slug uses `OPENAI_BASE_URL`
  (default OpenRouter) with `OPENAI_API_KEY` / `OPENROUTER_API_KEY`, else the stored
  OpenRouter key. Same system prompt, path guardrails, `--ask` gates and budget (from
  provider-reported cost; endpoints that report none are bounded by `--max-turns`
  only), the dock's post-generation asset review, and `--resume <id>` / `--continue`
  (conversations are saved under `$XDG_STATE_HOME/blox/chat-sessions`, outside the
  project, with images dropped).
  Set `"runner": "openai"` in `blox.config.json` to make it the default (the dock uses it too).
- **Usage-limit fallback**: with `"fallbackModel": "openrouter,openai/gpt-6-luna"` in
  `blox.config.json` (or `--fallback-model`), a subscription run that hits its plan's
  usage limit continues on that model through `--runner openai`. The fallback agent is
  told to check the partial work first. Fallback runs are billed by the provider and
  checked against the policy model allowlist; never used in relay mode. The report
  shows a `fallback:` line.

## Other commands (unchanged, peripheral to the agent loop)

`blox doctor` (connectivity), `blox init` (pull an existing place's scripts into a
Rojo project), `blox panel install|serve` (Studio dock UI for the built-in runner),
`blox auth …`, `blox model …`, `blox report` / `blox relay …` (team spend policy and
hosted key relay), `blox eval` (superseded by `blox bench`). See
[`docs/superpowers`](docs/superpowers) for their design notes.

### Team relay, member side

An admin runs `blox relay serve` and hands each member a token (`blox relay add-member
<email>`). A member links once:

```bash
blox auth relay http://relay-host:8787   # prompts for the token, checks it, stores it (0600)
blox auth status                         # shows the linked relay
blox auth use subscription|key|relay     # switch; `blox auth relay clear` unlinks
```

In relay mode Claude runs send the member token to the relay, never a real key. Before
each run (CLI, dock, `blox eval`) blox asks the relay whether the token, model and team
budget allow it, and stops with the relay's reason (revoked token, model not
allowlisted, rolling budget spent) before any work. Runs that would bypass the relay
(`--runner openai`, CCR-routed `provider,slug` models) are refused in relay mode. If
upstream rejects the team key, the relay answers 403 (the Agent SDK would retry a 401
for minutes), so the run stops in seconds, and `/check` refuses new runs until a
request succeeds again.

Team usage: in relay mode `blox report [--since 7d] [--json]` shows the relay's
ledger (spend per member and model against the rolling cap; `--local` shows this
project's ledger instead), and so do the desktop app's usage view and the dock
daemon. The relay also serves a dashboard at `http://<relay>/dashboard`, which asks
for a member token. Relay counts are model requests, not blox runs. The relay is plain HTTP: keep it on a trusted network or behind a TLS proxy.

## Tests

```bash
npm test               # unit tests (fake Studio, no network)
npx tsc --noEmit       # vitest does not typecheck
BLOX_E2E=1 npx vitest run tests/e2e   # live tests against an attached Studio (legacy surface)
```

# blox

Agentic coding tool for Roblox Studio (SP1a — core code loop).

## Install

```bash
npm install
npm run build
```

Requirements: Node ≥20, `rojo` on PATH, `ANTHROPIC_API_KEY` in the environment.

## Run

```bash
# Against the fixture game with the mock Studio bridge (no live Studio):
node dist/cli.js --mock --project test-fixtures/game "Add a greeting helper to Greeter.luau"

# Against your own Rojo game with the live Studio MCP bridge:
export BLOX_STUDIO_MCP_CMD=rbx-studio-mcp   # path/name of the official Roblox Studio MCP server
node dist/cli.js --project /path/to/game "..."
```

blox edits `.luau` files, validates the Rojo project (`rojo sourcemap`), commits the
change, and prints a report.

## Autonomy (per-run controls)

Each run's autonomy is overridable on the command line (flag > `blox.config.json` >
default):

| Flag | Effect | Default |
|------|--------|---------|
| `--max-turns <N>` | Cap agent turns | 40 |
| `--budget <USD>` | Cap spend; the run stops once exceeded | 5 |
| `--effort <high\|xhigh>` | Model reasoning effort | SDK default |
| `--auto` | Full autonomy — all tools run without prompting | (default) |
| `--ask` | Gate risky actions (see below) | off |

In `--ask` mode the inner code loop (editing `.luau`, running headless
`execute_luau` checks) stays fully autonomous, but **asset generation**
(`generate_mesh`, `generate_material`, `generate_procedural_model`,
`insert_from_creator_store`) and **play-mode / input-sim**
(`start_stop_play`, `character_navigation`, `user_keyboard_input`,
`user_mouse_input`) are gated. When the agent reaches a gated action the run stops,
the report lists the blocked action(s) and the session id, and you re-run with
`--auto` to allow them.

```bash
# Bounded, gated run:
node dist/cli.js --ask --budget 2 --effort xhigh --project /path/to/game "Build a shop UI"
```

## Live Studio sync (manual)

The CLI only *validates* the Rojo project. To push edits into a running Studio,
run `rojo serve` in the project dir and connect the Rojo plugin in Studio. Enable
the Roblox Studio MCP server in Studio's Assistant settings so the live bridge can
read the DataModel.

## Studio dock panel

Watch and steer a run from inside Studio. One-time setup:

```bash
blox panel install        # builds the plugin and copies it into Studio's plugins folder
```

Then in Studio: Plugins toolbar → **blox** → **blox panel**. Allow HTTP requests
when prompted (the panel talks to the local CLI on `127.0.0.1:35768`; override
with `panel.port` in `blox.config.json`).

With the panel open, `--ask` becomes interactive: gated actions (asset
generation, play mode, input sim) pause the run and show an Allow/Deny card in
the dock. Allow resumes the run; Deny tells the agent to continue without that
action. Without the panel, `--ask` behaves as before (blocked actions stop the
run). Gates time out after `panel.gateTimeoutSeconds` (default 120) back to the
stop behavior.

If the panel can't reach the CLI on WSL, check Windows↔WSL localhost forwarding
and set `BLOX_STUDIO_PLUGINS_DIR` if `panel install` can't find your plugins
folder.

## Non-Rojo onboarding

If your game has no Rojo project yet, `blox init` pulls the live Studio DataModel's
scripts into one, then commits a git baseline so `blox` can track subsequent edits.

```bash
node dist/cli.js init [--project <dir>] [--on-conflict abort|suffix] [--force]
```

**Requires:** an attached Studio with the MCP server enabled (same prerequisite as
`blox doctor`).

**What it does:**

- Walks the live DataModel and serializes every Script, LocalScript, and ModuleScript
  to Rojo-convention `.luau` files under `<dir>/src/`.
- Writes `<dir>/default.project.json` mapping the file tree back to the DataModel
  hierarchy.
- Commits the result as a git baseline (`git init` + initial commit if needed).

**Non-script instances** (Parts, Models, GUIs, Values, …) stay DataModel-first and
are not serialized; only script instances are pulled.

**`--on-conflict` behavior:** when two scripts share the same parent and name they
would map to the same file path. The default (`abort`) writes nothing and lists the
conflicts so you can resolve them first. Re-run with `--on-conflict suffix` to let
blox disambiguate automatically (`_2`, `_3`, …) and write everything.

**`--force`** overwrites an existing `default.project.json` and re-writes the
pulled scripts. It does **not** prune files from a previous onboard, so a script
renamed or deleted in Studio leaves its old `.luau` behind — remove stale files by
hand (or start from a clean dir) after big DataModel renames.

After `blox init`, run `rojo serve` in the project dir and click **Connect** in
Studio's Rojo plugin, then use `blox "<prompt>"` normally.

## Test

```bash
npm test                              # unit tests (no API key, no Studio)
BLOX_E2E=1 npx vitest run tests/e2e   # live end-to-end smoke (needs API key + rojo)
```

## Scope

SP1a is the core loop: prompt → edit `.luau` → Rojo project check → commit → report.
The verify/playtest loop, bounded fix loop, and asset generation are SP1b.

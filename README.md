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

## Live Studio sync (manual)

The CLI only *validates* the Rojo project. To push edits into a running Studio,
run `rojo serve` in the project dir and connect the Rojo plugin in Studio. Enable
the Roblox Studio MCP server in Studio's Assistant settings so the live bridge can
read the DataModel.

## Test

```bash
npm test                              # unit tests (no API key, no Studio)
BLOX_E2E=1 npx vitest run tests/e2e   # live end-to-end smoke (needs API key + rojo)
```

## Scope

SP1a is the core loop: prompt → edit `.luau` → Rojo project check → commit → report.
The verify/playtest loop, bounded fix loop, and asset generation are SP1b.

# blox auth — link a subscription and/or an API key

## Problem

blox forks the Claude Code engine (Agent SDK), which authenticates to Anthropic
in three native ways: a stored `claude` login (subscription, `apiKeySource:
"oauth"`), the `ANTHROPIC_API_KEY` env var, or a `CLAUDE_CODE_OAUTH_TOKEN`. Today
blox surfaces none of this:

- A non-CCR run passes `process.env` through untouched, so subscription auth
  *already works* if the user happened to run `claude auth login` — but it is
  undiscoverable, and there is no in-product way to set it up.
- There is no way to use an API key without globally exporting `ANTHROPIC_API_KEY`.
- There is no way to keep both linked and choose which one a run uses.

## Goal

Let a user link **either or both** a Claude subscription and an API key, and pick
which is active, all from the CLI.

## Non-goals

- Implementing OAuth (PKCE, redirect, token exchange, refresh) in blox.
- Managing credentials from the Studio dock (CLI-only this pass; a read-only dock
  chip is deferred).
- Touching the CCR / BYO-model auth path — those runs bring their own endpoint and
  key and are out of scope here.

## Key facts (verified)

- Standalone `claude` CLI (v2.1.185) is installed and exposes a full auth
  subsystem: `claude auth login` (browser sign-in), `claude auth logout`,
  `claude auth status` (JSON: `loggedIn`, `authMethod`, `apiProvider`, `email`,
  `subscriptionType`), and `claude setup-token`.
- The standalone CLI and the SDK's bundled engine share `~/.claude` credentials —
  so a login performed via `claude auth login` is seen by blox runs.
- The bundled SDK engine reads `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`
  from `Options.env`. `Options.env` is a **full** environment replacement (the
  existing `ccrRunEnv` copies `process.env` then overlays).
- The SDK rejects a request when both an API key and a bearer/OAuth token are
  present — so blox must inject **exactly one** credential.

## Design

### Credentials & active mode

- **Subscription** — delegated entirely to Claude Code. blox stores nothing; the
  `~/.claude` login is the source of truth. "Link" = shell out to
  `claude auth login`.
- **API key** — the only secret blox stores. User-level file
  `~/.config/blox/auth.json` (honor `XDG_CONFIG_HOME`, else `~/.config`), written
  mode `0600`. Never `blox.config.json` (that file is project-local and
  read-only), never logged.
- Store shape: `{ "mode"?: "subscription" | "apiKey", "apiKey"?: string }`.
- **Effective mode** resolution (for a run and for `status`):
  1. explicit per-run override (`--auth`), else
  2. stored `mode` — but `apiKey` only takes effect if a key is actually stored,
  3. otherwise `subscription`.
  (mode `apiKey` with no stored key silently falls back to subscription at run
  time; `blox auth status` makes the discrepancy visible.)

### CLI: `blox auth <subcommand>`

| Command | Action |
|---|---|
| `blox auth login` | spawn `claude auth login`, stdio inherited (browser flow) |
| `blox auth logout` | spawn `claude auth logout`, stdio inherited |
| `blox auth status` | merge `claude auth status` JSON + store: plan/email, key stored?, active mode |
| `blox auth key set` | prompt for key with echo off, write store `apiKey` (0600) |
| `blox auth key clear` | remove `apiKey` from store |
| `blox auth use subscription` / `blox auth use key` | set stored `mode` |

`claude` missing from PATH → clean error pointing at the install docs (only the
subscription/status subcommands need it; `key`/`use` do not).

### Per-run override flag

`--auth subscription|key` on `blox "<prompt>"` overrides the stored mode for that
run only. Mirrors the existing flag style in `args.ts`.

### Run wiring

New `buildAuthEnv(opts?)` in `src/auth.ts` returns a full env object (copy of
`process.env` with the credential overlay) or `undefined` for pure pass-through:

- effective mode `apiKey` + key stored → overlay `ANTHROPIC_API_KEY`; delete
  `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`.
- effective mode `subscription` → if `ANTHROPIC_API_KEY` is present in the base
  env, return a copy with it deleted (honor the choice); else return `undefined`
  (pass-through, stored login used).

Applied to **direct-Anthropic runs only**:

- CLI one-shot (`blox "<prompt>"`): pass `env: buildAuthEnv({ mode: override })`
  into `runOnce`.
- Daemon: `const env = useCcr ? ccrRunEnv(true) : buildAuthEnv()`. CCR runs keep
  today's behavior unchanged.

`buildAuthEnv` accepts injected `baseEnv` and `store` for testing.

### Out of scope / deferred

- Dock active-credential chip (read-only).
- `claude setup-token` paste path (not needed once `claude auth login` is wired).

## Testing

- Auth store: read missing/garbage/valid file; write creates `0600`; clear.
- Effective-mode resolution: override > stored(apiKey w/ key) > subscription;
  apiKey-without-key falls back to subscription.
- `buildAuthEnv`: apiKey overlay sets key + strips token vars; subscription strips
  a stray key; subscription with clean env returns `undefined`.
- `--auth` arg parsing (valid values, rejects junk).

## Files

- `src/auth.ts` (new) — store I/O, effective-mode, `buildAuthEnv`, `claude`
  shell-out (injectable), status struct + formatter.
- `src/args.ts` — `auth` command + `--auth` flag.
- `src/cli.ts` — `auth` subcommand dispatch; wire `buildAuthEnv` into one-shot.
- `src/panel/daemon.ts` — use `buildAuthEnv()` on the non-CCR run path.
- `tests/auth.test.ts` (new).

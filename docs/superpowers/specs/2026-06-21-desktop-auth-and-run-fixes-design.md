# Desktop: subscription sign-in + make a first run work

Date: 2026-06-21
Status: approved, ready to plan

## Problem

Phase 1 launch smoke on native Windows surfaced two blockers in the Electron
companion app (`app/`):

1. **Step 1 only accepts an API key.** No way to sign in with an Anthropic
   subscription, even though the engine already supports it (`blox auth login`
   → `claude auth login`).

2. **A run on a chosen folder does nothing.** Two distinct causes:
   - A pasted *quoted* path (`"C:\Users\matth\Downloads\test"`) keeps its
     literal quote characters — `console.ts:52` does `.trim()` only — so the
     directory is invalid.
   - An *unquoted* path to a fresh/empty folder also fails: the folder is not a
     blox/Rojo project (no `default.project.json`), and the run pipeline
     (`buildDigest` → `ensureServe` → `syncProject`) assumes one. The desktop
     app never runs `blox init`.

3. **Latent: the API-key path is also broken.** The desktop run forks the
   engine, which calls `buildAuthEnv()` (`cli.ts:276`). With no
   `~/.config/blox/auth.json`, `buildAuthEnv` defaults to **subscription** mode
   and **strips** `ANTHROPIC_API_KEY` from env (`auth.ts:103`) — but the desktop
   injects the vault key exactly that way (`engine.ts:49`). The engine discards
   the key and tries a subscription the user never linked. Two credential
   stores fight; the user's key never reaches the model.

## Goals

- Step 1 offers subscription sign-in **or** API key; either unblocks the run.
- A run on a fresh, correctly-typed Windows path actually builds.
- One credential store, read consistently by the engine.

## Non-goals (YAGNI)

- Re-implementing Anthropic OAuth inside Electron (no localhost-callback server).
- Keeping the `safeStorage`/`key.bin` encrypted vault (it cannot reach the
  engine's `buildAuthEnv` and duplicates the secret).
- Streaming engine stderr into the run log; switching auth mode after first run;
  multi-project picker.

## Design

### Single credential store

The engine's `~/.config/blox/auth.json` (`0600`, honors `XDG_CONFIG_HOME`)
becomes the sole desktop credential store. The Electron `safeStorage` vault
(`app/main/auth.ts`, `key.bin`) and the `ANTHROPIC_API_KEY` injection in
`engine.ts:buildChildEnv` are removed. Tradeoff: the API key lives in `0600`
JSON rather than OS-encrypted storage — identical to what the CLI already does,
and the only form `buildAuthEnv` honors.

### Part 1 — Step 1: subscription or API key

**Subscription sign-in:**
1. Pre-flight `host.runCli(['auth','status'])`. If the output/exit indicates
   `claude` is not on PATH, show the install hint
   (`https://claude.com/claude-code`) and stop — do not open a console.
2. Otherwise spawn a **new visible console window** for the interactive browser
   OAuth (the forked engine has piped stdio and cannot host it):
   `cmd.exe /c start "blox sign-in" cmd /k claude auth login` with
   `windowsHide:false`. The browser opens there; the window stays open so the
   user sees the result.
3. Poll `host.runCli(['auth','status'])` every ~2s (cap ~3 min). When it reports
   `subscription: linked`, run `host.runCli(['auth','use','subscription'])`,
   mark step 1 OK, and show `signed in (<plan>, <email>)`.

**API key:** main writes `~/.config/blox/auth.json` as
`{ "mode":"apiKey", "apiKey":"<key>" }` at mode `0600` directly. (`blox auth key
set` prompts interactively and cannot be driven through the piped fork.)

**Step-1 gate:** OK when subscription is linked **or** an API key is saved.

### Part 2 — make a run work

- **Quote strip** (`console.ts`): before sending, strip a single pair of
  wrapping `"` or `'` from the project path.
- **Auto-init on run** (`main` run handler): if `<projectPath>/default.project.json`
  does not exist, run `blox init --project <projectPath>` first (init pulls
  scripts from the open Studio place — step 4 already verifies Studio is
  attached), surface its stdout to the log, and only then start the run. If init
  fails, show its output and abort the run.

## Components touched

| File | Change |
|------|--------|
| `app/main/auth.ts` | Replace `safeStorage` vault with read/write of `~/.config/blox/auth.json` (`saveApiKey`, `hasCredential`, `subscriptionLinked`). |
| `app/main/engine.ts` | Drop `ANTHROPIC_API_KEY` injection from `buildChildEnv` (key now in auth.json). |
| `app/main/index.ts` | New IPC handlers: `authLoginSubscription`, `authSubscriptionStatus`; rework `authSave` to write auth.json; auto-init in `runStart`. |
| `app/main/setup.ts` | Helper to spawn the visible console + poll auth status (or co-locate in index.ts). |
| `app/shared/ipc.ts` + `app/main/preload.cjs` | New channel names + bridge methods, kept in sync. |
| `app/renderer/onboard.ts` | Step 1 UI: "Sign in with Anthropic" button + key input; gate on either. |
| `app/renderer/console.ts` | Quote-strip the path. |

## Error handling

- `claude` not on PATH → install hint, no console opened.
- OAuth abandoned → poll times out (~3 min) → step stays not-OK, message says
  retry.
- `blox init` fails (e.g. Studio not attached) → its stdout shown, run aborted.
- auth.json write failure (perms) → surfaced to the wizard.

## Testing

- `app/main/auth.test.ts`: rewrite for the auth.json read/write helpers (temp
  dir as the config home) — write/read key, detect subscription mode, missing
  file → empty.
- `engine.test.ts`: `buildChildEnv` no longer sets `ANTHROPIC_API_KEY`.
- New small unit for auth-status parsing (linked vs not-linked vs claude-missing)
  if logic lands in a pure function.
- Console-spawn + live OAuth + auto-init are I/O — covered by the manual Windows
  smoke, not unit tests.

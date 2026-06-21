# blox Desktop — Phase 0 Spike Runbook

Run this on a **native Windows** machine (not WSL). Commands are PowerShell.
Phase 0 proves the three §10 risks in the design spec before any build work;
it gates Phases 1–3 of the plan.

- Spec: `docs/superpowers/specs/2026-06-14-blox-desktop-companion-app-design.md`
- Plan: `docs/superpowers/plans/2026-06-14-blox-desktop-companion-app.md` (Phase 0)

> **Update 2026-06-21 — `blox auth` shipped.** Auth is no longer key-only, and
> Spike C's core question is already answered (see Spike C below). The standalone
> `claude` CLI exposes `claude auth login` (browser sign-in) / `logout` / `status`,
> and `blox auth` wraps it: `blox auth login`, `blox auth key set`,
> `blox auth use subscription|key`. The bundled engine and the standalone CLI
> share `~/.claude` creds; blox stores only the API key, at
> `~/.config/blox/auth.json` (0600). Spikes A and B are unaffected. See
> `docs/superpowers/specs/2026-06-21-blox-auth-design.md`.

## Prerequisites (one-time)

- Windows + Node ≥20, repo cloned **natively** (e.g. `C:\dev\blox`, not under `\\wsl$`).
- Roblox Studio installed; **Assistant settings → "Enable Studio as MCP server" ON**; a private place open.
- For the real-build steps: `rojo` installed + the Rojo Studio plugin; a Rojo project folder; `rojo serve` running and **Connect**ed in Studio.
- Auth available by **either** path (no longer key-only): a subscription login
  (`claude auth login`, or `blox auth login`) **or** an API key (`blox auth key set`,
  or an `ANTHROPIC_API_KEY` env var). The steps below use an env key for a
  self-contained shell; a stored subscription login works the same.

```powershell
cd C:\dev\blox
git checkout -b spike/desktop
npm install
npm run build        # produces dist\cli.js
# Pick ONE auth path:
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # env key, or…
# node dist\cli.js auth login           # …subscription (browser), or `blox auth key set`
node dist\cli.js auth status            # confirm: linked subscription or stored key
$env:SPIKE_PROJECT = "C:\path\to\your\rojo-project"
```

---

## Spike A — native-Windows engine run

**Question:** does the engine run natively on Windows and reach Studio without the WSL `cmd.exe` hop?

```powershell
# 1. doctor — Studio open, MCP toggle ON
node dist\cli.js doctor
```

**Look for:** `studio: ATTACHED`. Note the exact launcher the bridge used (win32 path = `%LOCALAPPDATA%\Roblox\mcp.bat` directly).

```powershell
# 2. real build — rojo serve running + Connected in Studio
node dist\cli.js "add a comment to a script" --ask --project $env:SPIKE_PROJECT
```

**Look for:** run completes, report prints. Note any native-Windows failure (path separators, `mcp.bat` spawn, `rojo` not found).

**GO/NO-GO:** GO if doctor attaches AND a build completes natively. Record any engine change needed.

---

## Spike B — Electron forks the CLI

**Question:** can `utilityProcess.fork` run the engine (which itself spawns the 235 MB SDK subprocess), and can a separate process reach the panel server?

```powershell
npm install -D electron     # throwaway, on the spike branch
mkdir spike
```

Create `spike\main.js`:

```js
const { app, utilityProcess } = require('electron');
const path = require('node:path');
app.whenReady().then(() => {
  const child = utilityProcess.fork(
    path.resolve(__dirname, '..', 'dist', 'cli.js'),
    ['add a comment', '--ask', '--project', process.env.SPIKE_PROJECT],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (d) => process.stdout.write('[engine] ' + d.toString()));
  child.on('exit', (code) => { console.log('engine exited', code); app.quit(); });
});
```

```powershell
# Studio + rojo connected, auth (key or subscription) + SPIKE_PROJECT still set in this shell
npx electron spike\main.js
```

**Look for:** engine output streams under `[engine]`; run completes; `engine exited 0`.

While the run is **mid-flight**, in a **second** PowerShell window:

```powershell
node -e "fetch('http://127.0.0.1:35768/api/v1/info').then(r=>r.json()).then(console.log).catch(e=>console.log('DOWN',e.message))"
```

**Look for:** `{ protocol: 4, runId: ..., project: ... }` (plus optional `state`
and `auth` fields) — confirms a separate process (≈ the renderer) can be a panel
client while the forked engine runs. The exact number isn't load-bearing; it must
equal the plugin's `PROTOCOL` constant (`plugin/src/init.server.luau`, currently 4).

**GO/NO-GO:** GO if the forked engine completes a real build AND `/info` answers. This is the highest-risk spike.

---

## Spike C — "Sign in with Claude" (mostly ANSWERED; now a Windows check, time-box: ½ day)

**Status:** the original question ("is a no-key subscription login reachable?") is
answered. `blox auth` (shipped 2026-06-21) delegates subscription login wholesale
to the standalone `claude` CLI (`claude auth login`), and the bundled engine reads
the same `~/.claude` creds — no OAuth implemented in blox, no SDK-internal entry
point needed. The v1 decision is therefore **already resolved: offer BOTH "Sign in
with Claude" (wrap `blox auth login` / `claude auth login`) and key-paste (wrap
`blox auth key set`).** The desktop app shells these out; it does not reimplement auth.

**What's left to verify on native Windows** (the only open risk):

```powershell
# 1. claude on PATH from the same shell the engine runs in?
where.exe claude
node dist\cli.js auth status   # JSON-ish: linked subscription, or stored key

# 2. browser login completes when spawned this way?
node dist\cli.js auth login    # should open a browser, return to a logged-in state
node dist\cli.js auth status   # confirm loggedIn / subscriptionType after

# 3. key path stores 0600-equivalent under %USERPROFILE%\.config\blox\auth.json
node dist\cli.js auth key set  # paste a key; then:
node dist\cli.js auth status
```

**Look for:** `auth login` opens a browser and lands logged in; `auth status`
reflects it; a run (Spike A/B) then works with **no** `ANTHROPIC_API_KEY` set.

**Decision rule:** the auth *paths* are settled. This spike only flags
**Windows-specific** breakage — `claude` not on PATH from the Electron/engine
context, or the spawned browser flow not completing. If either breaks, the desktop
fix is launcher/PATH plumbing (point at the bundled engine or an absolute `claude`
path), not an auth redesign. C never blocks Phases 1–3.

---

## Gate + cleanup

Create `docs\superpowers\notes\desktop-spike-findings.md`:

```markdown
# blox Desktop — Phase 0 spike findings

## Spike A — native-Windows engine run
- doctor ATTACHED: yes/no
- launcher used: <path>
- real build completed: yes/no
- engine change needed: <none / describe>
- GO / NO-GO:

## Spike B — Electron forks the CLI
- forked engine completed a build: yes/no
- /info reachable mid-run: yes/no
- packaging concern noted: <...>
- GO / NO-GO:

## Spike C — Sign in with Claude (auth path already settled: both login + key-paste)
- `claude` on PATH from engine context (native Windows): yes/no
- `blox auth login` browser flow completes on Windows: yes/no
- run works with no ANTHROPIC_API_KEY (subscription only): yes/no
- Windows fix needed (PATH / launcher plumbing): <none / describe>

## Decision
- Proceed to Phase 1? (A and B must be GO)
```

```powershell
# discard throwaway spike code; keep ONLY the findings doc
git checkout main
git branch -D spike/desktop
git add docs\superpowers\notes\desktop-spike-findings.md
git commit -m "docs(desktop): spike findings + GO/NO-GO"
```

**Proceed to Phase 1 only if Spike A and Spike B are GO.** If either is NO-GO, stop and revisit the spec (the fork model or desktop approach needs rethinking). Spike C only sets the auth path; it never blocks.

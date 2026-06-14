# blox Desktop — Phase 0 Spike Runbook

Run this on a **native Windows** machine (not WSL). Commands are PowerShell.
Phase 0 proves the three §10 risks in the design spec before any build work;
it gates Phases 1–3 of the plan.

- Spec: `docs/superpowers/specs/2026-06-14-blox-desktop-companion-app-design.md`
- Plan: `docs/superpowers/plans/2026-06-14-blox-desktop-companion-app.md` (Phase 0)

## Prerequisites (one-time)

- Windows + Node ≥20, repo cloned **natively** (e.g. `C:\dev\blox`, not under `\\wsl$`).
- Roblox Studio installed; **Assistant settings → "Enable Studio as MCP server" ON**; a private place open.
- For the real-build steps: `rojo` installed + the Rojo Studio plugin; a Rojo project folder; `rojo serve` running and **Connect**ed in Studio.
- `ANTHROPIC_API_KEY` available.

```powershell
cd C:\dev\blox
git checkout -b spike/desktop
npm install
npm run build        # produces dist\cli.js
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # your key
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
# Studio + rojo connected, key + SPIKE_PROJECT still set in this shell
npx electron spike\main.js
```

**Look for:** engine output streams under `[engine]`; run completes; `engine exited 0`.

While the run is **mid-flight**, in a **second** PowerShell window:

```powershell
node -e "fetch('http://127.0.0.1:35768/api/v1/info').then(r=>r.json()).then(console.log).catch(e=>console.log('DOWN',e.message))"
```

**Look for:** `{ protocol: 3, runId: ..., project: ... }` — confirms a separate process (≈ the renderer) can be a panel client while the forked engine runs.

**GO/NO-GO:** GO if the forked engine completes a real build AND `/info` answers. This is the highest-risk spike.

---

## Spike C — "Sign in with Claude" OAuth (time-box: 1 day)

**Question:** is a no-key subscription login reachable through the bundled SDK runtime?

```powershell
# inspect the bundled runtime for a login entry point
dir node_modules\@anthropic-ai\claude-agent-sdk-win32-x64
findstr /i "ApiKeySource oauth login" node_modules\@anthropic-ai\claude-agent-sdk\sdk.d.ts
```

Try to drive a `claude login`-style OAuth/device flow once manually; check whether it yields a credential the engine then uses (`apiProvider: 'firstParty'`, `apiKeySource: 'oauth'`).

**Decision rule:** clean programmatic login within the time-box → v1 offers "Sign in with Claude" + key-paste. Otherwise → **v1 ships key-paste only**, login button cut. C never blocks; it only sets the auth path.

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

## Spike C — Sign in with Claude
- programmatic login found: yes/no
- v1 auth path: key-paste only / key-paste + login

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

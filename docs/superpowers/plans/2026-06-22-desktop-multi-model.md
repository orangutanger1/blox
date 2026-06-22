# Desktop Multi-Model (OpenRouter + Local via managed CCR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a blox run target native Claude **or** an OpenRouter model **or** a local (Ollama/LM Studio) model — from both the bare CLI and the desktop wizard — by owning CCR's config and lifecycle while reusing CCR's translation.

**Architecture:** The core fix is in the engine: the one-shot CLI (`src/cli.ts`) does not route to CCR today (only the daemon does), so a `provider,slug` model 404s at api.anthropic.com. Phase 1 teaches the one-shot to route like the daemon (shared `ccrRunEnv` + `ensureCcr`), adds a `blox model add|list` command that writes/reads CCR config, and a `--model` flag. Phase 2 wires the desktop UI (model dropdown + wizard provider step) on top. The Agent SDK ↔ provider translation stays in CCR, untouched.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest (`tests/**/*.test.ts`). CCR = claude-code-router, config at `~/.claude-code-router/config.json`. Desktop = Electron (`app/`), forks `dist/cli.js`.

## Global Constraints

- **Root tests:** `npm test` (vitest, runs `tests/**/*.test.ts`). **Build:** `npm run build` (tsc). Run from repo root.
- **Desktop tests/build:** `cd app && npm test`, `cd app && npm run build`.
- A model string with a comma (`provider,slug`) is CCR-routed; native Claude has no comma (`src/agent/buildOptions.ts:70`).
- CCR config path: `process.env.CCR_CONFIG ?? ~/.claude-code-router/config.json`. Shape: `{ Providers: [{ name, api_base_url, api_key, models: string[], transformer?: { use: string[] } }], Router: { default: "name,slug" } }`.
- TS imports use `.js` specifiers even for `.ts` files (`import { x } from '../src/x.js'`).
- **Phase 2 prerequisite:** the `desktop-auth-run-fixes` plan (`docs/superpowers/plans/2026-06-21-desktop-auth-run-fixes.md`) must be **merged first**. It replaces the `safeStorage` vault with the shared `auth.json` cred store, reworks onboarding step 1 to "subscription **or** API key", and adds quote-strip + auto-init. Phase 2 tasks edit the **post-merge** versions of `app/main/index.ts`, `app/renderer/onboard.ts`, and `app/renderer/console.ts`. Tasks that are independent of it are marked.
- `app/main/preload.cjs` hand-copies the `IPC` object from `app/shared/ipc.ts` — any channel added in one MUST be added in both.

---

## PHASE 1 — Engine / CLI core (no prerequisite; against current `main`)

Deliverable after Phase 1: `blox model add openrouter <slug> --key …` then `blox "<prompt>" --model openrouter,<slug>` routes a real run through CCR. Bare-CLI BYO-model works; the desktop inherits `--model` and `blox model` for Phase 2.

### Task 1: Lift `ccrRunEnv` into `ccrServe.ts` (shared), repoint the daemon

**Files:**
- Modify: `src/ccrServe.ts`
- Modify: `src/panel/daemon.ts:78-93` (delete the private copy) and its imports
- Test: `tests/ccrServe.test.ts` (append)

**Interfaces:**
- Produces: `ccrRunEnv(useCcr: boolean): Record<string, string> | undefined`

- [ ] **Step 1: Write the failing test** — append to `tests/ccrServe.test.ts`:

```ts
describe('ccrRunEnv', () => {
  it('useCcr=false returns undefined (inherit env unchanged)', () => {
    expect(ccrRunEnv(false)).toBeUndefined();
  });
  it('useCcr=true points the SDK at CCR and drops a competing bearer token', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'leftover';
    const env = ccrRunEnv(true)!;
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\//);
    expect(env.ANTHROPIC_API_KEY).toBeTruthy();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });
});
```

Also update the existing import line at the top of `tests/ccrServe.test.ts` to include `ccrRunEnv`:

```ts
import { ccrReachable, ensureCcr, ccrStatus, formatCcrStatus, ccrRunEnv } from '../src/ccrServe.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ccrServe`
Expected: FAIL — `ccrRunEnv` is not exported from `src/ccrServe.js`.

- [ ] **Step 3: Write minimal implementation** — append this function to `src/ccrServe.ts` (it already imports `ccrEndpoint` from `./ccr.js`):

```ts
// Env for a routed run's model call. For a CCR-routed model, point the Agent SDK
// at CCR (ANTHROPIC_BASE_URL) with the x-api-key path and no competing bearer
// token. For a bare model return undefined so the run uses inherited env unchanged.
export function ccrRunEnv(useCcr: boolean): Record<string, string> | undefined {
  if (!useCcr) return undefined;
  const ep = ccrEndpoint();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.ANTHROPIC_BASE_URL = ep.baseUrl;
  env.ANTHROPIC_API_KEY = ep.apiKey;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}
```

Then in `src/panel/daemon.ts`: delete its local `ccrRunEnv` function (the `export function ccrRunEnv(...)` block, currently lines 78-93) and update its two import lines so it imports `ccrRunEnv` from `ccrServe` and drops the now-unused `ccrEndpoint`:

```ts
import { readCcrModels, resolveModel, type CcrModels } from '../ccr.js';
import { ensureCcr, ccrRunEnv } from '../ccrServe.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- ccrServe daemon`
Expected: PASS. (Daemon tests still green — it now imports the shared `ccrRunEnv`.)

- [ ] **Step 5: Build to confirm no unused-import error**

Run: `npm run build`
Expected: tsc succeeds (no "ccrEndpoint declared but never used" in daemon).

- [ ] **Step 6: Commit**

```bash
git add src/ccrServe.ts src/panel/daemon.ts tests/ccrServe.test.ts
git commit -m "refactor(ccr): lift ccrRunEnv into ccrServe so the CLI can route too"
```

---

### Task 2: `allCcrModels` — flat routable model list across all providers

`readCcrModels` reads only `Providers[0]` and the daemon depends on its shape. Add a non-breaking `allCcrModels` that spans every provider (the desktop dropdown needs OpenRouter and local at once).

**Files:**
- Modify: `src/ccr.ts`
- Test: `tests/ccr.test.ts` (append)

**Interfaces:**
- Produces: `allCcrModels(path?: string): string[]` — each entry a routable `"<provider>,<slug>"`.

- [ ] **Step 1: Write the failing test** — append to `tests/ccr.test.ts`:

```ts
describe('allCcrModels', () => {
  it('flattens every provider into routable provider,slug strings', () => {
    writeFileSync(tmp, JSON.stringify({
      Providers: [
        { name: 'openrouter', models: ['deepseek/deepseek-chat', 'openai/gpt-4o'] },
        { name: 'local', models: ['qwen2.5-coder'] },
      ],
    }));
    expect(allCcrModels(tmp)).toEqual([
      'openrouter,deepseek/deepseek-chat',
      'openrouter,openai/gpt-4o',
      'local,qwen2.5-coder',
    ]);
  });
  it('missing file → empty list', () => {
    expect(allCcrModels(join(tmpdir(), `ccr-none-${process.pid}.json`))).toEqual([]);
  });
});
```

Update the import at the top of `tests/ccr.test.ts` to add `allCcrModels`:

```ts
import { readCcrModels, resolveModel, ccrEndpoint, allCcrModels } from '../src/ccr.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ccr`
Expected: FAIL — `allCcrModels` not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/ccr.ts`:

```ts
// Every configured provider's models as routable "provider,slug" strings. The
// desktop model dropdown spans all providers; readCcrModels reads only the first
// (the daemon's single-provider path), so this is additive, not a replacement.
export function allCcrModels(path: string = ccrConfigPath()): string[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  const providers = (raw as { Providers?: unknown }).Providers;
  if (!Array.isArray(providers)) return [];
  const out: string[] = [];
  for (const p of providers) {
    const name = (p as { name?: unknown }).name;
    const models = (p as { models?: unknown }).models;
    if (typeof name !== 'string' || !Array.isArray(models)) continue;
    for (const m of models) if (typeof m === 'string') out.push(`${name},${m}`);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ccr`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ccr.ts tests/ccr.test.ts
git commit -m "feat(ccr): allCcrModels flattens every provider for the model picker"
```

---

### Task 3: `writeProvider` — upsert a CCR provider block

**Files:**
- Create: `src/model.ts`
- Test: `tests/model.test.ts` (new)

**Interfaces:**
- Consumes: `ccrConfigPath` (from `src/ccr.ts`), `allCcrModels` (Task 2, for the test).
- Produces:
  - `type ProviderKind = 'openrouter' | 'local'`
  - `interface AddProviderOpts { apiKey?: string; baseUrl?: string; models: string[] }`
  - `writeProvider(kind: ProviderKind, opts: AddProviderOpts, path?: string): void`

- [ ] **Step 1: Write the failing test** — create `tests/model.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeProvider } from '../src/model.js';
import { allCcrModels } from '../src/ccr.js';

const tmp = join(tmpdir(), `model-test-${process.pid}.json`);
afterEach(() => { try { rmSync(tmp); } catch { /* ignore */ } });

describe('writeProvider', () => {
  it('writes an OpenRouter block with transformer + Router.default', () => {
    writeProvider('openrouter', { apiKey: 'sk-or-x', models: ['deepseek/deepseek-chat'] }, tmp);
    const cfg = JSON.parse(readFileSync(tmp, 'utf8'));
    expect(cfg.Providers[0]).toMatchObject({
      name: 'openrouter',
      api_base_url: 'https://openrouter.ai/api/v1/chat/completions',
      api_key: 'sk-or-x',
      models: ['deepseek/deepseek-chat'],
      transformer: { use: ['openrouter'] },
    });
    expect(cfg.Router.default).toBe('openrouter,deepseek/deepseek-chat');
  });

  it('local block has no transformer and defaults to the Ollama base URL', () => {
    writeProvider('local', { models: ['qwen2.5-coder'] }, tmp);
    const cfg = JSON.parse(readFileSync(tmp, 'utf8'));
    expect(cfg.Providers[0].transformer).toBeUndefined();
    expect(cfg.Providers[0].api_base_url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('upsert replaces a same-named provider but preserves others', () => {
    writeProvider('local', { models: ['qwen2.5-coder'] }, tmp);
    writeProvider('openrouter', { apiKey: 'k', models: ['openai/gpt-4o'] }, tmp);
    writeProvider('local', { models: ['llama3.1'] }, tmp); // replace local
    expect(allCcrModels(tmp).sort()).toEqual(['local,llama3.1', 'openrouter,openai/gpt-4o']);
  });

  it('rejects openrouter without a key and any provider without a model', () => {
    expect(() => writeProvider('openrouter', { models: ['x'] }, tmp)).toThrow(/key/);
    expect(() => writeProvider('local', { models: [] }, tmp)).toThrow(/model/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- model`
Expected: FAIL — `src/model.js` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/model.ts`:

```ts
// src/model.ts — friendly writer for ~/.claude-code-router/config.json. blox owns
// CCR's config so the user never hand-edits it; CCR still does the translation.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ccrConfigPath } from './ccr.js';

export type ProviderKind = 'openrouter' | 'local';
export interface AddProviderOpts { apiKey?: string; baseUrl?: string; models: string[] }

const DEFAULTS: Record<ProviderKind, { baseUrl: string; transformer?: { use: string[] } }> = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1/chat/completions', transformer: { use: ['openrouter'] } },
  local: { baseUrl: 'http://localhost:11434/v1/chat/completions' },
};

interface CcrProvider { name: string; api_base_url: string; api_key: string; models: string[]; transformer?: { use: string[] } }
interface CcrConfig { Providers?: CcrProvider[]; Router?: { default?: string; [k: string]: unknown }; [k: string]: unknown }

// Upsert one provider block per kind and point Router.default at its first model.
// Other providers and unrelated config keys are preserved.
export function writeProvider(kind: ProviderKind, opts: AddProviderOpts, path: string = ccrConfigPath()): void {
  if (opts.models.length === 0) throw new Error(`${kind}: at least one model is required`);
  if (kind === 'openrouter' && !opts.apiKey) throw new Error('openrouter: an API key is required');

  let cfg: CcrConfig = {};
  if (existsSync(path)) {
    try { cfg = JSON.parse(readFileSync(path, 'utf8')) as CcrConfig; } catch { cfg = {}; }
  }
  const def = DEFAULTS[kind];
  const block: CcrProvider = {
    name: kind,
    api_base_url: opts.baseUrl || def.baseUrl,
    api_key: opts.apiKey || 'local', // CCR wants a non-empty key; local servers ignore it
    models: opts.models,
    ...(def.transformer ? { transformer: def.transformer } : {}),
  };
  const others = Array.isArray(cfg.Providers) ? cfg.Providers.filter((p) => p.name !== kind) : [];
  cfg.Providers = [...others, block];
  cfg.Router = { ...(cfg.Router ?? {}), default: `${kind},${opts.models[0]}` };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- model`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/model.ts tests/model.test.ts
git commit -m "feat(model): writeProvider upserts a CCR provider block (openrouter/local)"
```

---

### Task 4: `--model` / `--key` / `--base-url` flags + `model` command + config override

**Files:**
- Modify: `src/args.ts`
- Modify: `src/config.ts`
- Test: `tests/args.test.ts` (append), `tests/config.test.ts` (append)

**Interfaces:**
- Produces (added to `ParsedArgs`): `model: string | null`, `key: string | null`, `baseUrl: string | null`; `command` union gains `'model'`.
- Produces: `overridesFromArgs` accepts `model: string | null` and maps it to `config.model`.

- [ ] **Step 1: Write the failing tests** — append to `tests/args.test.ts`:

```ts
it('parses the model command with positional slugs and --key', () => {
  const a = parseArgs(['model', 'add', 'openrouter', 'deepseek/deepseek-chat', '--key', 'sk-or-x']);
  expect(a.command).toBe('model');
  expect(a.prompt).toBe('add openrouter deepseek/deepseek-chat');
  expect(a.key).toBe('sk-or-x');
});
it('--model sets the run model; --base-url is captured', () => {
  const a = parseArgs(['build a tower', '--model', 'openrouter,deepseek/deepseek-chat', '--base-url', 'http://h/v1']);
  expect(a.command).toBeNull();
  expect(a.model).toBe('openrouter,deepseek/deepseek-chat');
  expect(a.baseUrl).toBe('http://h/v1');
});
```

Append to `tests/config.test.ts` (the file already imports from `../src/config.js`; add `overridesFromArgs` to that import if it is not already there):

```ts
it('overridesFromArgs passes the run model through', () => {
  const o = overridesFromArgs({ projectPath: null, maxTurns: null, maxBudgetUsd: null, effort: null, mode: null, model: 'openrouter,x' });
  expect(o.model).toBe('openrouter,x');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- args config`
Expected: FAIL — `a.model`/`a.key`/`a.baseUrl` undefined; `overridesFromArgs` rejects the `model` property / returns no `model`.

- [ ] **Step 3: Write minimal implementation.**

In `src/args.ts`:
- Add `'model'` to the `command` type in the `ParsedArgs` interface (line 2) and to the `let command:` declaration (line 21). Both become:
  ```ts
  command: 'doctor' | 'serve' | 'init' | 'panel' | 'auth' | 'model' | null;
  ```
- Add three fields to the `ParsedArgs` interface:
  ```ts
  model: string | null;
  key: string | null;
  baseUrl: string | null;
  ```
- Add three locals near the other `let` declarations:
  ```ts
  let model: string | null = null;
  let key: string | null = null;
  let baseUrl: string | null = null;
  ```
- Add flag parsing inside the `for` loop (before the `else if (a === 'init' …)` command branches):
  ```ts
  else if (a === '--model') model = argv[++i] ?? null;
  else if (a === '--key') key = argv[++i] ?? null;
  else if (a === '--base-url') baseUrl = argv[++i] ?? null;
  ```
- Add the command token among the other command branches:
  ```ts
  else if (a === 'model' && command === null && positional.length === 0) command = 'model';
  ```
- Add `model, key, baseUrl` to the returned object.

In `src/config.ts`:
- Add `model: string | null;` to the `overridesFromArgs` parameter type.
- Add `if (a.model != null) o.model = a.model;` inside `overridesFromArgs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- args config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/args.ts src/config.ts tests/args.test.ts tests/config.test.ts
git commit -m "feat(cli): --model/--key/--base-url flags, model command, model override"
```

---

### Task 5: `ensureCcrInstalled` — install-on-first-use

`ensureCcr` only *starts* CCR. On a clean box `ccr` is absent. Add a one-time installer.

**Files:**
- Modify: `src/ccrServe.ts`
- Test: `tests/ccrServe.test.ts` (append)

**Interfaces:**
- Produces:
  - `interface InstallDeps { probe?: (bin: string) => boolean; install?: () => boolean }`
  - `ensureCcrInstalled(log?: (m: string) => void, deps?: InstallDeps): boolean`

- [ ] **Step 1: Write the failing test** — append to `tests/ccrServe.test.ts`:

```ts
describe('ensureCcrInstalled', () => {
  it('present on PATH → true, no install attempted', () => {
    const install = vi.fn(() => true);
    expect(ensureCcrInstalled(() => {}, { probe: () => true, install })).toBe(true);
    expect(install).not.toHaveBeenCalled();
  });
  it('absent → installs once and returns true on success', () => {
    const logs: string[] = [];
    expect(ensureCcrInstalled((m) => logs.push(m), { probe: () => false, install: () => true })).toBe(true);
    expect(logs.join(' ')).toMatch(/installing/i);
  });
  it('absent and install fails → false with a manual hint', () => {
    const logs: string[] = [];
    expect(ensureCcrInstalled((m) => logs.push(m), { probe: () => false, install: () => false })).toBe(false);
    expect(logs.join(' ')).toMatch(/npm i -g @musistudio\/claude-code-router/);
  });
});
```

Update the `tests/ccrServe.test.ts` import line to add `ensureCcrInstalled`:

```ts
import { ccrReachable, ensureCcr, ccrStatus, formatCcrStatus, ccrRunEnv, ensureCcrInstalled } from '../src/ccrServe.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ccrServe`
Expected: FAIL — `ensureCcrInstalled` not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/ccrServe.ts` (add `import { spawnSync } from 'node:child_process';` at the top alongside the existing `spawn as nodeSpawn` import):

```ts
export interface InstallDeps {
  probe?: (bin: string) => boolean; // is `bin` resolvable on PATH
  install?: () => boolean; // run the one-time global install, return success
}

// Install-on-first-use for CCR: present on PATH → done; otherwise `npm i -g
// @musistudio/claude-code-router` once. Returns whether ccr is available after.
// Both effects injected so this unit tests without touching the machine.
export function ensureCcrInstalled(log: (m: string) => void = () => {}, deps: InstallDeps = {}): boolean {
  const probe = deps.probe ?? ((bin: string) =>
    spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0);
  if (probe('ccr')) return true;

  log('Installing claude-code-router (one-time)…');
  const install = deps.install ?? (() =>
    spawnSync('npm', ['i', '-g', '@musistudio/claude-code-router'],
      { stdio: 'inherit', shell: process.platform === 'win32' }).status === 0);
  if (install()) { log('claude-code-router installed.'); return true; }

  log('Could not auto-install. Install it manually: npm i -g @musistudio/claude-code-router');
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ccrServe`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ccrServe.ts tests/ccrServe.test.ts
git commit -m "feat(ccr): ensureCcrInstalled installs claude-code-router on first use"
```

---

### Task 6: Route the one-shot CLI + `blox model` dispatch

**Files:**
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `ensureCcr`, `ensureCcrInstalled`, `ccrRunEnv` (`./ccrServe.js`); `allCcrModels` (`./ccr.js`); `writeProvider`, `ProviderKind` (`./model.js`); `--model`/`--key`/`--base-url` + `model` command (Task 4).

- [ ] **Step 1: Add imports.**

In `src/cli.ts`, change the ccrServe import to add the three functions:

```ts
import { ccrStatus, formatCcrStatus, ensureCcr, ensureCcrInstalled, ccrRunEnv } from './ccrServe.js';
```

Add two new imports near the other `./` imports:

```ts
import { allCcrModels } from './ccr.js';
import { writeProvider, type ProviderKind } from './model.js';
```

- [ ] **Step 2: Add the `model` command dispatch.**

Insert this block immediately after the `if (command === 'auth') { … }` block (after its closing brace, before `if (!prompt) {`):

```ts
  if (command === 'model') {
    const parts = (prompt ?? '').split(' ').filter(Boolean);
    const sub = parts[0];
    if (sub === 'list') {
      const models = allCcrModels();
      console.log(models.length ? models.join('\n') : '(no providers configured)');
      process.exit(0);
    }
    if (sub === 'add' && (parts[1] === 'openrouter' || parts[1] === 'local')) {
      const kind = parts[1] as ProviderKind;
      const models = parts.slice(2);
      try {
        writeProvider(kind, { apiKey: args.key ?? undefined, baseUrl: args.baseUrl ?? undefined, models });
      } catch (e) {
        console.error((e as Error).message);
        process.exit(2);
      }
      ensureCcrInstalled((m) => console.log(m)); // best-effort; config is written regardless
      console.log(`added ${kind} (${models.length} model${models.length === 1 ? '' : 's'}). Run with: --model ${kind},<slug>`);
      process.exit(0);
    }
    console.error('usage: blox model add openrouter <slug...> --key <k>  |  blox model add local <name> [--base-url <url>]  |  blox model list');
    process.exit(2);
  }
```

- [ ] **Step 3: Route the one-shot run through CCR for a routed model.**

In the run section, find the `runOnce(config, prompt, { … })` call (around line 267) inside the `try {`. Immediately **before** that `const report = await runOnce(...)` line, insert:

```ts
    // A routed model (`provider,slug`) only routes if the SDK talks to CCR, not
    // api.anthropic.com — the daemon already does this; the one-shot must too.
    const routed = config.model.includes(',');
    if (routed) {
      ensureCcrInstalled((m) => console.log(m));
      if (!(await ensureCcr((m) => console.log(m)))) {
        console.error('CCR router unavailable — cannot run a routed model. Install: npm i -g @musistudio/claude-code-router');
        process.exit(1);
      }
    }
```

Then change the `env:` line inside the `runOnce(...)` options from:

```ts
      env: buildAuthEnv({ override: args.authMode }),
```

to:

```ts
      env: routed ? ccrRunEnv(true) : buildAuthEnv({ override: args.authMode }),
```

- [ ] **Step 4: Update the no-prompt usage string** so `blox model` is discoverable. In the `if (!prompt)` block, append to the usage message string: ` | blox model add openrouter <slug...> --key <k>|add local <name>|list`.

- [ ] **Step 5: Build + full suite (no regressions)**

Run: `npm run build && npm test`
Expected: build clean; all tests PASS.

- [ ] **Step 6: Manual routed smoke (no unit coverage — real CCR + provider)**

```bash
node dist/cli.js model add openrouter deepseek/deepseek-chat --key sk-or-<your-key>
node dist/cli.js model list            # → openrouter,deepseek/deepseek-chat
# In a blox project dir with Studio open:
node dist/cli.js "make a red part" --project <dir> --auto --model openrouter,deepseek/deepseek-chat
```
Expected: CCR starts if down; the run drives `execute_luau` against Studio (no api.anthropic.com 404).

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): one-shot routes routed models through CCR + blox model command"
```

---

## PHASE 2 — Desktop UI (prerequisite: `desktop-auth-run-fixes` merged)

Deliverable after Phase 2: the wizard can add an OpenRouter/local provider; the run screen has a model dropdown (Claude + configured providers); selecting one routes the desktop run. Tasks 7 and 8 edit files reworked by `desktop-auth-run-fixes` — edit their **post-merge** content.

### Task 7: Engine `--model` plumbing *(independent of auth-run-fixes; safe anytime)*

**Files:**
- Modify: `app/main/engine.ts`
- Test: `app/main/engine.test.ts` (append)

**Interfaces:**
- Produces: `RunOptions.model?: string`; `buildRunArgs` appends `--model <m>` when set.

- [ ] **Step 1: Write the failing test** — append to `app/main/engine.test.ts`:

```ts
describe('buildRunArgs model', () => {
  it('appends --model when set', () => {
    const a = buildRunArgs('p', '/x', { model: 'openrouter,deepseek/deepseek-chat' });
    expect(a[a.indexOf('--model') + 1]).toBe('openrouter,deepseek/deepseek-chat');
  });
  it('omits --model when unset', () => {
    expect(buildRunArgs('p', '/x', {})).not.toContain('--model');
  });
});
```

(If `buildRunArgs` is not already imported in `engine.test.ts`, add it to the existing `./engine.js` import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm test -- engine`
Expected: FAIL — `--model` never appears.

- [ ] **Step 3: Write minimal implementation** — in `app/main/engine.ts`:

Add `model?: string;` to the `RunOptions` interface. In `buildRunArgs`, after the `if (o.image) …` line, add:

```ts
  if (o.model) args.push('--model', o.model);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm test -- engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/main/engine.ts app/main/engine.test.ts
git commit -m "feat(desktop): buildRunArgs forwards --model to the engine"
```

---

### Task 8: IPC channels `modelAdd` / `modelList` + main handlers

**Files:**
- Modify: `app/shared/ipc.ts`
- Modify: `app/main/preload.cjs`
- Modify: `app/main/index.ts` (post-auth-run-fixes version)

**Interfaces:**
- Produces (channels, identical strings in `ipc.ts` and `preload.cjs`): `modelAdd: 'model:add'`, `modelList: 'model:list'`.
- Produces (preload bridges): `bloxSetup.addModel(kind, opts)`, `bloxSetup.listModels()`, and `blox.listModels()`.
- Produces (`RunStartPayload`): `model?: string`.

- [ ] **Step 1: Add channel constants + payload field** — in `app/shared/ipc.ts`, inside the `IPC` object after `onboardComplete`, add:

```ts
  modelAdd: 'model:add',
  modelList: 'model:list',
```

In the same file, add to `RunStartPayload`:

```ts
  model?: string;
```

- [ ] **Step 2: Mirror in preload + expose bridges** — in `app/main/preload.cjs`:

In the local `IPC = { … }` object, add the same two lines:

```js
  modelAdd: 'model:add',
  modelList: 'model:list',
```

In `exposeInMainWorld('blox', { … })`, add after `onRunExited`:

```js
  listModels: () => ipcRenderer.invoke(IPC.modelList),
```

In `exposeInMainWorld('bloxSetup', { … })`, add after `onboardComplete`:

```js
  addModel: (kind, opts) => ipcRenderer.invoke(IPC.modelAdd, kind, opts),
  listModels: () => ipcRenderer.invoke(IPC.modelList),
```

- [ ] **Step 3: Add main handlers** — in `app/main/index.ts` (post-auth-run-fixes), inside `createWindow` after the onboarding handlers, add:

```ts
  // Multi-model: write CCR provider config + list configured models via the engine.
  ipcMain.handle(IPC.modelAdd, async (_e, kind: 'openrouter' | 'local', opts: { key?: string; baseUrl?: string; models: string[] }) => {
    const cmd = ['model', 'add', kind, ...opts.models];
    if (opts.key) cmd.push('--key', opts.key);
    if (opts.baseUrl) cmd.push('--base-url', opts.baseUrl);
    const r = await host.runCli(cmd);
    return { ok: r.code === 0, detail: r.stdout.trim() };
  });
  ipcMain.handle(IPC.modelList, async () => {
    const r = await host.runCli(['model', 'list']);
    return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('('));
  });
```

- [ ] **Step 4: Forward the model on a run** — in the `IPC.runStart` handler (post-auth-run-fixes, which is `async` and auto-inits), add `model: p.model` to the `host.run(...)` options object:

```ts
    const handle = host.run(p.prompt, p.projectPath, {
      mode: p.mode, maxTurns: p.maxTurns, budgetUsd: p.budgetUsd, effort: p.effort, model: p.model,
    });
```

- [ ] **Step 5: Verify build** (wiring only, no unit test)

Run: `cd app && npm run build`
Expected: tsc succeeds.

- [ ] **Step 6: Commit**

```bash
git add app/shared/ipc.ts app/main/preload.cjs app/main/index.ts
git commit -m "feat(desktop): IPC for model add/list; forward model on run"
```

---

### Task 9: Wizard provider step (onboard.ts) — extends auth-run-fixes step 1

**Files:**
- Modify: `app/renderer/onboard.ts` (post-auth-run-fixes version, which has `authOk`, `$('signin')`, `$('saveKey')`)

**Interfaces:**
- Consumes: `window.bloxSetup.addModel`, `window.bloxSetup.listModels` (Task 8).

- [ ] **Step 1: Extend the bridge type.** In the `interface bloxSetup { … }` (inside `declare global`), after the auth methods add:

```ts
      addModel(kind: 'openrouter' | 'local', opts: { key?: string; baseUrl?: string; models: string[] }): Promise<{ ok: boolean; detail: string }>;
      listModels(): Promise<string[]>;
```

- [ ] **Step 2: Add the optional "other model" markup.** In the `root.innerHTML` template, after the API-key line (the `…paste an API key…` block from auth-run-fixes), add:

```ts
    <div>or use another model (optional):
      <select id="provider"><option value="openrouter">OpenRouter</option><option value="local">Local (Ollama)</option></select>
      <input id="provKey" placeholder="OpenRouter key" style="width:28%" />
      <input id="provModel" placeholder="model slug e.g. deepseek/deepseek-chat" style="width:28%" />
      <button id="addModel">Add</button> <span id="modelOut"></span></div>
```

- [ ] **Step 3: Add the handler.** After the existing `$('saveKey')` handler, add:

```ts
  $('addModel').addEventListener('click', async () => {
    const kind = ($('provider') as HTMLSelectElement).value as 'openrouter' | 'local';
    const model = ($('provModel') as HTMLInputElement).value.trim();
    const key = ($('provKey') as HTMLInputElement).value.trim();
    if (!model) { $('modelOut').textContent = 'enter a model slug'; return; }
    $('modelOut').textContent = 'adding (installing router if needed)…';
    const r = await window.bloxSetup.addModel(kind, { models: [model], key: key || undefined });
    $('modelOut').textContent = r.ok ? `added ${kind} ✓` : (r.detail || 'failed');
    // A configured routed provider is valid credentials too — satisfy the auth gate.
    if (r.ok) { authOk = true; refresh(); }
  });
```

- [ ] **Step 4: Verify build + full desktop suite**

Run: `cd app && npm run build && npm test`
Expected: build succeeds; all unit tests PASS (no onboard regressions).

- [ ] **Step 5: Commit**

```bash
git add app/renderer/onboard.ts
git commit -m "feat(desktop): wizard can add an OpenRouter/local model (optional)"
```

---

### Task 10: Run-screen model dropdown (console.ts) — extends auth-run-fixes console

**Files:**
- Modify: `app/renderer/console.ts` (post-auth-run-fixes version, which has the quote-strip + `onRunLog`)

**Interfaces:**
- Consumes: `window.blox.listModels` (Task 8).

- [ ] **Step 1: Extend the bridge type.** In the `interface blox { … }` (inside `declare global`), after `onRunExited`/`onRunLog`, add:

```ts
      listModels(): Promise<string[]>;
```

- [ ] **Step 2: Add the dropdown to the markup.** In the `app.innerHTML` template, add a model select next to the Run button — change the run/cancel line to:

```ts
  <select id="model"><option value="">Claude (default)</option></select>
  <button id="run">Run</button> <button id="cancel">Cancel</button>
```

- [ ] **Step 3: Populate it on load.** After the `app.innerHTML = …` assignment, add:

```ts
void window.blox.listModels().then((models) => {
  const sel = document.getElementById('model') as HTMLSelectElement;
  sel.innerHTML = '<option value="">Claude (default)</option>'
    + models.map((m) => `<option value="${m}">${m}</option>`).join('');
});
```

- [ ] **Step 4: Send the selected model with the run.** In the `run` click handler, read the model and include it in `runStart`. Change:

```ts
  await window.blox.runStart({ prompt, projectPath, mode: 'ask' });
```

to:

```ts
  const model = (document.getElementById('model') as HTMLSelectElement).value || undefined;
  await window.blox.runStart({ prompt, projectPath, mode: 'ask', model });
```

- [ ] **Step 5: Verify build**

Run: `cd app && npm run build`
Expected: tsc succeeds.

- [ ] **Step 6: Commit**

```bash
git add app/renderer/console.ts
git commit -m "feat(desktop): run-screen model dropdown routes the run"
```

---

### Task 11: Manual Windows smoke (no unit coverage possible)

**Files:** none (verification only).

- [ ] **Step 1:** `cd app && npm run build && npm start`.
- [ ] **Step 2:** Wizard → "use another model" → OpenRouter, paste key, slug `deepseek/deepseek-chat`, Add. On a clean box the one-time `npm i -g …` runs; the line flips to `added openrouter ✓`. The auth gate is satisfied even without Claude.
- [ ] **Step 3:** Finish onboarding. Run screen → the model dropdown shows `Claude (default)` + `openrouter,deepseek/deepseek-chat`.
- [ ] **Step 4:** Pick the OpenRouter model, enter a project path + prompt, Run. With Studio open, the routed run builds (CCR auto-starts; no api.anthropic.com 404).
- [ ] **Step 5:** Pick `Claude (default)` and confirm a native run still works (no regression).
- [ ] **Step 6 (optional, local):** with Ollama running, add a local model (e.g. `qwen2.5-coder`), pick it, run; confirm it routes to `localhost:11434`.

---

## Self-Review

- **Spec coverage:** routed one-shot fix (Task 6) ✓; `blox model add/list` writing CCR config (Tasks 3,4,6) ✓; `writeProvider` openrouter+local shapes + upsert (Task 3) ✓; union model list (Task 2) ✓; `ccrRunEnv` shared (Task 1) ✓; `--model` flag + override (Task 4) ✓; install-on-first-use (Task 5, invoked in Tasks 6 & 8) ✓; desktop `--model` plumbing (Task 7) ✓; IPC + handlers (Task 8) ✓; wizard provider step (Task 9) ✓; run dropdown (Task 10) ✓; error handling — CCR missing/down (Tasks 5,6), bad key/local-down via forwarded stderr (existing), routed turn cap + reasoning-400 already handled (`buildOptions.ts`) ✓; native Claude untouched (Tasks 6,8 branch on the comma) ✓.
- **Deviation from spec:** `blox model list` prints newline-delimited model strings (the desktop splits stdout) instead of `--json` — model strings have no whitespace, so this is sufficient and lazier. `readCcrModels` is left intact (daemon depends on its shape); the union lives in the additive `allCcrModels`.
- **Placeholder scan:** none — every code step has full content.
- **Type consistency:** `ProviderKind`/`AddProviderOpts.models`/`writeProvider` (Task 3) match the `blox model add` dispatch (Task 6) and the `addModel` IPC payload `{ key?, baseUrl?, models }` (Tasks 8–9); `ccrRunEnv(boolean)` (Task 1) matches the cli caller (Task 6); `allCcrModels(): string[]` (Task 2) matches `model list` + the dropdown (Tasks 6,8,10); `RunOptions.model`/`RunStartPayload.model`/`--model` consistent across Tasks 4,7,8,10.
- **Prerequisite called out:** Phase 2 Tasks 8–10 edit post-`desktop-auth-run-fixes` files; Task 7 is independent.

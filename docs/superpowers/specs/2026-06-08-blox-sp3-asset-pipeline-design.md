# blox SP3 — asset pipeline (agentic generate→verify loop) Design

## 1. Goal

Make blox's asset generation actually usable end-to-end. Today four asset tools
are exposed (`generate_mesh`, `generate_material`, `generate_procedural_model`,
`insert_from_creator_store`) but two of them are **dead** because their required
companion tools are not exposed. This slice exposes the two missing tools and
rewrites the thin one-line asset hint into a real generate→verify workflow that
exploits blox's existing `screen_capture` (SP2-b) and play (SP1c-d) to close an
**agentic asset-iteration loop** — what nilo.io / forgegui.com do with a human in
the loop, blox does automatically.

This is the **lean** slice of SP3 "asset pipeline." The master design
(`docs/superpowers/specs/2026-06-06-blox-design.md` §SP3) lists asset libraries,
prototype→final quality tiers, and custom uploads — those stay deferred (§7).

## 2. Motivation — live probe evidence

Probed against an attached Studio (`scripts/probe-assets.ts`, 2026-06-08) using
the real MCP client. Exact `inputSchema` for all 7 asset-related tools and live
call results captured.

**Tool behavior (observed):**

| Tool | Behavior | Result text |
|------|----------|-------------|
| `generate_mesh` | **SYNC, blocks ~29s** | `{"tag":"Assistant-MeshGen-<uuid>"}` (inserts a MeshPart, returns its name) |
| `generate_material` | (not called — `materialId` is a required input) | required: `materialPattern`,`materialId`,`baseMaterial`,`materialDescription` |
| `generate_procedural_model` | **ASYNC, returns ~0.4s** | free text `"Generation job submitted successfully. Generation ID: <uuid>"` |
| `wait_job_finished` | pairs with procedural | args `generationId` (req) + `timeout` (default 600s); done-result shape un-probed (confirmed in the live test) |
| `search_creator_store` | sync ~0.4s | `{"searchId":"<uuid>","objectTypes":["tree","plant","tree house",...]}` |
| `insert_from_creator_store` | already exposed | requires `searchId` from `search_creator_store`; optional `objectTypes`, `assetName` |
| `store_image` | not called | `filePath` (local png/jpg) → `IMAGEID_<id>` (feeds `generate_procedural_model.attachedImageUri`) |

**Two dead chains found (the concrete, evidence-backed flaws):**

- **Flaw 1 — procedural generation cannot complete.** `generate_procedural_model`
  is exposed and async: it returns only a `Generation ID`. Completing the job
  requires `wait_job_finished(generationId)`, which is **not exposed**. So the
  agent submits a job it can never resolve — the model never lands.
- **Flaw 2 — creator-store insert cannot start.** `insert_from_creator_store` is
  exposed but requires a `searchId` produced only by `search_creator_store`,
  which is **not exposed**. So the agent has an insert tool it can never feed.

Exposing the two missing tools (`wait_job_finished`, `search_creator_store`)
repairs both chains. Everything else is workflow guidance.

**Why a loop (the nilo/forge insight):** both products are single-shot,
human-in-the-loop — the human prompts, looks at the result, and refines. blox
already has the pieces to automate that: generate → (poll if async) → insert →
`screen_capture` in play → judge vs intent → refine prompt → regenerate. The
slice's value is encoding that loop in the system prompt.

## 3. Architecture

Thin **pass-through**, consistent with SP2-a/b: **no new blox module, no blox
state, no MCP orchestration**. The agent drives the tools; blox exposes them and
guides their use. Three changes:

1. **Bridge** — add `wait_job_finished` + `search_creator_store` to the real
   `TOOLS` list in `src/bridge/mcpBridge.ts` (16→18) and to `allowedTools()`; add
   matching mock fakes in `src/bridge/mockBridge.ts`; the existing real==mock
   parity test enforces the set.
2. **System prompt** — `src/agent/systemPrompt.ts`: replace the one-line
   `Assets:` hint with an "Assets (generate & verify)" block (§5).
3. **Gated live test** — `tests/e2e/live-asset.test.ts` (`BLOX_LIVE_ASSET=1`),
   mirroring the live-input/live-capture pattern.

Data flow is unchanged: `buildOptions` exposes the MCP tool set; the agent calls
the tools; `buildSystemPrompt` carries the guidance.

## 4. Tool schemas + mock fakes

The two new tools, mocked to mirror the probed real shapes (mock fakes return
deterministic stand-ins so unit tests need no Studio):

- **`search_creator_store`** — input `{ query: string }`. Mock returns text
  `{"searchId":"mock-search-<n>","objectTypes":["mock-asset"]}`.
- **`wait_job_finished`** — input `{ generationId: string, timeout?: number }`.
  Mock returns a deterministic "job finished" text (e.g.
  `Generation <generationId> finished (mock).`). The real done-result shape is
  un-probed; the live test records it and the mock text is adjusted to a
  plausible match (substring-level, like SP2-b's screen_capture mock).

**Align the `insert_from_creator_store` mock to its real schema.** Its current
mock input is `{ assetId: string }`, but the probed real schema is
`{ searchId: string, objectTypes?: string[], assetName?: string }`. Since SP3
repairs the search→insert chain, update this one mock to `{ searchId }` (plus the
optional fields) so the mocked chain is honest. No behavior coupling is required
(the mock need not validate that `searchId` came from `search_creator_store`).

The `generate_mesh`/`generate_material`/`generate_procedural_model` mocks have a
similar pre-existing schema drift (they take `{ prompt }`; real shapes differ).
Realigning those is **out of scope** here (§6) — this slice touches only the
insert mock plus the two new fakes.

A `mockBridge` helper (in the style of the existing `playResult()` /
`captureResult()`) may back the new fakes if it reduces duplication; not required.

## 5. System-prompt asset block

Replace the current two lines:

```
Assets: when the task needs prototype assets, use generate_mesh,
  generate_material, generate_procedural_model, or insert_from_creator_store.
```

with an "Assets (generate & verify)" block that encodes:

- **Library-first (reuse before generate):** for common props, try
  `search_creator_store(query)` → it returns a `searchId` and `objectTypes`;
  insert with `insert_from_creator_store(searchId, objectTypes?)`. This is instant
  and free — prefer it over generating when a stock asset fits.
- **Generate, async-aware:** `generate_mesh` and `generate_material` **block**
  until done (tens of seconds) and return the inserted asset. `generate_procedural_model`
  is **asynchronous** — it returns a `Generation ID`; you must call
  `wait_job_finished(generationId)` (optionally `timeout`) to finish the job and
  land the model.
- **Verify visually (the loop):** after an asset lands, start play and
  `screen_capture` to see it; judge it against the request; if it is wrong, refine
  the prompt and regenerate. Prefer `execute_luau` to confirm the instance exists
  / is parented correctly (non-visual checks are cheaper than a capture).
- **Style & batch:** when producing a coordinated set, keep one consistent style
  phrase across each prompt; build GUIs by scripting them in `.luau` rather than
  generating images.

Required substrings for the prompt test: `search_creator_store`,
`wait_job_finished`, `Generation ID`, `screen_capture`.

## 6. Out of scope (deferred)

- **`store_image` + image→model** (`attachedImageUri`/`IMAGEID_<id>`): the
  local-image-to-asset chain. Deferred (excluded this slice).
- **Asset cache / manifest:** no blox-side tracking of `generationId`→asset
  results across turns. The agent holds context within a run.
- **Prototype→final quality bar** (master-design open question): no quality-tier
  modeling.
- **`generate_material` deep semantics:** its required `materialId` input is of
  unclear meaning (likely a base MaterialVariant id); expose as-is, do not model.
- **Realigning the `generate_*` mock schemas** to their probed real shapes
  (`generate_mesh` `{textPrompt,...}`, etc.): pre-existing drift, not touched this
  slice (only the `insert_from_creator_store` mock is realigned, §4).
- **Custom asset uploads, asset libraries, multi-provider routing** (nilo-style):
  out of the MCP surface, deferred.

## 7. Testing

Unit (no live Studio):

1. **Tool exposure + parity:** both bridges list all 18 tools including
   `wait_job_finished` and `search_creator_store`; the real==mock parity test
   passes; `allowedTools()` includes the two new `mcp__Roblox_Studio__*` names.
2. **Mock fakes:** `search_creator_store` mock returns a `searchId`/`objectTypes`
   shape; `wait_job_finished` mock returns a finished text.
3. **System prompt:** `buildSystemPrompt` output contains the §5 required
   substrings (`search_creator_store`, `wait_job_finished`, `Generation ID`,
   `screen_capture`).

Gated live (`BLOX_LIVE_ASSET=1`, attached Studio, mirrors live-input/capture):

4. **Creator-store flow:** `search_creator_store(query)` returns a `searchId`;
   `insert_from_creator_store(searchId)` succeeds; assert the asset appears via
   `execute_luau` (e.g. a new child under Workspace).
5. **Procedural async flow:** `generate_procedural_model(prompt)` returns a
   `Generation ID`; extract it; `wait_job_finished(generationId, timeout)`
   completes without error; **record its result shape** and tighten the mock if
   needed. Assert the model lands via `execute_luau`.

Full-suite: `npm test` (unit pass, gated live skip), `npx tsc -p tsconfig.json
--noEmit`, `npm run build` → `dist/cli.js`.

## 8. Success criteria

1. `wait_job_finished` and `search_creator_store` exposed in both bridges with
   parity; `allowedTools()` updated.
2. The two dead chains are repaired: procedural generation can complete
   (gen→wait), and creator-store insert can start (search→insert).
3. `buildSystemPrompt` encodes the library-first + async-poll + visual-iteration
   + style guidance; the §5 substrings are present.
4. All unit tests pass; tsc clean; build produces `dist/cli.js`.
5. The gated live test proves both repaired chains end-to-end against a real
   Studio (the live path is run when a Studio is attached; otherwise it skips).

# blox Pivot P3 — Screenshot→UI Multimodality

**Date:** 2026-06-14
**Status:** Spec

## 1. Context

P1 shipped the Studio dock panel (run status, streamed log, interactive
pre-call gates; `2026-06-11-blox-pivot-p1-studio-dock-panel-design.md`). P2
added asset result gates in the dock
(`2026-06-12-blox-pivot-p2-asset-gate-design.md`). Both are merged and
live-smoke verified (`main` @ `3ca10d5`).

P3 is the pivot roadmap's headline-parity slice: **feed the agent a reference
image and it builds the matching Roblox UI.** The roadmap line:

> Feed an image (CLI arg or dock upload) to the agent; it builds the matching
> Roblox UI. Claude vision + existing pipeline. Parity with Lemonade's
> headline 2026 feature. Independent of P1/P2.

"Independent of P1/P2" means the **CLI-arg path must work with no dock and no
gates**. The dock-upload path layers on P1's transport but is never required.

The existing run pipeline already does the hard part: the agent writes `.luau`
on disk, Rojo one-way syncs into Studio, and the agent verifies in Studio. P3
adds three things on top: (a) an image gets into the first user message, (b) a
screenshot→UI system-prompt addendum guides the visual→Roblox-UI translation,
and (c) an optional `--verify` capture-compare loop.

## 2. Decisions (locked)

| Question | Decision |
|---|---|
| Input surface | **CLI arg + dock upload.** `blox --image <path> "<prompt>"` reads from disk; `blox --image-from-dock "<prompt>"` collects the image from inside Studio via the panel. |
| Build approach | **Prompt addendum.** When an image is present, append a screenshot→UI section to the system prompt; the agent freehand-writes a ScreenGui tree in `.luau`. No structured layout-spec intermediate (rejected: brittle for arbitrary UIs, large new surface), no unguided generic path (rejected: inconsistent UDim2/anchoring idioms). |
| Verify loop | **One-shot default + `--verify` flag.** Default: read image once, write UI, sync, done. `--verify`: agent captures the rendered UI (SP2-b `screen_capture`) and self-compares to the reference, iterating to maxTurns. |
| Image transport to model | **Streaming input.** Swap the bare-string `prompt` for a one-message `AsyncIterable<SDKUserMessage>` whose content is `[text(prompt), image(base64)]`. No-image runs keep the string path unchanged (zero regression). |
| Reference images | **Single image, v1.** Multiple/reference-set deferred. |

## 3. Architecture & data flow

Two input paths converge on one injection point. Each produces a normalized
`ImageInput = { mediaType: 'image/png' | 'image/jpeg', base64: string }`.

```
CLI arg:        --image <path>  → loadImageFromFile() → ImageInput ─┐
                                                                    ├─→ runAgent(image)
Dock upload:    --image-from-dock → PanelServer.awaitImage()        │      │
                  ↑ plugin: PromptImportFile → POST /api/v1/image ──┘      │
                                                                          ▼
                                          query({ prompt: asyncIterable[ text + image ] })
                                                                          │
                                          systemPrompt + screenshot→UI addendum (image present)
```

When `image` is present, `runAgent` yields a single `SDKUserMessage` with
content `[ {type:'text', text: prompt}, {type:'image', source:{type:'base64',
media_type, data}} ]` instead of passing `prompt` as a string. Everything
downstream (hooks, gates, sync, report) is unchanged.

### Dock-upload sequencing

The panel server is created per run. For `--image-from-dock`:

1. CLI starts the panel server (as today), then **before** building the query,
   emits an `image_request` event and calls `awaitImage()` (a promise resolved
   by the image endpoint, modeled on the gate-broker pattern).
2. The plugin renders a "Pick image" affordance on the `image_request` event;
   the user clicks → `StudioService:PromptImportFile({"png","jpg","jpeg"})` →
   `File:GetBinaryContents()` → base64 → `POST /api/v1/image`.
3. `awaitImage()` resolves with the `ImageInput`; the run proceeds.
4. Timeout (default 120 s, reuse the gate timeout knob) → abort the run with a
   clear "no image provided" error before any model call.

The CLI-arg path never touches the panel server, preserving P1 independence.

## 4. Components

| File | Change |
|---|---|
| `src/agent/imageInput.ts` | **new.** `loadImageFromFile(path): ImageInput` — validate extension (png/jpg/jpeg) and size (≤5 MB), read bytes, base64-encode, map media type. Pure, throws typed errors. Exports the `ImageInput` type. |
| `src/agent/runAgent.ts` | accept optional `image?: ImageInput`; when present, build the one-message async-iterable prompt with the image content block; else keep the string path. |
| `src/agent/systemPrompt.ts` | `buildSystemPrompt(digest, opts?)` — `opts` carries `image?` and `verify?`. Append the screenshot→UI addendum when `opts.image` is set. Addendum: author a ScreenGui tree; use UDim2 **scale** + AnchorPoint for responsiveness; match layout, hierarchy, colors, text, and spacing to the reference; build GUIs in `.luau` (never generate images for UI); keep instances in source files (Rojo truth). The verify sub-section (start play, `screen_capture` the UI, compare to the reference held in context, refine `.luau`, repeat to the turn/budget cap) is included only when `opts.verify` is also set. |
| `src/args.ts` | add `--image <path>`, `--image-from-dock`, `--verify`. Validation: `--image` requires a path; `--image` and `--image-from-dock` are mutually exclusive. |
| `src/config.ts` | thread `imagePath`, `imageFromDock`, `verify` through resolved config. |
| `src/cli.ts` | wire the two image paths: disk load vs `awaitImage()`; pass `image` + `verify` into the run; fail fast on load/validation errors before the model call. |
| `src/panel/server.ts` | add `POST /api/v1/image` (body `{ mediaType, base64 }`, validated) + `awaitImage(): Promise<ImageInput>` + `requestImage()` (emit `image_request`). Reuse the timeout pattern. |
| `src/panel/events.ts` | new `image_request` event type (protocol bump). |
| `plugin/src/*` | render a "Pick image" button on `image_request`; `PromptImportFile` → base64 → `POST /api/v1/image`. Show a "sent" state. |

## 5. Validation & errors

- **Extensions:** png, jpg, jpeg only (what Studio's `PromptImportFile`
  supports). Anything else → typed error, fail before the run.
- **Size:** cap ≤5 MB to bound token cost; over → typed error.
- **Missing/unreadable file** (`--image`) → fail fast, no panel server, no
  model call.
- **Dock timeout** (`--image-from-dock`) → abort run, clear message.
- **Malformed POST body** → 400, run keeps awaiting (idempotent retry).

## 6. Testing

**Unit**
- `imageInput`: valid png → correct media type + base64; valid jpg; bad
  extension rejects; oversize rejects; missing file rejects.
- `runAgent`: with `image`, the yielded prompt is an async iterable whose one
  message content is `[text, image]` with the right base64/media type; without
  `image`, the prompt is the unchanged string.
- `systemPrompt`: addendum present iff `opts.image`; absent on plain runs.
- `panel/server`: `POST /api/v1/image` resolves `awaitImage()` with the
  payload; bad body → 400; `requestImage()` emits `image_request`; timeout
  rejects.
- `args`: `--image`/`--image-from-dock`/`--verify` parse; mutual-exclusion and
  missing-path errors.

**Live (gated, `BLOX_LIVE=1`)**
- Real `blox --image <fixture.png> "build this UI"` produces a ScreenGui in the
  project that Rojo syncs; assert the expected instances exist.
- `--verify` path exercises one capture-compare iteration.
- Dock-upload path is manual live-smoke (PromptImportFile is interactive):
  document the steps; not in the automated gate.

## 7. Out of scope (YAGNI)

- Structured image→layout-spec intermediate and deterministic renderer.
- Multiple / reference-set images.
- Auto asset generation from the image (icons, textures, meshes) — a separate
  slice; P3 builds UI instances only.
- Mid-run image swapping or re-upload.
- Pixel-diff scoring for `--verify` (the agent judges visually, as elsewhere in
  blox).

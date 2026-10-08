# `blox image` (Qwen-Image-2.1 on Kaggle, Flux fallback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `image setup` once, then `image generate {items}` → transparent, trimmed, square PNG icons in `assets/icons/`, each recorded in `.blox/assets.json` with model, backend, prompt, seed and licence.

**Architecture:** Backends share `generate(items, opts) → {name, seed, png|jpeg Buffer}[]`. `kaggle-qwen` writes a private script kernel (`<user>/blox-image-<stamp>`) whose Python embeds the items, reuses the tamadaresearch runtime's `setup`/`verify_weights`/`link_weights`, and runs a driver under ComfyUI's venv that loads the text encoder, int8 denoiser and VAE **once**, then loops prompts × seeds and saves PNGs (RGBA when the VAE returns 4 channels). Weights come from a one-time CPU kernel `<user>/blox-qwen21-weights` that downloads the three pinned Comfy-Org files into its output; batches attach it via `kernel_sources`. blox polls `kaggle kernels status`, then `kaggle kernels output`. `cloudflare-flux` calls Workers AI with the wrangler OAuth token. Post-processing (alpha keep, else border flood-fill of near-white; trim; pad square; box-resize) runs locally.

**Tech Stack:** TypeScript, `~/.local/bin/kaggle` 2.2.4 (spawned), fetch, jpeg-js, existing PNG codec (`present/pixels.ts`, `present/square.ts`).

**Spec:** `docs/superpowers/specs/2026-10-07-ui-map-refine-design.md` §4

## Global Constraints

- Default backend `kaggle-qwen`; fallback to `cloudflare-flux` only when asked or on Kaggle quota/auth/timeout, and the result says which ran.
- Never print the wrangler token or the Kaggle token. Kernels are private.
- Licences: `qwen-research` (Qwen Research License, non-commercial) and `apache-2.0` (FLUX.1-schnell). `release check` fails `licence` when `blox.config.json` has `"monetized": true` and an in-use asset is `qwen-research`.
- Kaggle CLI: `~/.local/bin/kaggle` first (`BLOX_KAGGLE` overrides); the miniforge one is too old.
- Batch many icons per kernel (weekly GPU quota). Default size 512, seeds 1 per item.

## Review Focus

- Kaggle kernel finishes with some items failed → the others are still written; failures listed with their error.
- Kernel status `error` → fetch the log and show its tail, not just "failed".
- Same `name` twice in items, or a name that is not a file-safe id → reject before pushing.
- Icon already exists in `assets/icons` → refuse unless `overwrite: true` (no silent loss of an approved icon).
- A white object on a white background (A's TRAPS #15) → flood fill from the border only, so inner whites survive.

---

### Task 1: post-processing (`src/image/post.ts`)
- [ ] Failing tests: an RGBA PNG keeps its alpha; an RGB image with a white border and a red disc gets alpha 0 on the border-connected white and keeps a white dot *inside* the disc; trim then square-pad then resize gives exactly `size`×`size`; JPEG input works.
- [ ] Implement `cutout(buf, {size, tolerance=24}) → PNG Buffer`. Pass; commit.

### Task 2: Kaggle backend (`src/image/kaggle.ts`, `src/image/kaggleScripts.ts`)
- [ ] Failing tests: `batchKernel({user:'u', items, size:512, steps:40})` → metadata (private, GPU, internet, `dataset_sources: ['tamadaresearch/qwen-image21-t4-runtime']`, `kernel_sources: ['u/blox-qwen21-weights']`, T4 machine shape) and a script embedding items as JSON; `runKaggleBatch` with a fake CLI runner pushes, polls `running`→`complete`, downloads output, reads `results.json` + PNGs; status `error` surfaces the log tail; `QuotaExceeded`-like push errors throw `KaggleUnavailable` (the fallback trigger). `weightsKernel(user)` is CPU-only. Validation of names.
- [ ] Implement; pass; commit.

### Task 3: Cloudflare backend (`src/image/cloudflare.ts`)
- [ ] Failing tests with injected fetch + token reader: account id lookup, `@cf/black-forest-labs/flux-1-schnell` call per item with `{prompt, seed, steps: 8}`, base64 image decoded; token never in thrown messages.
- [ ] Implement; pass; commit.

### Task 4: generate + tool + manifest + release gate
- [ ] Failing tests: `generateImages(P, {items, style:'icon'}, {backend: fake})` writes `assets/icons/<name>.png`, adds manifest entries (`source: generated`, licence by backend, provenance `{tool:'blox image', model, backend, prompt, seed}`), refuses existing files without `overwrite`, falls back on `KaggleUnavailable` with a note; style presets prepend text; release `licence` gate.
- [ ] Register `image` tool (`setup | generate | status`) + CLI (`blox image generate --items @file.json [--style icon] [--size 512] [--backend kaggle-qwen|cloudflare-flux]`). tsc + full suite.
- [ ] Live: `image setup` (weights kernel complete), then a 4-icon Qwen batch; look at the icons; commit; PR; merge.

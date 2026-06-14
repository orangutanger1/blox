# blox Pivot P3 — Screenshot→UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed a reference image to a blox run (CLI `--image` or a Studio dock upload) and have the agent build the matching Roblox UI, with an optional `--verify` capture-compare loop.

**Architecture:** Both input paths normalize to one `ImageInput = { mediaType, base64 }`. When present, `runAgent` sends a streaming `SDKUserMessage` whose content is `[text(prompt), image(base64)]` instead of a bare string, and the system prompt gains a screenshot→UI addendum. The dock path adds a per-run `image_request` event + `POST /api/v1/image` endpoint on the existing panel server; the plugin uploads raw bytes (server base64-encodes — no Luau base64 needed). The CLI-arg path never touches the panel, preserving P1 independence.

**Tech Stack:** TypeScript (Node ESM), `@anthropic-ai/claude-agent-sdk`, vitest, Luau (Studio plugin).

**Spec:** `docs/superpowers/specs/2026-06-14-blox-pivot-p3-screenshot-to-ui-design.md`

**Note on a spec refinement:** the spec sketched the dock upload as a JSON `{ mediaType, base64 }` body. This plan uploads **raw image bytes with the media type in the `Content-Type` header** and base64-encodes server-side. This avoids implementing base64 in Luau (which has no builtin) and is strictly simpler. Same `ImageInput` reaches the agent either way.

---

## File Structure

| File | Responsibility | New? |
|---|---|---|
| `src/agent/imageInput.ts` | Normalize an image to `ImageInput` from a file path (CLI) or raw bytes + content-type (dock). Validation lives here. | new |
| `src/agent/runAgent.ts` | `buildPromptInput()` — string when no image, streaming `SDKUserMessage` with an image block when present. `runAgent` accepts `extras.image`. | modify |
| `src/agent/systemPrompt.ts` | Append the screenshot→UI addendum (and the verify sub-section) when an image is present. | modify |
| `src/agent/buildOptions.ts` | Thread `{ image, verify }` into `buildSystemPrompt`. | modify |
| `src/args.ts` | Parse `--image <path>`, `--image-from-dock`, `--verify`; enforce mutual exclusion. | modify |
| `src/panel/events.ts` | `image_request` event; bump `PROTOCOL_VERSION` to 3. | modify |
| `src/panel/server.ts` | `requestImage()` + `POST /api/v1/image`; clear the pending image on stop. | modify |
| `src/cli.ts` | Load disk image (fail-fast) or await a dock upload; pass `image`/`verify` downstream. | modify |
| `plugin/src/Ui.luau` | "Pick image" gate card (button + status). | modify |
| `plugin/src/init.server.luau` | Handle `image_request`; `PromptImportFile` → upload raw bytes; `PROTOCOL = 3`. | modify |

---

## Task 1: CLI flags — `--image`, `--image-from-dock`, `--verify`

**Files:**
- Modify: `src/args.ts`
- Test: `tests/args.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/args.test.ts`:

```ts
describe('image flags', () => {
  it('parses --image with a path', () => {
    const a = parseArgs(['--image', 'ref.png', 'build', 'this']);
    expect(a.imagePath).toBe('ref.png');
    expect(a.imageFromDock).toBe(false);
    expect(a.prompt).toBe('build this');
  });

  it('parses --image-from-dock and --verify', () => {
    const a = parseArgs(['--image-from-dock', '--verify', 'build it']);
    expect(a.imageFromDock).toBe(true);
    expect(a.verify).toBe(true);
    expect(a.imagePath).toBeNull();
  });

  it('defaults image flags off', () => {
    const a = parseArgs(['hi']);
    expect(a.imagePath).toBeNull();
    expect(a.imageFromDock).toBe(false);
    expect(a.verify).toBe(false);
  });

  it('rejects --image together with --image-from-dock', () => {
    expect(() => parseArgs(['--image', 'r.png', '--image-from-dock', 'x'])).toThrow(
      /--image and --image-from-dock are mutually exclusive/,
    );
  });

  it('rejects --image with no path', () => {
    expect(() => parseArgs(['--image'])).toThrow(/--image needs a file path/);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run tests/args.test.ts`
Expected: FAIL — `a.imagePath` is undefined / no such property.

- [ ] **Step 3: Implement the flag parsing**

In `src/args.ts`, extend the `ParsedArgs` interface (after `force: boolean;`):

```ts
  imagePath: string | null;
  imageFromDock: boolean;
  verify: boolean;
```

Add locals near the other `let` declarations:

```ts
  let imagePath: string | null = null;
  let imageFromDock = false;
  let verify = false;
```

Add branches in the arg loop, before the final `else positional.push(a);`:

```ts
    else if (a === '--image') {
      const v = argv[++i];
      if (v == null) throw new Error('--image needs a file path');
      imagePath = v;
    } else if (a === '--image-from-dock') imageFromDock = true;
    else if (a === '--verify') verify = true;
```

Add the mutual-exclusion check immediately before the `return {`:

```ts
  if (imagePath !== null && imageFromDock) {
    throw new Error('--image and --image-from-dock are mutually exclusive');
  }
```

Add the three fields to the returned object (after `force,`):

```ts
    imagePath,
    imageFromDock,
    verify,
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run tests/args.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/args.ts tests/args.test.ts
git commit -m "feat(p3): --image, --image-from-dock, --verify flags"
```

---

## Task 2: `imageInput` module — load + validate

**Files:**
- Create: `src/agent/imageInput.ts`
- Test: `tests/imageInput.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/imageInput.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadImageFromFile, imageFromBytes, MAX_IMAGE_BYTES } from '../src/agent/imageInput.js';

// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const tmp: string[] = [];
function fixture(name: string, bytes: Buffer): string {
  const p = join(tmpdir(), `blox-img-${Date.now()}-${name}`);
  writeFileSync(p, bytes);
  tmp.push(p);
  return p;
}
afterEach(() => {
  for (const p of tmp.splice(0)) rmSync(p, { force: true });
});

describe('loadImageFromFile', () => {
  it('reads a png into base64 with the right media type', () => {
    const img = loadImageFromFile(fixture('a.png', PNG_1X1));
    expect(img.mediaType).toBe('image/png');
    expect(img.base64).toBe(PNG_1X1.toString('base64'));
  });

  it('maps .jpg and .jpeg to image/jpeg (extension-based)', () => {
    expect(loadImageFromFile(fixture('a.jpg', Buffer.from([1, 2, 3]))).mediaType).toBe('image/jpeg');
    expect(loadImageFromFile(fixture('a.jpeg', Buffer.from([1, 2, 3]))).mediaType).toBe('image/jpeg');
  });

  it('rejects an unsupported extension', () => {
    expect(() => loadImageFromFile(fixture('a.gif', Buffer.from([1])))).toThrow(/unsupported image type/);
  });

  it('rejects a missing file', () => {
    expect(() => loadImageFromFile(join(tmpdir(), 'does-not-exist.png'))).toThrow(/cannot read image/);
  });

  it('rejects an empty file', () => {
    expect(() => loadImageFromFile(fixture('e.png', Buffer.alloc(0)))).toThrow(/empty/);
  });

  it('rejects an oversize file', () => {
    expect(() => loadImageFromFile(fixture('big.png', Buffer.alloc(MAX_IMAGE_BYTES + 1)))).toThrow(/too large/);
  });
});

describe('imageFromBytes', () => {
  it('builds ImageInput from bytes + content-type', () => {
    const img = imageFromBytes('image/png', Buffer.from([1, 2, 3]));
    expect(img).toEqual({ mediaType: 'image/png', base64: Buffer.from([1, 2, 3]).toString('base64') });
  });

  it('rejects a non-image content-type', () => {
    expect(() => imageFromBytes('text/plain', Buffer.from([1]))).toThrow(/content-type/);
  });

  it('rejects empty and oversize bodies', () => {
    expect(() => imageFromBytes('image/png', Buffer.alloc(0))).toThrow(/empty/);
    expect(() => imageFromBytes('image/png', Buffer.alloc(MAX_IMAGE_BYTES + 1))).toThrow(/too large/);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run tests/imageInput.test.ts`
Expected: FAIL — module `../src/agent/imageInput.js` not found.

- [ ] **Step 3: Implement the module**

Create `src/agent/imageInput.ts`:

```ts
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

export interface ImageInput {
  mediaType: 'image/png' | 'image/jpeg';
  base64: string;
}

// Cap to bound prompt token cost; both input paths enforce it.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXT_MEDIA: Record<string, ImageInput['mediaType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function validate(mediaType: ImageInput['mediaType'] | null, bytes: Buffer, what: string): ImageInput {
  if (!mediaType) throw new Error(`${what}: content-type must be image/png or image/jpeg`);
  if (bytes.length === 0) throw new Error(`${what}: image is empty`);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`${what}: image too large (${(bytes.length / 1024 / 1024).toFixed(1)} MB, max 5 MB)`);
  }
  return { mediaType, base64: bytes.toString('base64') };
}

// CLI --image path: media type comes from the file extension.
export function loadImageFromFile(path: string): ImageInput {
  const mediaType = EXT_MEDIA[extname(path).toLowerCase()] ?? null;
  if (!mediaType) throw new Error(`unsupported image type "${extname(path) || path}" — use .png, .jpg, or .jpeg`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error(`cannot read image: ${path}`);
  }
  return validate(mediaType, bytes, path);
}

// Dock upload path: media type comes from the request Content-Type header.
export function imageFromBytes(contentType: string | undefined, bytes: Buffer): ImageInput {
  const mediaType =
    contentType === 'image/png' || contentType === 'image/jpeg' ? contentType : null;
  return validate(mediaType, bytes, 'upload');
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run tests/imageInput.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/imageInput.ts tests/imageInput.test.ts
git commit -m "feat(p3): imageInput — load+validate from file or raw bytes"
```

---

## Task 3: System-prompt screenshot→UI addendum

**Files:**
- Modify: `src/agent/systemPrompt.ts`
- Test: `tests/systemPrompt.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/systemPrompt.test.ts` (inside the file, new `describe`):

```ts
describe('buildSystemPrompt — screenshot→UI addendum', () => {
  it('omits the addendum on a normal run', () => {
    const p = buildSystemPrompt(digest);
    expect(p).not.toContain('Screenshot → UI');
  });

  it('adds the addendum when an image is present', () => {
    const p = buildSystemPrompt(digest, { image: true });
    expect(p).toContain('Screenshot → UI');
    expect(p).toContain('ScreenGui');
    expect(p).toContain('AnchorPoint');
    expect(p).toContain('UDim2');
    // verify sub-section gated separately
    expect(p).not.toContain('screen_capture the running UI');
  });

  it('adds the verify sub-section only with verify', () => {
    const p = buildSystemPrompt(digest, { image: true, verify: true });
    expect(p).toContain('screen_capture the running UI');
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: FAIL — `buildSystemPrompt` takes one arg / addendum absent.

- [ ] **Step 3: Implement the addendum**

In `src/agent/systemPrompt.ts`, add this interface above `buildSystemPrompt`:

```ts
export interface SystemPromptOpts {
  image?: boolean;
  verify?: boolean;
}
```

Replace the `buildSystemPrompt` signature and its final `return` so the prompt is built as an array, then the addendum is appended conditionally. Change:

```ts
export function buildSystemPrompt(digest: ProjectDigest): string {
  return [
```

to:

```ts
export function buildSystemPrompt(digest: ProjectDigest, opts: SystemPromptOpts = {}): string {
  const lines = [
```

Then change the closing of that array literal from:

```ts
    ...renderGameMap(digest),
  ].join('\n');
}
```

to:

```ts
    ...renderGameMap(digest),
  ];
  if (opts.image) lines.push('', ...screenshotToUiAddendum(opts.verify ?? false));
  return lines.join('\n');
}

function screenshotToUiAddendum(verify: boolean): string[] {
  const lines = [
    'Screenshot → UI (this run):',
    '- A reference image is attached to the first message. Build a Roblox UI that',
    '  matches it as closely as you can.',
    '- Author the UI as a ScreenGui tree in .luau under the project (Rojo truth),',
    '  e.g. under StarterGui. Build instances in code; never generate images to',
    '  fake the UI.',
    '- Use UDim2 *scale* (not only offset) plus AnchorPoint so the layout is',
    '  responsive. Reproduce hierarchy, relative position/size, colors, text,',
    '  fonts, and spacing from the reference.',
    '- Recreate the structure: frames/containers, labels, buttons, images, lists.',
    '  Give instances meaningful names.',
  ];
  if (verify) {
    lines.push(
      '- Verify visually: start play, screen_capture the running UI, and compare it',
      '  to the reference image. If it differs, refine the .luau and repeat until it',
      '  matches or you near the turn/budget cap. Stop play when done.',
    );
  }
  return lines;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: PASS (existing tests still green — they call `buildSystemPrompt(digest)` with the new default `opts`).

- [ ] **Step 5: Commit**

```bash
git add src/agent/systemPrompt.ts tests/systemPrompt.test.ts
git commit -m "feat(p3): screenshot→UI system-prompt addendum"
```

---

## Task 4: `runAgent` — image content block

**Files:**
- Modify: `src/agent/runAgent.ts`
- Test: `tests/runAgent.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/runAgent.test.ts`:

```ts
import { buildPromptInput } from '../src/agent/runAgent.js';

describe('buildPromptInput', () => {
  it('returns the bare string when there is no image', () => {
    expect(buildPromptInput('do a thing')).toBe('do a thing');
  });

  it('returns a one-message stream with [text, image] when an image is present', async () => {
    const input = buildPromptInput('match this UI', { mediaType: 'image/png', base64: 'QUJD' });
    expect(typeof input).not.toBe('string');
    const msgs = [];
    for await (const m of input as AsyncIterable<unknown>) msgs.push(m);
    expect(msgs).toHaveLength(1);
    const m = msgs[0] as { type: string; message: { role: string; content: unknown[] } };
    expect(m.type).toBe('user');
    expect(m.message.role).toBe('user');
    expect(m.message.content).toEqual([
      { type: 'text', text: 'match this UI' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run tests/runAgent.test.ts`
Expected: FAIL — `buildPromptInput` not exported.

- [ ] **Step 3: Implement**

In `src/agent/runAgent.ts`, add imports at the top:

```ts
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageInput } from './imageInput.js';
```

Add the exported helper (above `runAgent`):

```ts
// The SDK accepts either a string prompt or a stream of user messages. With an
// image we send one user message carrying [text, image] content blocks; without
// one we keep the plain string path (zero change for normal runs).
export function buildPromptInput(
  prompt: string,
  image?: ImageInput,
): string | AsyncIterable<SDKUserMessage> {
  if (!image) return prompt;
  const message = {
    type: 'user' as const,
    parent_tool_use_id: null,
    message: {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: prompt },
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mediaType, data: image.base64 },
        },
      ],
    },
  };
  return (async function* () {
    yield message as SDKUserMessage;
  })();
}
```

Add `image` to `RunAgentExtras`:

```ts
export interface RunAgentExtras {
  sink?: EventSink;
  dockDeniedTools?: () => string[];
  image?: ImageInput;
}
```

In `runAgent`, change the query call from:

```ts
  for await (const message of query({ prompt, options: options as never })) {
```

to:

```ts
  const input = buildPromptInput(prompt, extras.image);
  for await (const message of query({ prompt: input, options: options as never })) {
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run tests/runAgent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/runAgent.ts tests/runAgent.test.ts
git commit -m "feat(p3): runAgent sends an image content block when present"
```

---

## Task 5: Thread image/verify into `buildQueryOptions`

**Files:**
- Modify: `src/agent/buildOptions.ts`
- Test: `tests/buildOptions.test.ts`

- [ ] **Step 1: Read the existing test to match its setup**

Run: `sed -n '1,40p' tests/buildOptions.test.ts` (note how it constructs `config`, `bridge`, `digest`).

- [ ] **Step 2: Write the failing test**

Append to `tests/buildOptions.test.ts` a test that builds options with the prompt context and asserts the system prompt carries the addendum. Use the same `config`/`bridge`/`digest` fixtures already defined at the top of that file:

```ts
describe('buildQueryOptions — screenshot→UI context', () => {
  it('includes the addendum in the system prompt when image context is set', () => {
    const opts = buildQueryOptions(config, bridge, digest, undefined, { image: true, verify: true });
    expect(opts.systemPrompt).toContain('Screenshot → UI');
    expect(opts.systemPrompt).toContain('screen_capture the running UI');
  });

  it('omits the addendum with no prompt context', () => {
    const opts = buildQueryOptions(config, bridge, digest);
    expect(opts.systemPrompt).not.toContain('Screenshot → UI');
  });
});
```

If `config`/`bridge`/`digest` are named differently in that file, reuse whatever the existing tests use.

- [ ] **Step 3: Run the test, verify it fails**

Run: `npx vitest run tests/buildOptions.test.ts`
Expected: FAIL — 5th arg not accepted / addendum absent.

- [ ] **Step 4: Implement**

In `src/agent/buildOptions.ts`, add an interface near the top (after the existing `PanelGateChannel` type):

```ts
// Run-level context that shapes the system prompt (P3). Not persisted config.
export interface PromptContext {
  image?: boolean;
  verify?: boolean;
}
```

Change the `buildQueryOptions` signature from:

```ts
export function buildQueryOptions(
  config: BloxConfig,
  bridge: StudioBridge,
  digest: ProjectDigest,
  gate?: PanelGateChannel,
): QueryOptionsLike {
```

to:

```ts
export function buildQueryOptions(
  config: BloxConfig,
  bridge: StudioBridge,
  digest: ProjectDigest,
  gate?: PanelGateChannel,
  promptCtx: PromptContext = {},
): QueryOptionsLike {
```

Change the `systemPrompt` line from:

```ts
    systemPrompt: buildSystemPrompt(digest),
```

to:

```ts
    systemPrompt: buildSystemPrompt(digest, { image: promptCtx.image, verify: promptCtx.verify }),
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npx vitest run tests/buildOptions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/buildOptions.ts tests/buildOptions.test.ts
git commit -m "feat(p3): thread image/verify context into the system prompt"
```

---

## Task 6: Panel server — `image_request` event + `POST /api/v1/image`

**Files:**
- Modify: `src/panel/events.ts`, `src/panel/server.ts`
- Test: `tests/panel.server.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/panel.server.test.ts` (new `describe` at the end of the file):

```ts
describe('PanelServer — image upload', () => {
  it('emits image_request and resolves requestImage() from a POST /image', async () => {
    const { s, base } = await start();
    const pending = s.requestImage();
    const events = (await (await fetch(`${base}/events?cursor=0`)).json()).events;
    expect(events.some((e: { type: string }) => e.type === 'image_request')).toBe(true);
    const res = await fetch(`${base}/image`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from([1, 2, 3]),
    });
    expect(res.status).toBe(200);
    expect(await pending).toEqual({ mediaType: 'image/png', base64: Buffer.from([1, 2, 3]).toString('base64') });
  });

  it('409s when no image request is pending', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/image`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from([1]),
    });
    expect(res.status).toBe(409);
  });

  it('400s a non-image content-type, leaving the request open', async () => {
    const { s, base } = await start();
    const pending = s.requestImage();
    const bad = await fetch(`${base}/image`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from([1]),
    });
    expect(bad.status).toBe(400);
    // still open — a good upload then settles it
    await fetch(`${base}/image`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.from([9]),
    });
    expect((await pending).mediaType).toBe('image/jpeg');
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run tests/panel.server.test.ts`
Expected: FAIL — `s.requestImage` is not a function / `/image` 404s.

- [ ] **Step 3: Bump the protocol + add the event**

In `src/panel/events.ts`:

```ts
export const PROTOCOL_VERSION = 3;
```

Add a variant to the `PanelEvent` union (after the `result_gate_resolved` line):

```ts
  | { type: 'image_request' }
```

- [ ] **Step 4: Implement the server endpoint**

In `src/panel/server.ts`, add imports at the top:

```ts
import { imageFromBytes, type ImageInput } from '../agent/imageInput.js';
```

Add a private field to `PanelServer` (next to `private lastPollAt = 0;`):

```ts
  private pendingImage: { resolve: (i: ImageInput) => void; timer: ReturnType<typeof setTimeout> } | null = null;
```

Add a method (place it near `isConnected()`):

```ts
  // Park until the dock uploads an image (POST /api/v1/image) or the timeout
  // fires. One image per run. Reuses the gate timeout knob.
  requestImage(): Promise<ImageInput> {
    this.emit({ type: 'image_request' });
    return new Promise<ImageInput>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingImage = null;
        reject(new Error('no image uploaded from the dock within the timeout'));
      }, this.opts.gateTimeoutMs);
      this.pendingImage = { resolve, timer };
    });
  }
```

In `route()`, add this block before the `gateMatch` block:

```ts
      if (req.method === 'POST' && url.pathname === '/api/v1/image') {
        if (!this.pendingImage) return json(res, 409, { error: 'no image request pending' });
        const bytes = await readBytes(req);
        let image: ImageInput;
        try {
          image = imageFromBytes(req.headers['content-type'], bytes);
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
        const p = this.pendingImage;
        this.pendingImage = null;
        clearTimeout(p.timer);
        p.resolve(image);
        return json(res, 200, { ok: true });
      }
```

In `stop()`, clear a dangling pending image (before `if (!server) return ...`). Insert at the start of `stop()`:

```ts
    if (this.pendingImage) {
      clearTimeout(this.pendingImage.timer);
      this.pendingImage = null;
    }
```

Add a `readBytes` helper next to `readJson` at the bottom of the file:

```ts
async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `npx vitest run tests/panel.server.test.ts`
Expected: PASS. The `/info` test still asserts `PROTOCOL_VERSION` (now 3) via the constant — green.

- [ ] **Step 6: Commit**

```bash
git add src/panel/events.ts src/panel/server.ts tests/panel.server.test.ts
git commit -m "feat(p3): panel image upload endpoint + image_request event (protocol 3)"
```

---

## Task 7: CLI wiring — load disk image / await dock upload

**Files:**
- Modify: `src/cli.ts`

(No unit test — `cli.ts` has none today; covered by the unit tests above and the live smoke in Task 9. Type-check via build in Task 8/9.)

- [ ] **Step 1: Add imports**

In `src/cli.ts`, add near the other agent imports:

```ts
import { loadImageFromFile, type ImageInput } from './agent/imageInput.js';
```

- [ ] **Step 2: Load a disk image fail-fast**

After `const { command, prompt, mock, projectPath } = args;` add nothing there; instead, after the early `if (!prompt) { ... }` guard and after `const cwd = ...; const config = ...; const digest = ...; const bridge = ...;` block (right before the `const runId = randomUUID();` line), insert:

```ts
  // --image: read from disk now so a bad path fails before any model call.
  let image: ImageInput | undefined;
  if (args.imagePath) {
    try {
      image = loadImageFromFile(args.imagePath);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
  }
```

- [ ] **Step 3: Await a dock upload after the panel starts**

After the panel-start block (the `if (!mock) { try { const p = new PanelServer(...) ... } }` that assigns `panel`), and before `const gate = panel ? ... : undefined;`, insert:

```ts
  // --image-from-dock: ask the connected dock to upload a reference image.
  if (args.imageFromDock) {
    if (!panel) {
      console.error('--image-from-dock needs the panel server (unavailable in --mock or after a panel start failure)');
      process.exit(2);
    }
    console.log('waiting for a reference image — click "Pick image" in the blox Studio panel…');
    try {
      image = await panel.requestImage();
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
  }
```

- [ ] **Step 4: Pass the prompt context + image downstream**

Change:

```ts
  const options = buildQueryOptions(config, bridge, digest, gate);
```

to:

```ts
  const options = buildQueryOptions(config, bridge, digest, gate, {
    image: !!image,
    verify: args.verify,
  });
```

Change the `runAgent` call from:

```ts
    const agent = await runAgent(prompt, options, {
      sink: panel ?? undefined,
      dockDeniedTools: panel ? () => panel!.gates.dockDeniedTools() : undefined,
    });
```

to:

```ts
    const agent = await runAgent(prompt, options, {
      sink: panel ?? undefined,
      dockDeniedTools: panel ? () => panel!.gates.dockDeniedTools() : undefined,
      image,
    });
```

- [ ] **Step 5: Update the usage string**

In the `if (!prompt)` block, change the usage line to include the new flags. Replace the existing `console.error('usage: blox "<prompt>" ...')` argument with:

```ts
      'usage: blox "<prompt>" [--mock] [--project <dir>] [--auto|--ask] [--max-turns <N>] [--budget <USD>] [--effort high|xhigh] [--image <path>|--image-from-dock] [--verify]  |  blox doctor  |  blox init [--on-conflict abort|suffix] [--force]  |  blox panel install',
```

- [ ] **Step 6: Build to type-check**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts
git commit -m "feat(p3): wire --image / --image-from-dock / --verify into the run"
```

---

## Task 8: Studio plugin — "Pick image" upload

**Files:**
- Modify: `plugin/src/Ui.luau`, `plugin/src/init.server.luau`

(Luau has no unit harness here; verified in the live smoke, Task 9.)

- [ ] **Step 1: Add the image gate card to the UI**

In `plugin/src/Ui.luau`, insert the image gate frame right after the `status` label block (after line `status.TextColor3 = Color3.fromRGB(255, 170, 0)`), before the `-- Gate card` comment:

```lua
	-- Image request card: hidden until an image_request arrives (P3).
	local imageGate = Instance.new("Frame")
	imageGate.Name = "ImageGate"
	imageGate.LayoutOrder = 2
	imageGate.Size = UDim2.new(1, -8, 0, 56)
	imageGate.BackgroundColor3 = Color3.fromRGB(30, 40, 60)
	imageGate.Visible = false
	imageGate.Parent = root

	local imageStatus = label(imageGate, "ImageStatus", 1)
	imageStatus.Position = UDim2.fromOffset(4, 4)
	imageStatus.Size = UDim2.new(1, -8, 0, 18)
	imageStatus.Text = "blox wants a reference image"

	local imageButton = Instance.new("TextButton")
	imageButton.Name = "PickImage"
	imageButton.Text = "Pick image"
	imageButton.Position = UDim2.new(0, 4, 1, -28)
	imageButton.Size = UDim2.fromOffset(120, 24)
	imageButton.BackgroundColor3 = Color3.fromRGB(40, 90, 140)
	imageButton.TextColor3 = Color3.fromRGB(255, 255, 255)
	imageButton.Parent = imageGate
```

Renumber the existing `LayoutOrder` values so the new card slots in cleanly. Change:
- `gate.LayoutOrder = 2` → `gate.LayoutOrder = 3`
- `result.LayoutOrder = 3` → `result.LayoutOrder = 4`
- `local diffs = scroller("Diffs", 4, 0.25)` → `scroller("Diffs", 5, 0.25)`
- `local log = scroller("Log", 5, 0.6)` → `scroller("Log", 6, 0.6)`

Add the new refs to the returned table (after `status = status,`):

```lua
		imageGate = imageGate,
		imageStatus = imageStatus,
		imageButton = imageButton,
```

- [ ] **Step 2: Bump protocol + wire the upload in init.server.luau**

In `plugin/src/init.server.luau`:

Change `local PROTOCOL = 2` → `local PROTOCOL = 3`.

Add `StudioService` to the services block at the top:

```lua
local StudioService = game:GetService("StudioService")
```

Add a raw-bytes POST helper and a media-type mapper after the existing `request` function:

```lua
-- Image upload sends raw bytes with the media type in the Content-Type header;
-- the CLI base64-encodes server-side (Luau has no base64 builtin).
local function postBytes(path: string, contentType: string, body: string): boolean
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = BASE .. path,
			Method = "POST",
			Headers = { ["Content-Type"] = contentType },
			Body = body,
		})
	end)
	return ok and res ~= nil and res.Success == true
end

local function mediaForName(name: string): string?
	local lower = string.lower(name)
	if string.match(lower, "%.png$") then
		return "image/png"
	elseif string.match(lower, "%.jpe?g$") then
		return "image/jpeg"
	end
	return nil
end
```

Handle the `image_request` event — add a branch in `handleEvent`, before the `elseif e.type == "run_finished"` branch:

```lua
	elseif e.type == "image_request" then
		ui.imageStatus.Text = "blox wants a reference image"
		ui.imageGate.Visible = true
```

Wire the button — add after the result-button connections (after the `ui.rejectButton.MouseButton1Click:Connect(...)` block):

```lua
	ui.imageButton.MouseButton1Click:Connect(function()
		local file = StudioService:PromptImportFile({ "png", "jpg", "jpeg" })
		if not file then
			return
		end
		local media = mediaForName(file.Name)
		if not media then
			ui.imageStatus.Text = "unsupported file type"
			return
		end
		ui.imageStatus.Text = "sending " .. file.Name .. "…"
		local bytes = file:GetBinaryContents()
		if postBytes("/image", media, bytes) then
			ui.imageStatus.Text = "sent: " .. file.Name
			ui.imageGate.Visible = false
		else
			ui.imageStatus.Text = "send failed — is blox running?"
		end
	end)
```

- [ ] **Step 3: Reinstall the plugin to verify it loads (optional local check)**

Run: `node dist/cli.js panel install` (after `npm run build`), or note it for the live smoke.
Expected: "blox panel installed → …". (Manual: open Studio, confirm no script errors in the Output window.)

- [ ] **Step 4: Commit**

```bash
git add plugin/src/Ui.luau plugin/src/init.server.luau
git commit -m "feat(p3): dock 'Pick image' upload (PromptImportFile → POST /image)"
```

---

## Task 9: Full suite, build, and gated live smoke

**Files:**
- Create: `tests/e2e/live-shot.test.ts`

- [ ] **Step 1: Run the whole unit suite + build**

Run: `npm test && npm run build`
Expected: all tests pass; build clean. (Confirms no regressions across args/systemPrompt/runAgent/buildOptions/panel.)

- [ ] **Step 2: Write a gated live smoke test**

Create `tests/e2e/live-shot.test.ts` (self-skips unless `BLOX_LIVE_SHOT=1`; needs Studio open + rojo connected):

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const enabled = process.env.BLOX_LIVE_SHOT === '1';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// Live: blox --image builds a UI in the real project. Asserts the run exits 0;
// the agent's exact output is non-deterministic, so we check completion only.
describe.skipIf(!enabled)('blox --image screenshot→UI (live)', () => {
  it('completes a run with an image attached', () => {
    const img = join(tmpdir(), 'blox-live-shot.png');
    writeFileSync(img, PNG_1X1);
    try {
      const out = execFileSync(
        'node',
        ['dist/cli.js', '--image', img, '--auto', '--max-turns', '6', 'Build a simple ScreenGui that matches this image'],
        { encoding: 'utf8', timeout: 300_000 },
      );
      expect(out).toMatch(/status:\s*success|turns/i);
    } finally {
      if (existsSync(img)) rmSync(img, { force: true });
    }
  });
});
```

- [ ] **Step 3: Run the gated test in skip mode (CI-safe)**

Run: `npx vitest run tests/e2e/live-shot.test.ts`
Expected: test is skipped (0 failures) because `BLOX_LIVE_SHOT` is unset.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/live-shot.test.ts
git commit -m "test(p3): gated live screenshot→UI smoke"
```

- [ ] **Step 5: Manual live smoke (do when Studio is available — not blocking)**

Documented checklist (run by hand; commit message above already landed the harness):
1. `npm run build && node dist/cli.js panel install`, open Studio, enable the blox panel, ensure rojo connected.
2. **CLI path:** `node dist/cli.js --image <some-ui.png> --auto --max-turns 8 "build this UI"` → confirm a ScreenGui appears under StarterGui in the synced files and Studio.
3. **Dock path:** `node dist/cli.js --image-from-dock --auto "build the UI I upload"` → the panel shows "Pick image"; pick a PNG; confirm the run proceeds and builds UI.
4. **Verify path:** add `--verify` to a CLI run → confirm the agent starts play and screen_captures during the run.

---

## Self-Review Notes

- **Spec coverage:** input surfaces (Task 1 flags, Task 7 CLI, Task 8 dock); ImageInput + validation (Task 2); streaming image content (Task 4); addendum (Task 3) + threading (Task 5); dock transport (Task 6); verify loop (Task 3 verify sub-section + Task 7 flag); errors (Tasks 2/6/7); testing (each task + Task 9). All spec §3–§6 items map to a task.
- **Type consistency:** `ImageInput { mediaType, base64 }` defined once in Task 2 and imported by Tasks 4, 6, 7. `buildPromptInput` (Task 4), `requestImage` (Task 6), `PromptContext` (Task 5), `SystemPromptOpts` (Task 3) names are reused verbatim downstream.
- **Protocol:** bumped to 3 in `events.ts` (Task 6) and `init.server.luau` (Task 8) together; the `/info` test reads the constant so it tracks automatically.

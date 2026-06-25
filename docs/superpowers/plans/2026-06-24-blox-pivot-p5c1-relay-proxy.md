# P5-c.1 Enforcing Relay Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hosted, Anthropic-compatible proxy (`blox relay serve`) that holds the team API key, authenticates members by per-member token, enforces the model allowlist + rolling USD cap server-side on every `/v1/messages` call, proxies to `api.anthropic.com`, and logs per-member token usage + cost.

**Architecture:** New `src/relay/` module. Pure helpers (`pricing`, `usage`, `members`, `enforce`, `ledger`) are unit-tested in isolation; `server.ts` wires them behind a `node:http` server that proxies and tees the upstream response for usage extraction. Reuses P5-a (`AuditEntry`, policy semantics) and P5-b (`aggregateUsage`). CLI subcommands under `blox relay`.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), vitest, Zod (config), Node stdlib `http`/`https`/`crypto`/`fs`/`stream`. No new dependencies.

## Global Constraints

- **No new dependencies** — stdlib `http`/`https`/`crypto`/`fs`/`stream` + `JSON` only.
- **ESM import specifiers end in `.js`** (NodeNext), even for `.ts` sources.
- **The real team API key never touches disk, the members file, the ledger, or logs.** It is read from `process.env[relay.apiKeyEnv]` and attached only to the upstream request's `x-api-key`.
- **Member tokens are stored as `sha256(salt || token)` only** — never the raw token. The members file is written mode `0600`. Auth uses a constant-time compare (`crypto.timingSafeEqual`).
- **Fail closed:** auth/enforcement failures reject (401/403) and never proxy. A ledger-append failure after a served response is logged, never fails the response (P5-a rule).
- **Reuse, don't duplicate:** enforcement reuses the top-level `policy` block; the relay ledger reuses the `AuditEntry` shape and the JSONL reader; `GET /api/v1/usage` reuses `aggregateUsage`.
- **Money $ per 1M tokens** in the pricing table; cache multipliers are constants 0.1 (read) / 1.25 (write).
- **Tests** run from repo root with `npm test` (`vitest run`). Focused: `npm test -- tests/<file>`.
- AuditEntry fields (from `src/audit.ts`): `ts, user, model, turns, costUsd, status, commit, prompt, stopReason?`.
- Default model when building anything LLM-shaped is `claude-opus-4-8` — the pricing defaults seed it.

---

### Task 1: Config — `relay` block

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `RelaySchema` + `Relay` type; `BloxConfig.relay?: Relay`. Fields: `port` (default 8787), `host` (default '127.0.0.1'), `apiKeyEnv` (default 'ANTHROPIC_API_KEY'), `upstream` (default 'https://api.anthropic.com'), `membersPath` (default '.blox/relay-members.json'), `ledgerPath` (default '.blox/relay-audit.jsonl'), `pricing` (record of `{in:number,out:number}`, default `DEFAULT_PRICING_CONFIG`).

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts`:

```ts
it('defaults the relay block when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blox-'));
  writeFileSync(join(dir, 'blox.config.json'), '{}');
  const c = loadConfig(dir, { projectPath: dir });
  expect(c.relay).toBeUndefined();
});

it('fills relay defaults when the block is present but partial', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blox-'));
  writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({ relay: { port: 9000 } }));
  const c = loadConfig(dir, { projectPath: dir });
  expect(c.relay).toMatchObject({
    port: 9000, host: '127.0.0.1', apiKeyEnv: 'ANTHROPIC_API_KEY',
    upstream: 'https://api.anthropic.com',
    membersPath: '.blox/relay-members.json', ledgerPath: '.blox/relay-audit.jsonl',
  });
  expect(c.relay!.pricing['claude-opus-4-8']).toEqual({ in: 5, out: 25 });
});
```

(Ensure `tests/config.test.ts` imports `writeFileSync`, `mkdtempSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path` — add any missing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — `relay` not on the parsed config.

- [ ] **Step 3: Add `RelaySchema` to `src/config.ts`**

Above `BloxConfigSchema`, add:

```ts
export const DEFAULT_PRICING_CONFIG: Record<string, { in: number; out: number }> = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-fable-5': { in: 10, out: 50 },
};

export const RelaySchema = z.object({
  port: z.number().int().positive().default(8787),
  host: z.string().default('127.0.0.1'),
  apiKeyEnv: z.string().default('ANTHROPIC_API_KEY'),
  upstream: z.string().default('https://api.anthropic.com'),
  membersPath: z.string().default('.blox/relay-members.json'),
  ledgerPath: z.string().default('.blox/relay-audit.jsonl'),
  pricing: z.record(z.string(), z.object({ in: z.number(), out: z.number() })).default(DEFAULT_PRICING_CONFIG),
});
export type Relay = z.infer<typeof RelaySchema>;
```

In `BloxConfigSchema`, add the field: `relay: RelaySchema.optional(),`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/config.test.ts`
Expected: PASS — defaults applied; absent block stays undefined.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(relay): config relay block with defaults"
```

---

### Task 2: Pricing (`src/relay/pricing.ts`)

**Files:**
- Create: `src/relay/pricing.ts`
- Test: `tests/relay.pricing.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ModelPrice { in: number; out: number }
  export interface UsageTokens { input: number; output: number; cacheRead: number; cacheWrite: number }
  export const DEFAULT_PRICING: Record<string, ModelPrice>;
  export function costUsd(u: UsageTokens, model: string, pricing: Record<string, ModelPrice>): { usd: number; unknownPrice: boolean };
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/relay.pricing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { costUsd, type UsageTokens } from '../src/relay/pricing.js';

const price = { 'claude-opus-4-8': { in: 5, out: 25 } };
const u = (over: Partial<UsageTokens> = {}): UsageTokens =>
  ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...over });

describe('costUsd', () => {
  it('prices input + output per Mtok', () => {
    const r = costUsd(u({ input: 1_000_000, output: 1_000_000 }), 'claude-opus-4-8', price);
    expect(r.usd).toBeCloseTo(30); // 1*5 + 1*25
    expect(r.unknownPrice).toBe(false);
  });

  it('applies cache multipliers (read 0.1x, write 1.25x) to the input rate', () => {
    const r = costUsd(u({ cacheRead: 1_000_000, cacheWrite: 1_000_000 }), 'claude-opus-4-8', price);
    expect(r.usd).toBeCloseTo(0.1 * 5 + 1.25 * 5); // 0.5 + 6.25 = 6.75
  });

  it('flags an unknown model and costs 0', () => {
    const r = costUsd(u({ input: 1_000_000 }), 'mystery-model', price);
    expect(r.usd).toBe(0);
    expect(r.unknownPrice).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/relay.pricing.test.ts`
Expected: FAIL — `Cannot find module '../src/relay/pricing.js'`.

- [ ] **Step 3: Write `src/relay/pricing.ts`**

```ts
export interface ModelPrice { in: number; out: number }
export interface UsageTokens { input: number; output: number; cacheRead: number; cacheWrite: number }

export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-fable-5': { in: 10, out: 50 },
};

export function costUsd(
  u: UsageTokens,
  model: string,
  pricing: Record<string, ModelPrice>,
): { usd: number; unknownPrice: boolean } {
  const p = pricing[model];
  if (!p) return { usd: 0, unknownPrice: true };
  const inUsd = ((u.input + u.cacheRead * 0.1 + u.cacheWrite * 1.25) / 1_000_000) * p.in;
  const outUsd = (u.output / 1_000_000) * p.out;
  return { usd: inUsd + outUsd, unknownPrice: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/relay.pricing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/relay/pricing.ts tests/relay.pricing.test.ts
git commit -m "feat(relay): token->USD pricing with cache multipliers"
```

---

### Task 3: Usage extraction (`src/relay/usage.ts`)

**Files:**
- Create: `src/relay/usage.ts`
- Test: `tests/relay.usage.test.ts`

**Interfaces:**
- Consumes: `UsageTokens` from `./pricing.js`.
- Produces:
  ```ts
  export function usageFromJson(body: unknown): UsageTokens;
  export function usageFromSse(rawSse: string): UsageTokens;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/relay.usage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { usageFromJson, usageFromSse } from '../src/relay/usage.js';

describe('usageFromJson', () => {
  it('reads usage fields, defaulting missing ones to 0', () => {
    expect(usageFromJson({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } }))
      .toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 0 });
  });
  it('returns zeros for a body with no usage', () => {
    expect(usageFromJson({})).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('usageFromSse', () => {
  it('takes input+cache from message_start and output from the final message_delta', () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":200,"cache_read_input_tokens":10,"cache_creation_input_tokens":3,"output_tokens":1}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
      '',
    ].join('\n');
    expect(usageFromSse(sse)).toEqual({ input: 200, output: 42, cacheRead: 10, cacheWrite: 3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/relay.usage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/relay/usage.ts`**

```ts
import type { UsageTokens } from './pricing.js';

function pick(u: Record<string, unknown> | undefined): Partial<UsageTokens> {
  if (!u) return {};
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : undefined);
  return { input: n('input_tokens'), output: n('output_tokens'), cacheRead: n('cache_read_input_tokens'), cacheWrite: n('cache_creation_input_tokens') };
}

export function usageFromJson(body: unknown): UsageTokens {
  const u = pick((body as { usage?: Record<string, unknown> } | null)?.usage);
  return { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
}

export function usageFromSse(rawSse: string): UsageTokens {
  const out: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const line of rawSse.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let evt: unknown;
    try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
    const e = evt as { type?: string; message?: { usage?: Record<string, unknown> }; usage?: Record<string, unknown> };
    if (e.type === 'message_start') {
      const u = pick(e.message?.usage);
      if (u.input != null) out.input = u.input;
      if (u.cacheRead != null) out.cacheRead = u.cacheRead;
      if (u.cacheWrite != null) out.cacheWrite = u.cacheWrite;
    } else if (e.type === 'message_delta') {
      const u = pick(e.usage);
      if (u.output != null) out.output = u.output;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/relay.usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/relay/usage.ts tests/relay.usage.test.ts
git commit -m "feat(relay): extract token usage from JSON and SSE responses"
```

---

### Task 4: Members store (`src/relay/members.ts`)

**Files:**
- Create: `src/relay/members.ts`
- Test: `tests/relay.members.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MembersStore { salt: string; members: Record<string, string> } // sha256hex -> email
  export function loadMembers(path: string): MembersStore;
  export function addMember(path: string, email: string): string;   // returns RAW token; persists only the hash
  export function removeMember(path: string, email: string): boolean;
  export function listMembers(path: string): string[];
  export function authMember(store: MembersStore, presentedKey: string): string | null; // email | null
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/relay.members.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMembers, addMember, removeMember, listMembers, authMember } from '../src/relay/members.js';

const newPath = () => join(mkdtempSync(join(tmpdir(), 'blox-')), 'relay-members.json');

describe('members store', () => {
  it('absent file loads an empty store with a salt', () => {
    const s = loadMembers(newPath());
    expect(s.members).toEqual({});
    expect(typeof s.salt).toBe('string');
  });

  it('addMember returns a blx_ token and never persists it raw', () => {
    const p = newPath();
    const token = addMember(p, 'a@x.com');
    expect(token.startsWith('blx_')).toBe(true);
    const fileText = readFileSync(p, 'utf8');
    expect(fileText.includes(token)).toBe(false); // only the hash is stored
    expect(listMembers(p)).toEqual(['a@x.com']);
  });

  it('writes the members file mode 0600', () => {
    const p = newPath();
    addMember(p, 'a@x.com');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('authMember maps a valid presented key to its email and rejects others', () => {
    const p = newPath();
    const token = addMember(p, 'a@x.com');
    const store = loadMembers(p);
    expect(authMember(store, token)).toBe('a@x.com');
    expect(authMember(store, 'blx_wrong')).toBeNull();
    expect(authMember(store, '')).toBeNull();
  });

  it('removeMember revokes the token', () => {
    const p = newPath();
    const token = addMember(p, 'a@x.com');
    expect(removeMember(p, 'a@x.com')).toBe(true);
    expect(authMember(loadMembers(p), token)).toBeNull();
    expect(removeMember(p, 'a@x.com')).toBe(false); // already gone
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/relay.members.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/relay/members.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export interface MembersStore { salt: string; members: Record<string, string> }

function hash(salt: string, token: string): string {
  return createHash('sha256').update(salt).update(token).digest('hex');
}

export function loadMembers(path: string): MembersStore {
  if (!existsSync(path)) return { salt: randomBytes(16).toString('hex'), members: {} };
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as MembersStore;
    if (typeof s.salt === 'string' && s.members && typeof s.members === 'object') return s;
  } catch {
    // fall through to a fresh store on a corrupt file
  }
  return { salt: randomBytes(16).toString('hex'), members: {} };
}

function save(path: string, store: MembersStore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function addMember(path: string, email: string): string {
  const store = loadMembers(path);
  const token = 'blx_' + randomBytes(24).toString('base64url');
  store.members[hash(store.salt, token)] = email;
  save(path, store);
  return token;
}

export function removeMember(path: string, email: string): boolean {
  const store = loadMembers(path);
  const key = Object.keys(store.members).find((k) => store.members[k] === email);
  if (!key) return false;
  delete store.members[key];
  save(path, store);
  return true;
}

export function listMembers(path: string): string[] {
  return [...new Set(Object.values(loadMembers(path).members))].sort();
}

export function authMember(store: MembersStore, presentedKey: string): string | null {
  if (!presentedKey) return null;
  const h = hash(store.salt, presentedKey);
  for (const [stored, email] of Object.entries(store.members)) {
    const a = Buffer.from(h);
    const b = Buffer.from(stored);
    if (a.length === b.length && timingSafeEqual(a, b)) return email;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/relay.members.test.ts`
Expected: PASS — including the `0600` mode and the "token not in file" checks.

- [ ] **Step 5: Commit**

```bash
git add src/relay/members.ts tests/relay.members.test.ts
git commit -m "feat(relay): per-member token store (hashed, 0600, constant-time auth)"
```

---

### Task 5: Relay ledger (`src/relay/ledger.ts`) + JSONL generics

**Files:**
- Modify: `src/audit.ts`
- Create: `src/relay/ledger.ts`
- Test: `tests/audit.test.ts`, `tests/relay.ledger.test.ts`

**Interfaces:**
- Consumes: `AuditEntry` from `../audit.js`; `UsageTokens` from `./pricing.js`.
- Produces (audit.ts): `export function appendJsonl(path: string, obj: unknown): void;` and `export function readJsonl<T>(path: string): T[];` — `appendAuditEntry`/`readAuditEntries` refactored to call them (behavior-preserving).
- Produces (relay/ledger.ts):
  ```ts
  export interface RelayEntry extends AuditEntry {
    inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; unknownPrice?: boolean;
  }
  export function appendRelayEntry(ledgerPath: string, entry: RelayEntry): void;
  export function readRelayEntries(ledgerPath: string): RelayEntry[];
  ```

- [ ] **Step 1: Write the failing test**

Add to `tests/audit.test.ts`:

```ts
import { appendJsonl, readJsonl } from '../src/audit.js';

describe('jsonl generics', () => {
  it('appendJsonl + readJsonl round-trips and skips malformed lines', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'blox-')), 'x.jsonl');
    appendJsonl(f, { a: 1 });
    appendFileSync(f, 'garbage\n');
    appendJsonl(f, { a: 2 });
    expect(readJsonl<{ a: number }>(f).map((e) => e.a)).toEqual([1, 2]);
  });
  it('readJsonl returns [] for an absent file', () => {
    expect(readJsonl('/no/such/file.jsonl')).toEqual([]);
  });
});
```

Create `tests/relay.ledger.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRelayEntry, readRelayEntries, type RelayEntry } from '../src/relay/ledger.js';

const entry = (over: Partial<RelayEntry> = {}): RelayEntry => ({
  ts: new Date().toISOString(), user: 'a@x.com', model: 'claude-opus-4-8',
  turns: 1, costUsd: 0.5, status: 'success', commit: null, prompt: '',
  inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, ...over,
});

describe('relay ledger', () => {
  it('appends and reads back relay entries at a custom path', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'blox-')), 'relay-audit.jsonl');
    appendRelayEntry(f, entry({ costUsd: 1 }));
    appendRelayEntry(f, entry({ costUsd: 2 }));
    expect(readRelayEntries(f).map((e) => e.costUsd)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/audit.test.ts tests/relay.ledger.test.ts`
Expected: FAIL — `appendJsonl`/`readJsonl` not exported; relay ledger module missing.

- [ ] **Step 3a: Refactor `src/audit.ts` to expose JSONL generics**

Add (and make the existing functions delegate, preserving behavior):

```ts
export function appendJsonl(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(obj) + '\n');
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip malformed */ }
  }
  return out;
}
```

Then change `appendAuditEntry` to `appendJsonl(auditPath(projectPath), entry)` and `readAuditEntries` to `return readJsonl<AuditEntry>(auditPath(projectPath));`. Keep `readWindowSpend` as-is (it already calls `readAuditEntries`).

- [ ] **Step 3b: Write `src/relay/ledger.ts`**

```ts
import type { AuditEntry } from '../audit.js';
import { appendJsonl, readJsonl } from '../audit.js';

export interface RelayEntry extends AuditEntry {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  unknownPrice?: boolean;
}

export function appendRelayEntry(ledgerPath: string, entry: RelayEntry): void {
  appendJsonl(ledgerPath, entry);
}

export function readRelayEntries(ledgerPath: string): RelayEntry[] {
  return readJsonl<RelayEntry>(ledgerPath);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/audit.test.ts tests/relay.ledger.test.ts tests/policy.surface.test.ts`
Expected: PASS — new jsonl + relay-ledger tests, plus existing audit/policy tests stay green (behavior-preserving refactor).

- [ ] **Step 5: Commit**

```bash
git add src/audit.ts src/relay/ledger.ts tests/audit.test.ts tests/relay.ledger.test.ts
git commit -m "feat(relay): server-side usage ledger via shared jsonl helpers"
```

---

### Task 6: Enforcement (`src/relay/enforce.ts`)

**Files:**
- Create: `src/relay/enforce.ts`
- Test: `tests/relay.enforce.test.ts`

**Interfaces:**
- Consumes: `Policy` from `../config.js`; `readRelayEntries` from `./ledger.js`.
- Produces:
  ```ts
  export type RelayReject = { status: 403; error: string };
  export function enforceRelay(args: { model: string; policy?: Policy; ledgerPath: string; now?: Date }): RelayReject | null;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/relay.enforce.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enforceRelay } from '../src/relay/enforce.js';
import { appendRelayEntry, type RelayEntry } from '../src/relay/ledger.js';

const ledger = () => join(mkdtempSync(join(tmpdir(), 'blox-')), 'relay-audit.jsonl');
const entry = (over: Partial<RelayEntry>): RelayEntry => ({
  ts: new Date().toISOString(), user: 'a@x.com', model: 'claude-opus-4-8', turns: 1,
  costUsd: 0, status: 'success', commit: null, prompt: '',
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over,
});
const now = new Date('2026-06-24T12:00:00Z');

describe('enforceRelay', () => {
  it('allows when there is no policy', () => {
    expect(enforceRelay({ model: 'anything', ledgerPath: ledger(), now })).toBeNull();
  });
  it('rejects a model outside the allowlist', () => {
    const r = enforceRelay({ model: 'gpt-4', policy: { models: ['claude-opus-4-8'] }, ledgerPath: ledger(), now });
    expect(r?.status).toBe(403);
    expect(r?.error).toMatch(/allowlist/);
  });
  it('allows a model inside the allowlist', () => {
    expect(enforceRelay({ model: 'claude-opus-4-8', policy: { models: ['claude-opus-4-8'] }, ledgerPath: ledger(), now })).toBeNull();
  });
  it('rejects when the rolling window spend meets/exceeds the cap', () => {
    const f = ledger();
    appendRelayEntry(f, entry({ ts: '2026-06-23T12:00:00Z', costUsd: 200 }));
    const r = enforceRelay({ model: 'claude-opus-4-8', policy: { rollingBudget: { windowDays: 30, maxUsd: 200 } }, ledgerPath: f, now });
    expect(r?.status).toBe(403);
    expect(r?.error).toMatch(/budget/);
  });
  it('ignores spend outside the window', () => {
    const f = ledger();
    appendRelayEntry(f, entry({ ts: '2026-01-01T12:00:00Z', costUsd: 999 }));
    expect(enforceRelay({ model: 'claude-opus-4-8', policy: { rollingBudget: { windowDays: 30, maxUsd: 200 } }, ledgerPath: f, now })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/relay.enforce.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/relay/enforce.ts`**

```ts
import type { Policy } from '../config.js';
import { readRelayEntries } from './ledger.js';

export type RelayReject = { status: 403; error: string };

export function enforceRelay(args: {
  model: string;
  policy?: Policy;
  ledgerPath: string;
  now?: Date;
}): RelayReject | null {
  const p = args.policy;
  if (!p) return null;

  if (p.models && !p.models.includes(args.model)) {
    return { status: 403, error: `model "${args.model}" is not in the team allowlist [${p.models.join(', ')}]` };
  }

  if (p.rollingBudget) {
    const now = args.now ?? new Date();
    const cutoff = now.getTime() - p.rollingBudget.windowDays * 24 * 60 * 60 * 1000;
    let spent = 0;
    for (const e of readRelayEntries(args.ledgerPath)) {
      const t = Date.parse(e.ts);
      if (!Number.isNaN(t) && t >= cutoff && typeof e.costUsd === 'number') spent += e.costUsd;
    }
    if (spent >= p.rollingBudget.maxUsd) {
      return { status: 403, error: `team rolling budget reached: $${spent.toFixed(2)} spent in the last ${p.rollingBudget.windowDays}d meets/exceeds the $${p.rollingBudget.maxUsd} cap` };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/relay.enforce.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/relay/enforce.ts tests/relay.enforce.test.ts
git commit -m "feat(relay): server-side allowlist + rolling-cap enforcement"
```

---

### Task 7: Relay server (`src/relay/server.ts`)

**Files:**
- Create: `src/relay/server.ts`
- Test: `tests/relay.server.test.ts`

**Interfaces:**
- Consumes: `authMember`/`loadMembers` (`./members.js`), `enforceRelay` (`./enforce.js`), `usageFromJson`/`usageFromSse` (`./usage.js`), `costUsd` (`./pricing.js`), `appendRelayEntry`/`RelayEntry` (`./ledger.js`), `readRelayEntries`, `aggregateUsage` (`../usageReport.js`), `Relay`/`Policy` (`../config.js`).
- Produces:
  ```ts
  export interface RelayServerOptions { relay: Relay; policy?: Policy; realKey: string; port?: number; now?: () => number }
  export class RelayServer {
    constructor(opts: RelayServerOptions);
    start(): Promise<number>;   // resolves the bound port
    stop(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/relay.server.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayServer } from '../src/relay/server.js';
import { addMember } from '../src/relay/members.js';
import { readRelayEntries } from '../src/relay/ledger.js';
import { DEFAULT_PRICING_CONFIG } from '../src/config.js';

let relay: RelayServer | null = null;
let upstream: Server | null = null;
afterEach(async () => { if (relay) await relay.stop(); relay = null; upstream?.close(); upstream = null; });

// Mock api.anthropic.com: echoes a fixed messages response with usage,
// and records the x-api-key it received so the test can assert key-swap.
function startUpstream(received: { key?: string }): Promise<string> {
  return new Promise((resolve) => {
    upstream = createServer((req, res) => {
      received.key = req.headers['x-api-key'] as string;
      let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1000, output_tokens: 500 } }));
      });
    });
    upstream.listen(0, '127.0.0.1', () => {
      const a = upstream!.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });
}

function relayOpts(over: Partial<{ membersPath: string; ledgerPath: string; upstream: string; policy: unknown }> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'blox-'));
  return {
    membersPath: over.membersPath ?? join(dir, 'm.json'),
    ledgerPath: over.ledgerPath ?? join(dir, 'l.jsonl'),
    upstream: over.upstream ?? 'http://127.0.0.1:1',
    policy: over.policy,
  };
}

async function start(o: { membersPath: string; ledgerPath: string; upstream: string; policy?: unknown }) {
  relay = new RelayServer({
    realKey: 'sk-real-team-key',
    policy: o.policy as never,
    relay: {
      port: 0, host: '127.0.0.1', apiKeyEnv: 'X', upstream: o.upstream,
      membersPath: o.membersPath, ledgerPath: o.ledgerPath, pricing: DEFAULT_PRICING_CONFIG,
    },
  });
  const port = await relay.start();
  return `http://127.0.0.1:${port}`;
}

const post = (base: string, key: string, body: unknown) =>
  fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('RelayServer', () => {
  it('401s an unknown member token without proxying', async () => {
    const o = relayOpts();
    const base = await start(o);
    const res = await post(base, 'blx_unknown', { model: 'claude-opus-4-8' });
    expect(res.status).toBe(401);
  });

  it('403s a disallowed model', async () => {
    const o = relayOpts({ policy: { models: ['claude-sonnet-4-6'] } });
    const token = addMember(o.membersPath, 'a@x.com');
    const base = await start(o);
    const res = await post(base, token, { model: 'claude-opus-4-8' });
    expect(res.status).toBe(403);
  });

  it('proxies a valid call with the REAL key, returns the body, and ledgers the cost', async () => {
    const received: { key?: string } = {};
    const up = await startUpstream(received);
    const o = relayOpts({ upstream: up });
    const token = addMember(o.membersPath, 'a@x.com');
    const base = await start(o);
    const res = await post(base, token, { model: 'claude-opus-4-8' });
    expect(res.status).toBe(200);
    expect((await res.json()).content[0].text).toBe('hi');
    expect(received.key).toBe('sk-real-team-key'); // member token swapped for the real key
    const entries = readRelayEntries(o.ledgerPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].user).toBe('a@x.com');
    expect(entries[0].inputTokens).toBe(1000);
    expect(entries[0].costUsd).toBeCloseTo((1000 / 1e6) * 5 + (500 / 1e6) * 25); // 0.005 + 0.0125
  });

  it('serves GET /api/v1/usage from the relay ledger', async () => {
    const up = await startUpstream({});
    const o = relayOpts({ upstream: up });
    const token = addMember(o.membersPath, 'a@x.com');
    const base = await start(o);
    await post(base, token, { model: 'claude-opus-4-8' });
    const usage = await (await fetch(`${base}/api/v1/usage`)).json();
    expect(usage.runCount).toBe(1);
    expect(usage.byUser[0].key).toBe('a@x.com');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/relay.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/relay/server.ts`**

```ts
import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { PassThrough } from 'node:stream';
import type { Relay, Policy } from '../config.js';
import { loadMembers, authMember } from './members.js';
import { enforceRelay } from './enforce.js';
import { usageFromJson, usageFromSse } from './usage.js';
import { costUsd } from './pricing.js';
import { appendRelayEntry, readRelayEntries, type RelayEntry } from './ledger.js';
import { aggregateUsage } from '../usageReport.js';

export interface RelayServerOptions {
  relay: Relay;
  policy?: Policy;
  realKey: string;
  port?: number;
  now?: () => number;
}

export class RelayServer {
  private server: Server | null = null;
  private opts: RelayServerOptions;
  constructor(opts: RelayServerOptions) { this.opts = opts; }

  start(): Promise<number> {
    const server = createServer((req, res) => void this.route(req, res));
    this.server = server;
    const port = this.opts.port ?? this.opts.relay.port;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.opts.relay.host, () => {
        const a = server.address();
        resolve(typeof a === 'object' && a ? a.port : port);
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/v1/usage') return this.usage(url, res);
    if (req.method === 'POST' && url.pathname === '/v1/messages') return this.messages(req, res);
    return json(res, 404, { error: 'not found' });
  }

  private usage(url: URL, res: ServerResponse): void {
    const sinceRaw = url.searchParams.get('since');
    const n = sinceRaw != null ? Number(sinceRaw.replace(/d$/, '')) : NaN;
    const sinceDays = Number.isInteger(n) && n > 0 ? n : null;
    const rb = this.opts.policy?.rollingBudget;
    const summary = aggregateUsage(readRelayEntries(this.opts.relay.ledgerPath), {
      now: new Date(),
      windowDays: sinceDays ?? rb?.windowDays ?? null,
      capUsd: rb?.maxUsd ?? null,
    });
    json(res, 200, summary);
  }

  private async messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. auth
    const presented = (req.headers['x-api-key'] as string) ?? '';
    const member = authMember(loadMembers(this.opts.relay.membersPath), presented);
    if (!member) return json(res, 401, { error: 'unknown member token' });

    // 2. buffer body + read model
    const body = await readBytes(req);
    let model = '';
    try { model = String((JSON.parse(body.toString('utf8')) as { model?: unknown }).model ?? ''); } catch { /* leave '' */ }

    // 3. enforce
    const reject = enforceRelay({ model, policy: this.opts.policy, ledgerPath: this.opts.relay.ledgerPath });
    if (reject) return json(res, reject.status, { error: reject.error });

    // 4. proxy with the REAL key, tee the response for usage
    const u = new URL('/v1/messages', this.opts.relay.upstream);
    const reqFn = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    headers['x-api-key'] = this.opts.realKey;
    headers['host'] = u.host;
    headers['content-length'] = String(body.length);

    const up = reqFn(u, { method: 'POST', headers }, (upRes: IncomingMessage) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      const tee = new PassThrough();
      const chunks: Buffer[] = [];
      tee.on('data', (c: Buffer) => chunks.push(c));
      upRes.pipe(res);
      upRes.pipe(tee);
      upRes.on('end', () => {
        const code = upRes.statusCode ?? 0;
        if (code < 200 || code >= 300) return; // only ledger successful spend
        const raw = Buffer.concat(chunks).toString('utf8');
        const ct = String(upRes.headers['content-type'] ?? '');
        const usage = ct.includes('text/event-stream') ? usageFromSse(raw) : usageFromJson(safeJson(raw));
        const { usd, unknownPrice } = costUsd(usage, model, this.opts.relay.pricing);
        const entry: RelayEntry = {
          ts: new Date().toISOString(), user: member, model, turns: 1, costUsd: usd,
          status: 'success', commit: null, prompt: '',
          inputTokens: usage.input, outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
          ...(unknownPrice ? { unknownPrice: true } : {}),
        };
        try { appendRelayEntry(this.opts.relay.ledgerPath, entry); } catch { /* never fail a served response */ }
      });
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    up.end(body);
  }
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }
async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/relay.server.test.ts`
Expected: PASS — all five cases (401, 403, proxy+key-swap+ledger, usage endpoint).

- [ ] **Step 5: Commit**

```bash
git add src/relay/server.ts tests/relay.server.test.ts
git commit -m "feat(relay): proxy server with auth, enforcement, usage tee + ledger"
```

---

### Task 8: CLI — `blox relay` subcommands

**Files:**
- Modify: `src/args.ts`, `src/cli.ts`
- Create: `src/relay/cli.ts`
- Test: `tests/args.test.ts`, `tests/relay.cli.test.ts`

**Interfaces:**
- Consumes: `addMember`/`removeMember`/`listMembers` (`./members.js`), `RelayServer` (`./server.js`), `loadConfig` (`../config.js`).
- Produces (args.ts): `'relay'` added to the `command` union; the sub-word + email land in `prompt` (the existing positional join, like `panel install`).
- Produces (relay/cli.ts): `export function relayMemberCommand(action: 'add'|'rm'|'list', projectPath: string, email?: string): string;` — does the members-file mutation and returns the text to print (testable without a server). `relay serve` itself stays in cli.ts (starts the server, blocks on SIGINT).

- [ ] **Step 1: Write the failing test**

Add to `tests/args.test.ts`:

```ts
describe('relay subcommand', () => {
  it('parses the relay command and its sub-word', () => {
    const a = parseArgs(['relay', 'serve']);
    expect(a.command).toBe('relay');
    expect(a.prompt).toBe('serve');
  });
  it('parses add-member with an email', () => {
    const a = parseArgs(['relay', 'add-member', 'alice@team.com']);
    expect(a.command).toBe('relay');
    expect(a.prompt).toBe('add-member alice@team.com');
  });
});
```

Create `tests/relay.cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relayMemberCommand } from '../src/relay/cli.js';

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blox-'));
  mkdirSync(join(dir, '.blox'), { recursive: true });
  writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({ relay: {} }));
  return dir;
}

describe('relayMemberCommand', () => {
  it('add prints a blx_ token once, list then shows the email', () => {
    const dir = project();
    const added = relayMemberCommand('add', dir, 'alice@team.com');
    expect(added).toMatch(/blx_/);
    expect(relayMemberCommand('list', dir)).toContain('alice@team.com');
  });
  it('rm removes a member', () => {
    const dir = project();
    relayMemberCommand('add', dir, 'alice@team.com');
    expect(relayMemberCommand('rm', dir, 'alice@team.com')).toMatch(/removed/i);
    expect(relayMemberCommand('list', dir)).not.toContain('alice@team.com');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/args.test.ts tests/relay.cli.test.ts`
Expected: FAIL — `relay` not in the union; `relayMemberCommand` module missing.

- [ ] **Step 3a: Add `relay` to `src/args.ts`**

In both the `interface ParsedArgs` `command` union and the local `let command` declaration, add `| 'relay'`. In the parse loop, add (next to the other command tokens):

```ts
    else if (a === 'relay' && command === null && positional.length === 0) command = 'relay';
```

(The sub-word and email flow into `positional` → `prompt` automatically, exactly like `panel install`.)

- [ ] **Step 3b: Write `src/relay/cli.ts`**

```ts
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { addMember, removeMember, listMembers } from './members.js';

function membersPath(projectPath: string): string {
  const config = loadConfig(projectPath, { projectPath });
  const rel = config.relay?.membersPath ?? '.blox/relay-members.json';
  return join(config.projectPath, rel);
}

export function relayMemberCommand(action: 'add' | 'rm' | 'list', projectPath: string, email?: string): string {
  const path = membersPath(projectPath);
  if (action === 'add') {
    if (!email) throw new Error('add-member needs an email');
    const token = addMember(path, email);
    return `added ${email}\n  token: ${token}\n  store this now — it will not be shown again`;
  }
  if (action === 'rm') {
    if (!email) throw new Error('rm-member needs an email');
    return removeMember(path, email) ? `removed ${email}` : `no such member: ${email}`;
  }
  const members = listMembers(path);
  return members.length ? members.join('\n') : '(no members)';
}
```

- [ ] **Step 3c: Wire the `relay` branch into `src/cli.ts`**

Add imports near the others:

```ts
import { RelayServer } from './relay/server.js';
import { relayMemberCommand } from './relay/cli.js';
```

Add the branch alongside the other `if (command === …)` blocks (after the `panel` block):

```ts
  if (command === 'relay') {
    const cwd = projectPath ?? process.cwd();
    const sub = (prompt ?? '').split(' ');
    const action = sub[0];
    if (action === 'add-member' || action === 'rm-member' || action === 'list-members') {
      const map = { 'add-member': 'add', 'rm-member': 'rm', 'list-members': 'list' } as const;
      try {
        console.log(relayMemberCommand(map[action], cwd, sub[1]));
        process.exit(0);
      } catch (e) {
        console.error((e as Error).message);
        process.exit(2);
      }
    }
    if (action === 'serve') {
      const config = loadConfig(cwd, projectPath ? { projectPath } : {});
      if (!config.relay) { console.error('no `relay` block in blox.config.json — add one (see docs)'); process.exit(1); }
      const realKey = process.env[config.relay.apiKeyEnv];
      if (!realKey) { console.error(`no team API key in $${config.relay.apiKeyEnv}`); process.exit(1); }
      const server = new RelayServer({ relay: config.relay, policy: config.policy, realKey });
      const port = await server.start();
      console.log(`blox relay on ${config.relay.host}:${port} — point members' ANTHROPIC_BASE_URL here`);
      console.log('   (Ctrl-C to stop)');
      await new Promise<void>((resolve) => { const done = () => resolve(); process.on('SIGINT', done); process.on('SIGTERM', done); });
      await server.stop();
      process.exit(0);
    }
    console.error('usage: blox relay serve | add-member <email> | rm-member <email> | list-members');
    process.exit(2);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/args.test.ts tests/relay.cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 6: Commit**

```bash
git add src/args.ts src/cli.ts src/relay/cli.ts tests/args.test.ts tests/relay.cli.test.ts
git commit -m "feat(relay): blox relay serve + add-member/rm-member/list-members"
```

---

### Task 9: Docs + pay the P5-b escape debt + full green

**Files:**
- Modify: `README.md`, `app/renderer/usageView.ts`
- Test: `app/renderer/usageView.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Pay the `// P5-c` escape debt in `app/renderer/usageView.ts`**

The relay now serves usage data sourced from member-supplied request bodies (the `model` string), so the renderer must escape bucket keys. Replace the `rows` helper and its `// P5-c` comment:

```ts
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rows = (bs: { key: string; costUsd: number; runs?: number }[]) =>
  bs.map((b) => `<tr><td>${esc(b.key)}</td><td>${usd(b.costUsd)}</td><td>${b.runs ?? ''}</td></tr>`).join('');
```

Add a test to `app/renderer/usageView.test.ts`:

```ts
it('escapes HTML in bucket keys', () => {
  const html = usageHtml({
    window: { days: null, since: null }, totalUsd: 1, capUsd: null, capPct: null,
    runCount: 1, errorCount: 0,
    byUser: [{ key: '<script>x</script>', costUsd: 1, runs: 1 }], byModel: [],
  });
  expect(html).not.toContain('<script>x</script>');
  expect(html).toContain('&lt;script&gt;');
});
```

- [ ] **Step 2: Run the app test**

Run (from `app/`): `npm test -- renderer/usageView.test.ts`
Expected: PASS — escaping test plus existing usageView tests.

- [ ] **Step 3: Document `blox relay` in `README.md`**

Find the team-tier section anchor:

Run: `grep -n "## Usage report\|## Studio dock panel" README.md`

Add a `## Team relay (hard gate)` section after `## Usage report`:

```
## Team relay (hard gate)

`blox relay serve` runs a self-hosted Anthropic-compatible proxy that holds the
team API key and enforces `policy` server-side. Members never get the real key,
so the model allowlist and rolling spend cap become a real gate (not advisory).

Lead (on the relay host, with the team key in $ANTHROPIC_API_KEY):

    blox relay add-member alice@team.com    # prints a blx_ token ONCE
    blox relay serve                          # binds relay.host:relay.port

Member:

    export ANTHROPIC_BASE_URL=http://<relay-host>:8787
    export ANTHROPIC_API_KEY=blx_<their-token>
    blox "build a shop UI"

The relay logs per-member token usage + cost to relay.ledgerPath and serves a
summary at GET /api/v1/usage. Config lives in the `relay` block of
blox.config.json. **TLS is not built in** — run the relay on a trusted network
or front it with nginx/caddy for TLS; member tokens ride in the x-api-key header.
```

- [ ] **Step 4: Run both suites**

Run: `npm test`
Then (from `app/`): `npm test`
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add README.md app/renderer/usageView.ts app/renderer/usageView.test.ts
git commit -m "docs(relay): document blox relay; escape usage-view keys (P5-c debt)"
```

---

## Self-Review

**Spec coverage:**
- §1 `relay` config block → Task 1. ✓
- §2 pricing (`costUsd`, cache multipliers, unknown flag) → Task 2. ✓
- §3 usage extraction (JSON + SSE) → Task 3. ✓
- §4 members store (hashed, 0600, constant-time, revoke) → Task 4. ✓
- §5 enforcement (allowlist + rolling cap vs relay ledger) → Task 6. ✓
- §6 server (auth→enforce→proxy→tee→ledger, `/api/v1/usage`, `/healthz`, key-swap, fail-closed) → Task 7. ✓
- §6 RelayEntry shape + token fields (pays P5-a token-accounting debt) → Task 5. ✓
- §7 CLI (`serve`/`add-member`/`rm-member`/`list-members`, errors if no block/key) → Task 8. ✓
- Security model (key never on disk/ledger/log; tokens hashed; fail closed; ledger-append never fails response) → Tasks 4, 7. ✓
- Deferred P5-b innerHTML escape paid → Task 9. ✓
- Docs (incl. the TLS caveat) → Task 9. ✓
- Testing section → every task is TDD. ✓
- Deferred scope (OIDC, TLS build, rate limiting, per-member caps, SaaS, c.2 client wiring) → not built. ✓

**Placeholder scan:** no TBD/TODO; every code step has full code. ✓

**Type consistency:** `UsageTokens` identical Tasks 2/3/7. `RelayEntry` identical Tasks 5/6/7. `costUsd` returns `{usd, unknownPrice}` consistently (Task 2 def, Task 7 use). `enforceRelay` signature consistent Tasks 6/7. `RelaySchema`/`Relay` fields (Task 1) match `RelayServerOptions.relay` usage (Task 7) and `relayMemberCommand` path read (Task 8). `appendJsonl`/`readJsonl` (Task 5) consumed by `relay/ledger.ts` (Task 5) — same module. `aggregateUsage` opts (`now`/`windowDays`/`capUsd`) match P5-b. ✓

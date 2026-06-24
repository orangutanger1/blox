# P5-c.1: Enforcing Relay Proxy (team hard gate)

Status: approved (design)
Date: 2026-06-24

## Context

P5 of the blox pivot is the team tier. [[p5a-team-policy-audit-shipped]] shipped
**advisory** policy + a committed audit ledger; [[p5b-usage-report-shipped]] made
that ledger human-readable. Both are local-first and honestly bypassable: a
member can edit the committed config or skip `git pull`.

P5-c turns the advisory policy into a **real hard gate**. The chosen model is a
**self-hosted enforcing proxy** (vs a hosted SaaS, deferred; vs no-server git
tightening, rejected as still-bypassable). P5-c decomposes into:

- **c.1 (this spec)** — the enforcing proxy core + per-member identity. The
  foundation: holds the team key, enforces server-side, attributes + logs usage.
- **c.2** — blox client integration (`blox auth relay`, surface rejections).
- **c.3** — remote dashboard (serve the P5-b `UsageSummary` from the relay).
- **c.4** — richer identity (OIDC/SSO) if per-member tokens prove insufficient.

Order: c.1 → c.2 (together = the usable hard gate) → c.3 → c.4 if needed.

### Why a proxy is a true gate
The hard part of spend enforcement is a chokepoint the member cannot edit. The
Agent SDK (and CCR) already route via `ANTHROPIC_BASE_URL`. So the relay is an
**Anthropic-compatible proxy** that holds the real team key: members set
`ANTHROPIC_API_KEY=<member-token>` + `ANTHROPIC_BASE_URL=<relay-url>`, the relay
authenticates the member, enforces policy, swaps in the real key, and proxies to
`api.anthropic.com`. The member never possesses the real key, so they cannot
route around the relay — that is the gate.

### What already exists (reused, not reinvented)
- `src/config.ts` — `BloxConfigSchema` + `PolicySchema` (`models` allowlist,
  `rollingBudget {windowDays, maxUsd}`). The relay reuses `policy` verbatim.
- `src/policy.ts` — `enforcePolicy` semantics (reject-not-clamp, rolling cap is
  `>=`). The relay re-expresses these against its own per-call inputs.
- `src/audit.ts` — `AuditEntry` + `readAuditEntries` (best-effort JSONL reader).
  The relay ledger extends this shape with token fields.
- `src/usageReport.ts` — `aggregateUsage` / `UsageSummary` for `GET /api/v1/usage`.
- `src/cli.ts` / `src/args.ts` — subcommand dispatch (`if (command === …)`).
- The Messages API shape (from the claude-api reference): `POST /v1/messages`,
  key in `x-api-key`, usage at `message_start.usage.input_tokens` + final
  `message_delta.usage.output_tokens` (streaming) or `response.usage`
  (non-streaming), with `cache_read_input_tokens` (billed ~0.1×) and
  `cache_creation_input_tokens` (billed ~1.25×).

## Security model (the load-bearing part)

- **Team key custody.** The real `ANTHROPIC_API_KEY` is read from the relay
  host's environment (a `relay.apiKeyEnv` name, default `ANTHROPIC_API_KEY`) and
  **never** written to disk, the members file, the ledger, or logs. It is
  attached to the upstream request only.
- **Member tokens.** `relay add-member <email>` generates `blx_<base64url(24
  random bytes)>` and prints it **once**. The members file stores only
  `sha256(salt || token)` → email plus a per-store random `salt`. The raw token
  is never persisted. Auth hashes the presented `x-api-key` the same way and
  compares in constant time; unknown → 401. `rm-member` deletes the entry
  (revocation). This is password-style storage: a leaked members file does not
  yield usable tokens.
- **Bind + transport.** Defaults to `127.0.0.1`; a team deployment sets
  `relay.host` to a LAN/VPC address. **TLS is out of scope for c.1** — the relay
  speaks plain HTTP and the spec documents fronting it with nginx/caddy for TLS.
  (Tokens in `x-api-key` over plain HTTP are only safe on a trusted network or
  behind a TLS terminator; this is stated in the README.)
- **Fail closed.** Any auth/enforcement error rejects the call (401/403); the
  relay never proxies an unauthenticated or over-budget request. A *ledger
  append* failure after a successful upstream call is logged but does not fail
  the already-served response (same rule as P5-a — observability never breaks a
  completed call).

## Design

### 1. Config: a `relay` block

```jsonc
{
  "policy": { "models": ["claude-opus-4-8","claude-sonnet-4-6"],
              "rollingBudget": { "windowDays": 30, "maxUsd": 500 } },
  "relay": {
    "port": 8787,
    "host": "127.0.0.1",
    "apiKeyEnv": "ANTHROPIC_API_KEY",      // env var holding the REAL team key
    "upstream": "https://api.anthropic.com",
    "membersPath": ".blox/relay-members.json", // hashes only
    "ledgerPath": ".blox/relay-audit.jsonl",   // server-side usage ledger
    "pricing": {                            // $ per Mtok; seeded defaults below
      "claude-opus-4-8":   { "in": 5,  "out": 25 },
      "claude-sonnet-4-6": { "in": 3,  "out": 15 },
      "claude-haiku-4-5":  { "in": 1,  "out": 5 },
      "claude-fable-5":    { "in": 10, "out": 50 }
    }
  }
}
```

All `relay` fields optional with the defaults shown; absent `relay` block = relay
unavailable (CLI errors if `relay serve` is run without it). Enforcement reuses
the top-level `policy` block (no duplication).

### 2. Pricing (`src/relay/pricing.ts`)

```ts
export interface ModelPrice { in: number; out: number } // USD per 1M tokens
export interface UsageTokens {
  input: number; output: number; cacheRead: number; cacheWrite: number;
}
export const DEFAULT_PRICING: Record<string, ModelPrice>;
export function costUsd(usage: UsageTokens, model: string, pricing: Record<string, ModelPrice>): number;
```

`costUsd` = `(input + cacheWrite*1.25 + cacheRead*0.1)/1e6 * price.in +
output/1e6 * price.out`. Unknown model → price `{in:0,out:0}` (cost 0) **and the
returned report flags it** so spend isn't silently undercounted (see §6). Cache
multipliers are constants (0.1 read, 1.25 write) matching Anthropic billing.

### 3. Usage extraction (`src/relay/usage.ts`)

```ts
export function usageFromJson(body: unknown): UsageTokens;        // non-streaming response
export function usageFromSse(rawSse: string): UsageTokens;        // streamed response
```

- `usageFromJson` reads `body.usage.{input_tokens, output_tokens,
  cache_read_input_tokens, cache_creation_input_tokens}` (missing → 0).
- `usageFromSse` scans SSE lines: `message_start` → `message.usage` (input +
  cache tokens), final `message_delta` → `usage.output_tokens` (cumulative). Both
  pure string/JSON in → struct out, fully unit-testable from fixtures.

### 4. Members store (`src/relay/members.ts`)

```ts
export interface MembersStore { salt: string; members: Record<string,string> } // sha256hex -> email
export function loadMembers(path: string): MembersStore;     // {salt:new, members:{}} if absent
export function addMember(path: string, email: string): string;  // returns raw token, persists hash
export function removeMember(path: string, email: string): boolean;
export function listMembers(path: string): string[];         // emails
export function authMember(store: MembersStore, presentedKey: string): string | null; // email | null
```

`addMember` generates the token, hashes `salt||token`, writes the store
(`0600`), returns the raw token. `authMember` hashes the presented key with the
store salt and constant-time-compares against the map.

### 5. Enforcement (`src/relay/enforce.ts`)

```ts
export type RelayReject = { status: 401 | 403; error: string };
export function enforceRelay(args: {
  model: string; policy?: Policy; ledgerPath: string;
  pricing: Record<string, ModelPrice>; now?: Date;
}): RelayReject | null;   // null = allowed
```

- Model allowlist: `policy.models` set and `model` not in it → `{403, "model …
  not in team allowlist"}`.
- Rolling cap: `policy.rollingBudget` set → sum window cost from the relay ledger
  (`readAuditEntries(ledgerPath)` filtered to window, summing `costUsd`); `>=
  maxUsd` → `{403, "team rolling budget reached …"}`. Mirrors `enforcePolicy`'s
  `>=`. (Window spend is **team-wide** in c.1; per-member caps deferred.)
- Auth (401) is handled in the server before enforce; `enforceRelay` covers the
  policy dimensions only.

### 6. Server (`src/relay/server.ts`)

A `RelayServer` class (mirrors `PanelServer`’s shape) over `node:http`:

```
POST /v1/messages   → auth → enforce → proxy(api.anthropic.com) → tee usage → append ledger
GET  /api/v1/usage  → aggregateUsage(relay ledger)   [reuses P5-b]
GET  /healthz       → 200 {ok:true}
```

Proxy mechanics: read `x-api-key` (member token) → `authMember` (401). Read +
buffer the request body (small — a messages payload), parse `model`,
`enforceRelay` (403). Then issue an `https` request to `upstream/v1/messages`
with the **real** key in `x-api-key`, copy through method/headers (minus auth)
and body. Pipe the upstream response status+headers+body straight back to the
member **and** tee the body through a `PassThrough` buffer; on upstream
`end`, parse usage (`content-type: text/event-stream` → `usageFromSse`, else
`usageFromJson`), compute `costUsd`, append a ledger entry. Upstream errors
(4xx/5xx) pass through unchanged and are **not** ledgered as spend (no usage).

The ledger entry (extends `AuditEntry`):
```ts
interface RelayEntry extends AuditEntry {   // ts,user,model,turns,costUsd,status,commit,prompt,stopReason
  inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number;
  unknownPrice?: boolean;   // true when model had no pricing entry → cost is a floor
}
```
`user` = member email; `turns` = 1 (one API call); `commit`/`prompt` = null/""
(the relay sees calls, not runs); `status` = upstream 2xx ? 'success':'error'.

### 7. CLI (`src/cli.ts` / `src/args.ts`)

Add a `relay` command with a subcommand word (like `panel install|serve`):
- `blox relay serve` — loads config (errors clearly if no `relay` block / no key
  in `apiKeyEnv`), starts `RelayServer`, prints the bound URL, runs until SIGINT.
- `blox relay add-member <email>` — prints the token once + a one-line "store it,
  it won't be shown again".
- `blox relay rm-member <email>` / `blox relay list-members`.

`args.ts` parses the `relay` command + its sub-word into `prompt` (same pattern
`panel` uses). Member email is a positional.

## Data flow

```
member blox
  ANTHROPIC_API_KEY=<member-token>  ANTHROPIC_BASE_URL=<relay>
        │  POST /v1/messages  (x-api-key: member-token)
        ▼
   RelayServer ──auth(members.json hash)──► 401?
        │
        ├─enforce(policy.models, rollingBudget vs relay ledger)──► 403?
        │
        ├─proxy──► api.anthropic.com  (x-api-key: REAL team key)
        │             │ streamed/non-streamed response
        ▼             ▼
   member ◄──── verbatim pass-through
        └─ tee ─► usage(input/output/cache) ─► costUsd(pricing) ─► append relay-audit.jsonl
                                                                        │
                                              GET /api/v1/usage ─ aggregateUsage ─► UsageSummary
```

## Error handling

| Case | Behavior |
| --- | --- |
| Unknown / missing `x-api-key` | 401, no proxy |
| Model not in `policy.models` | 403, no proxy |
| Rolling cap reached | 403, no proxy |
| Upstream 4xx/5xx | passed through verbatim; not counted as spend |
| Usage unparseable on a 2xx | append an entry with tokens 0 (cost 0); the response is already served, so this only under-counts that one call — logged, never fails the response |
| Pricing missing for model | cost computed at 0 for that dimension, entry flagged `unknownPrice:true` so the report can surface undercounting |
| Ledger append fails | logged; the already-served response is never failed |
| No `relay` block / no key in env | `relay serve` exits 1 with a clear message |

## Testing

- **pricing** — `costUsd` with/without cache tokens; unknown model → 0 + flag.
- **usage** — `usageFromJson` (full + missing fields); `usageFromSse` (streamed
  fixture with `message_start` + `message_delta`; cache tokens).
- **members** — add → returns token, persists only a hash; auth match/mismatch
  (constant-time); rm revokes; absent file → empty store; file mode `0600`.
- **enforce** — allowlist reject; rolling-cap reject (seeded ledger); absent
  policy → allow; team-wide window sum.
- **server** — against a mock upstream (a local http server standing in for
  api.anthropic.com): 401 unknown token; 403 disallowed model; 403 over cap;
  happy path proxies + appends a ledger entry with correct cost; streamed
  response teed correctly; upstream 500 passes through and is not ledgered;
  `GET /api/v1/usage` returns a summary; real key never leaks to the member.
- **cli/args** — `relay serve|add-member|rm-member|list-members` parse; `serve`
  without a `relay` block exits 1.

## Scope / YAGNI

**In:** single team key; per-member tokens (hashed); model allowlist + rolling
USD cap enforced server-side; pricing table; per-member server-side ledger;
`GET /api/v1/usage`; the four `relay` CLI subcommands.

**Deferred:** OIDC/SSO (c.4); TLS termination (front with nginx/caddy — README
note, not built); rate limiting; per-member individual caps (c.1 cap is
team-wide, attribution is per-member); hosted multi-tenant SaaS (rejected path);
the `blox auth relay` client wiring + rejection surfacing (c.2). The P5-b
`usageView.ts` innerHTML escape (`// P5-c` marker) is paid here, since the relay
serves usage data sourced from member-supplied request bodies.

## Open questions (resolve in planning)

1. **Per-member vs team cap.** c.1 enforces a single team-wide rolling cap.
   Per-member caps are a natural extension (ledger already attributes per member)
   but add config surface — deferred unless trivially cheap during planning.
2. **Streaming tee backpressure.** Teeing the upstream body to both the client
   and a parse buffer must not stall the client if parsing is slow. Plan: the tee
   buffer only accumulates bytes (bounded by response size) and parses once on
   `end`; the client pipe is independent. Revisit if responses can be very large.

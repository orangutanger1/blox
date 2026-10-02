# Release + live-ops behind human gates (pipeline item 8)

Research §K/§R.8/§T: after launch the loop is analytics → findings → config change or
experiment → back to design. Publishing, live config changes and anything touching
monetization are human decisions. blox prepares, verifies and dry-runs; a human
approves; only then does a call with a human-created key go out.

## `release` tool
- `check` — readiness across every deterministic gate blox has: last `run_tests` all
  pass, design sim assertions, FTUE/soak metrics, multiplayer specs, UI lint, store
  presentation lint, asset lint; each ✓ / ✗ / – (not run). Lists the human gates
  (final title/art, monetization, publish approval). Writes `.blox/release-report.json`.
- `build` — `rojo build` the project to `.blox/build/place.rbxl` and records its sha256.
  Note: `world/` builders run in Studio, so a Rojo build lacks them — the report says
  so; publishing from Studio is the human alternative.
- `publish {confirm}` — Place Publishing API (`POST /universes/v1/{u}/places/{p}/versions
  ?versionType=Published`, octet-stream body). Refused unless `release check` is ready,
  `.blox/release-approval.json` approves *this build hash* (`blox release approve`, CLI
  only), `confirm: true`, ids in `.blox/release.json`, and `ROBLOX_OPEN_CLOUD_KEY`.
  Without confirm: dry run.

## `liveops` tool
- `report {from?}` — analytics from a JSON export (`from`, the human-friendly path) or
  the Analytics Query API (`universeId` in release.json; key scope
  `universe.analytics:read`): D1/D7/D30 retention, session length, payer conversion,
  onboarding funnel. Graded against GameAnalytics benchmarks (p50/p75/p90). Findings:
  below-p50 metrics, the worst funnel step (largest drop), mapped to the design levers
  that move them. Writes `.blox/liveops-report.json`.
- `propose` — for the worst finding, deterministic design variants (e.g. first-purchase
  cost ×0.8 for an onboarding drop; offline fraction ×1.25 for D1; rebirth base ×0.85 for
  session length), each simulated; keep variants that pass every assertion and improve
  the target metric. Writes `.blox/proposals/<id>.json` (diff + before/after). Never
  touches monetization entries (human).
- `apply {proposal}` — applies a proposal to `.blox/design.json` + regenerates Tunables
  (local; ships with the next human-approved release).
- `push {kind: config|thumbnails, confirm}` — live Configs from design tunables, or
  presentation thumbnails to the Thumbnail Personalization API. Dry run unless confirm +
  key; monetization-linked keys refused. Endpoint paths for Configs/Thumbnails/Analytics
  are newer APIs, kept in `src/opencloud/endpoints.ts` and marked for verification.

## Verification
Readiness, grading, proposal search and apply are pure and unit-tested; publish/push/
analytics tested only against a fake fetch; `rojo build` exercised when rojo is on PATH.
Nothing here is called with real keys.

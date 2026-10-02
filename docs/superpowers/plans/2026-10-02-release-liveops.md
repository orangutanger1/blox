# Release + live-ops Implementation Plan

> Executed inline (superpowers:executing-plans), TDD per task.

**Spec:** `docs/superpowers/specs/2026-10-02-release-liveops-design.md`

## Tasks
1. `src/release/check.ts` — `releaseCheck(projectPath)` reading every report; `formatRelease`. Tests.
2. `src/opencloud/endpoints.ts` + `OpenCloud.publishPlace`, `queryMetric`, `putConfig`, `uploadThumbnail`; `src/release/publish.ts` (`buildPlace` via rojo, approval bound to hash, gates, dry run). Tests with fake fetch / fake rojo.
3. `src/liveops/analytics.ts` (schema for exports, `fetchAnalytics`, `gradeAnalytics` vs benchmarks) + `src/liveops/propose.ts` (variants + sim) + apply. Tests.
4. Tools `release`, `liveops`; CLI incl. CLI-only `blox release approve`; guide; MCP list. Tests.
5. Verify + PR.

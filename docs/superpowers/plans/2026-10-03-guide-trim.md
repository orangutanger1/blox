# Agent guide trim — Plan

Spec: `docs/superpowers/specs/2026-10-03-guide-trim-design.md`. Branch `guide-trim`.

1. Guard test first: `tests/agentGuide.test.ts` (MUST_KEEP phrases, every tool named, ≤ 5600 chars) → RED on size.
2. Rewrite `src/agentGuide.ts` denser → GREEN; full suite + tsc.

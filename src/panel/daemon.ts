// Model routing: per-request `provider,slug` confirmed working against CCR 2.0.0
// (Task 0, 2026-06-15 — gemini routed without a Router.default rewrite). The
// daemon sends `provider,slug` as the run model; no CCR restart per run.

// src/panel/daemon.ts
import { randomUUID } from 'node:crypto';
import type { PanelServer, PanelController } from './server.js';
import type { CcrModels } from '../ccr.js';

// The daemon's run launcher: emits run_started/run_finished around runOnce.
// Injected so the state machine is unit-testable without a real run.
export interface RunFn {
  (prompt: string, slug: string, runId: string): Promise<void>;
}

export interface ControllerDeps {
  listModels: () => CcrModels;
  run: RunFn;
  newRunId?: () => string;
}

// One run at a time. launch() validates the model against the live CCR list,
// flips state to running, assigns a fresh runId (so the dock resets its event
// cursor), and kicks the injected run — returning to idle when it settles,
// success or failure.
export function createController(
  server: Pick<PanelServer, 'setRunId'>,
  deps: ControllerDeps,
): PanelController {
  let state: 'idle' | 'running' = 'idle';
  const newRunId = deps.newRunId ?? (() => randomUUID());
  return {
    listModels: deps.listModels,
    state: () => state,
    cancel: () => ({ ok: false }), // Phase-1 stretch — see Task 8
    launch(prompt, slug) {
      if (state === 'running') {
        return { ok: false, status: 409, error: 'a run is already in progress' };
      }
      if (!deps.listModels().models.includes(slug)) {
        return { ok: false, status: 400, error: `unknown model: ${slug}` };
      }
      const runId = newRunId();
      state = 'running';
      server.setRunId(runId);
      void deps
        .run(prompt, slug, runId)
        .catch(() => {
          /* run failure is reported via run_finished in the RunFn; swallow here */
        })
        .finally(() => {
          state = 'idle';
        });
      return { ok: true, runId };
    },
  };
}

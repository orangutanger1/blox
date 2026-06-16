// Model routing: per-request `provider,slug` confirmed working against CCR 2.0.0
// (Task 0, 2026-06-15 — gemini routed without a Router.default rewrite). The
// daemon sends `provider,slug` as the run model; no CCR restart per run.

// src/panel/daemon.ts
import { randomUUID } from 'node:crypto';
import { PanelServer } from './server.js';
import type { PanelController } from './server.js';
import { readCcrModels, resolveModel, type CcrModels } from '../ccr.js';
import { runOnce } from '../run.js';
import { buildDigest } from '../context/digest.js';
import { createStudioMcpBridge } from '../bridge/mcpBridge.js';
import { ensureServe } from '../sync/serve.js';
import type { BloxConfig } from '../config.js';

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

// Persistent control server. Builds the digest once, then serves the dock and
// launches a run per POST /api/v1/run. rojo serve is reuse-first per run; CCR
// config is read fresh each time so dropdown + routing reflect edits.
export async function startDaemon(config: BloxConfig): Promise<PanelServer> {
  const digest = buildDigest(config.projectPath);
  const server = new PanelServer({
    runId: 'idle',
    project: digest.name,
    port: config.panel.port,
    gateTimeoutMs: config.panel.gateTimeoutSeconds * 1000,
  });
  await server.start();

  const run: RunFn = async (prompt, slug, runId) => {
    // Reused server → reused gate broker; clear last run's denials/decisions.
    server.gates.reset();
    const ccr = readCcrModels();
    const modelString = resolveModel(ccr.provider, slug);
    const runConfig: BloxConfig = { ...config, model: modelString };
    const bridge = createStudioMcpBridge();
    try {
      await ensureServe(config.projectPath);
    } catch {
      /* serve is non-fatal; the verify loop may see stale files */
    }
    const gate = {
      isConnected: () => server.isConnected(),
      request: (tool: string, input: Record<string, unknown>) => server.gates.request(tool, input),
      requestResult: (tool: string, tag: string | null, inputSummary: string) =>
        server.gates.requestResult(tool, tag, inputSummary),
    };
    server.emit({
      type: 'run_started',
      runId,
      prompt,
      mode: runConfig.mode,
      maxTurns: runConfig.maxTurns,
      maxBudgetUsd: runConfig.maxBudgetUsd,
      model: modelString,
    });
    let report;
    try {
      report = await runOnce(runConfig, prompt, {
        bridge,
        digest,
        gate,
        sink: server,
        dockDeniedTools: () => server.gates.dockDeniedTools(),
        resultDecisions: () => server.gates.resultDecisions(),
      });
    } finally {
      // Always close the run on the dock, even on a thrown runOnce.
      server.emit({
        type: 'run_finished',
        status: report ? report.status : 'error',
        stopReason: report ? report.stopReason ?? 'error' : 'error',
        turns: report ? report.numTurns : 0,
        costUsd: report ? report.costUsd : 0,
      });
    }
  };

  const controller = createController(server, { listModels: () => readCcrModels(), run });
  server.attachController(controller);
  return server;
}

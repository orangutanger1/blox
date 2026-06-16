// Model routing: per-request `provider,slug` confirmed working against CCR 2.0.0
// (Task 0, 2026-06-15 — gemini routed without a Router.default rewrite). The
// daemon sends `provider,slug` as the run model; no CCR restart per run.

// src/panel/daemon.ts
import { randomUUID } from 'node:crypto';
import { PanelServer } from './server.js';
import type { PanelController } from './server.js';
import { readCcrModels, resolveModel, ccrEndpoint, type CcrModels } from '../ccr.js';
import { runOnce } from '../run.js';
import { buildDigest } from '../context/digest.js';
import { createStudioMcpBridge } from '../bridge/mcpBridge.js';
import { ensureServe } from '../sync/serve.js';
import type { BloxConfig } from '../config.js';

// The daemon's run launcher: emits run_started/run_finished around runOnce.
// Injected so the state machine is unit-testable without a real run. The
// AbortController is owned by the controller; aborting it cancels the run.
export interface RunFn {
  (prompt: string, slug: string, runId: string, abortController: AbortController): Promise<void>;
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
  let activeAbort: AbortController | null = null;
  const newRunId = deps.newRunId ?? (() => randomUUID());
  return {
    listModels: deps.listModels,
    state: () => state,
    cancel: () => {
      // Abort the in-flight run's signal; the SDK ends the query, runOnce
      // throws, and the RunFn's finally emits run_finished. No active run → no-op.
      if (!activeAbort) return { ok: false };
      activeAbort.abort();
      return { ok: true };
    },
    launch(prompt, slug) {
      if (state === 'running') {
        return { ok: false, status: 409, error: 'a run is already in progress' };
      }
      if (!deps.listModels().models.includes(slug)) {
        return { ok: false, status: 400, error: `unknown model: ${slug}` };
      }
      const runId = newRunId();
      const abort = new AbortController();
      state = 'running';
      activeAbort = abort;
      server.setRunId(runId);
      void deps
        .run(prompt, slug, runId, abort)
        .catch(() => {
          /* run failure is reported via run_finished in the RunFn; swallow here */
        })
        .finally(() => {
          state = 'idle';
          activeAbort = null;
        });
      return { ok: true, runId };
    },
  };
}

// Env for a daemon run's model call. For a CCR-routed model, point the Agent
// SDK at CCR (ANTHROPIC_BASE_URL) with the x-api-key path and no competing
// bearer token. For a bare model (no CCR provider) return undefined so the run
// uses the inherited env unchanged (same as the one-shot CLI).
export function ccrRunEnv(useCcr: boolean): Record<string, string> | undefined {
  if (!useCcr) return undefined;
  const ep = ccrEndpoint();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.ANTHROPIC_BASE_URL = ep.baseUrl;
  env.ANTHROPIC_API_KEY = ep.apiKey;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
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

  const run: RunFn = async (prompt, slug, runId, abortController) => {
    const ccr = readCcrModels();
    const modelString = resolveModel(ccr.provider, slug);
    const runConfig: BloxConfig = { ...config, model: modelString };
    // A CCR-routed model (`provider,slug`) only routes if the SDK talks to CCR,
    // not api.anthropic.com. Point ANTHROPIC_BASE_URL at CCR for this run. The
    // x-api-key path (ANTHROPIC_API_KEY) is what CCR accepts; clear any inherited
    // AUTH_TOKEN so the SDK doesn't send a competing bearer.
    const env = ccrRunEnv(ccr.provider !== null);
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
        abortController,
        env,
        dockDeniedTools: () => server.gates.dockDeniedTools(),
        resultDecisions: () => server.gates.resultDecisions(),
      });
    } catch (e) {
      // Don't let a run failure die silently — the dock would just show
      // "error — 0 turns" with no reason. Surface it to the daemon terminal and
      // the dock log; run_finished(error) still fires in the finally below.
      const msg = (e as Error)?.message ?? String(e);
      console.error(`[blox] run ${runId.slice(0, 8)} failed: ${msg}`);
      server.emit({ type: 'log', text: `run error: ${msg}` });
    } finally {
      // Close out the run's gates (a cancel may have left one parked) before the
      // terminal event, so a stale timer can't fire into the next run, and clear
      // per-run report state on this reused broker.
      server.gates.reset();
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

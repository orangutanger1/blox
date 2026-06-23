// Model routing: per-request `provider,slug` confirmed working against CCR 2.0.0
// (Task 0, 2026-06-15 — gemini routed without a Router.default rewrite). The
// daemon sends `provider,slug` as the run model; no CCR restart per run.

// src/panel/daemon.ts
import { randomUUID } from 'node:crypto';
import { PanelServer } from './server.js';
import type { PanelController } from './server.js';
import { readCcrModels, resolveModel, type CcrModels } from '../ccr.js';
import { ensureCcr, ccrRunEnv } from '../ccrServe.js';
import { buildAuthEnv, authInfo } from '../auth.js';
import { runOnce } from '../run.js';
import { PolicyError } from '../policy.js';
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
  server.attachAuth(() => authInfo());
  await server.start();

  const run: RunFn = async (prompt, slug, runId, abortController) => {
    const ccr = readCcrModels();
    const modelString = resolveModel(ccr.provider, slug);
    const runConfig: BloxConfig = { ...config, model: modelString };
    const log = (text: string) => server.emit({ type: 'log', text });

    // Emit run_started first so the dock shows the prompt + spinner immediately,
    // before the (possibly slow) CCR/serve setup below — otherwise the dock looks
    // dead for seconds after the user clicks Launch.
    server.emit({
      type: 'run_started',
      runId,
      prompt,
      mode: runConfig.mode,
      maxTurns: runConfig.maxTurns,
      maxBudgetUsd: runConfig.maxBudgetUsd,
      model: modelString,
    });

    // A CCR-routed model (`provider,slug`) only routes if the SDK talks to CCR,
    // not api.anthropic.com. Point ANTHROPIC_BASE_URL at CCR for this run. The
    // x-api-key path (ANTHROPIC_API_KEY) is what CCR accepts; clear any inherited
    // AUTH_TOKEN so the SDK doesn't send a competing bearer.
    const useCcr = ccr.provider !== null;
    if (useCcr) await ensureCcr(log);
    // Direct-Anthropic runs pick the linked credential (subscription vs API key);
    // CCR/BYO-model runs keep their own endpoint + key override.
    const env = useCcr ? ccrRunEnv(true) : buildAuthEnv();
    const bridge = createStudioMcpBridge();
    log('Syncing project to Studio (rojo serve)…');
    try {
      const session = await ensureServe(config.projectPath);
      log(session.mode === 'reused' ? 'rojo serve already running.' : 'rojo serve started.');
    } catch {
      /* serve is non-fatal; the verify loop may see stale files */
      log('rojo serve unavailable — continuing (Studio may see stale files).');
    }
    const gate = {
      isConnected: () => server.isConnected(),
      request: (tool: string, input: Record<string, unknown>) => server.gates.request(tool, input),
      requestResult: (tool: string, tag: string | null, inputSummary: string) =>
        server.gates.requestResult(tool, tag, inputSummary),
    };
    log(`Calling model ${modelString} — waiting for first response…`);
    let report;
    let policyDetail: string | undefined;
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
      if (e instanceof PolicyError) {
        // Policy violations are user-facing configuration errors, not runtime
        // failures. Stash the detail and fall through to the single finally
        // emit (a `return` here would still run finally, double-emitting).
        policyDetail = `policy violation [${e.field}]: ${e.message}`;
      } else {
        // Don't let a run failure die silently — the dock would just show
        // "error — 0 turns" with no reason. Surface it to the daemon terminal and
        // the dock log; run_finished(error) still fires in the finally below.
        const msg = (e as Error)?.message ?? String(e);
        console.error(`[blox] run ${runId.slice(0, 8)} failed: ${msg}`);
        server.emit({ type: 'log', text: `run error: ${msg}` });
      }
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
        detail: report ? undefined : policyDetail,
      });
    }
  };

  const controller = createController(server, { listModels: () => readCcrModels(), run });
  server.attachController(controller);
  return server;
}

// src/run.ts
import { runnerFor, type BloxConfig } from './config.js';
import type { StudioBridge } from './bridge/types.js';
import type { ProjectDigest } from './context/digest.js';
import type { ImageInput } from './agent/imageInput.js';
import type { EventSink } from './panel/events.js';
import type { PanelGateChannel } from './agent/buildOptions.js';
import type { ResultRecord } from './panel/gates.js';
import { buildQueryOptions } from './agent/buildOptions.js';
import { runAgent } from './agent/runAgent.js';
import { runOpenAiAgent } from './agent/openaiRunner.js';
import { runCodexAgent } from './agent/codexRunner.js';
import { syncProject, realSpawn } from './sync/rojo.js';
import { commitChanges } from './git/commit.js';
import type { Billing, RunReport } from './report.js';
import { enforcePolicy } from './policy.js';
import { appendAuditEntry } from './audit.js';
import { renderCommitMessage } from './commitMessage.js';

export interface RunOnceDeps {
  bridge: StudioBridge;
  digest: ProjectDigest;
  gate?: PanelGateChannel;
  sink?: EventSink;
  image?: ImageInput;
  verify?: boolean;
  // Native SDK session continuation, forwarded to buildQueryOptions. Mutually
  // exclusive (the CLI enforces it); resume wins if both are set.
  resume?: string;
  continueSession?: boolean;
  dockDeniedTools?: () => string[];
  resultDecisions?: () => ResultRecord[];
  abortController?: AbortController;
  // Env overrides for the agent's model call (the daemon points ANTHROPIC_BASE_URL
  // at CCR so a `provider,slug` model routes per-request). Merged over process.env.
  env?: Record<string, string>;
  // The Anthropic credential mode the caller resolved (subscription / API key /
  // relay) — labels the cost of Claude-runner runs. Omitted: not reported.
  authMode?: Exclude<Billing, 'provider'>;
}

const FALLBACK_PREAMBLE =
  'A previous agent ran out of usage partway through this task. Files on disk and Studio may already ' +
  'hold part of the work: check status and the relevant files first, keep what is right, then finish.\n\nTask: ';

async function gitUserEmail(projectPath: string): Promise<string> {
  try {
    const r = await realSpawn('git', ['config', 'user.email'], { cwd: projectPath });
    return r.stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// The shared run pipeline: build options → run the agent → sync to disk →
// commit → assemble the report. Callers own everything around it (digest,
// bridge, rojo serve, panel lifecycle, run_started/run_finished emits, exit
// codes). Used by both the CLI one-shot and the panel daemon.
export async function runOnce(config: BloxConfig, prompt: string, deps: RunOnceDeps): Promise<RunReport> {
  enforcePolicy(config); // throws PolicyError on violation, before any agent/model work

  const openaiRun = (cfg: BloxConfig, p: string, session: { resume?: string; continueSession?: boolean } = {}) => {
    const ctx = deps.bridge.toolCtx;
    if (!ctx) throw new Error('--runner openai needs the blox toolset (a real Studio session, not --mock)');
    return runOpenAiAgent(p, cfg, ctx, deps.digest, {
      image: deps.image,
      verify: deps.verify,
      sink: deps.sink,
      gate: deps.gate,
      abortController: deps.abortController,
      ...session,
    });
  };

  let agent;
  if (runnerFor(config) === 'codex') {
    const ctx = deps.bridge.toolCtx;
    if (!ctx) throw new Error('--runner codex needs the blox toolset (a real Studio session, not --mock)');
    agent = await runCodexAgent(prompt, config, ctx, deps.digest, {
      image: deps.image,
      verify: deps.verify,
      sink: deps.sink,
      gate: deps.gate,
      abortController: deps.abortController,
    });
  } else if (runnerFor(config) === 'openai') {
    agent = await openaiRun(config, prompt, { resume: deps.resume, continueSession: deps.continueSession });
  } else {
    const options = buildQueryOptions(config, deps.bridge, deps.digest, deps.gate, {
      image: !!deps.image,
      verify: deps.verify,
      resume: deps.resume,
      continueSession: deps.continueSession,
    });
    agent = await runAgent(prompt, options, {
      sink: deps.sink,
      dockDeniedTools: deps.dockDeniedTools,
      image: deps.image,
      abortController: deps.abortController,
      env: deps.env,
    });
  }

  // Subscription out of usage: finish the task on the fallback model. The
  // relay is excluded (it bills a team key, and openai runs would bypass it).
  let fallbackFrom: RunReport['fallbackFrom'];
  if (agent.stopReason === 'usage-limit' && config.fallbackModel && deps.authMode !== 'relay' && deps.bridge.toolCtx) {
    const next: BloxConfig = { ...config, model: config.fallbackModel, runner: 'openai' };
    let allowed = true;
    try {
      enforcePolicy(next);
    } catch (e) {
      allowed = false;
      agent = { ...agent, detail: `${agent.detail}; fallback ${next.model} refused: ${(e as Error).message}` };
    }
    if (allowed) {
      fallbackFrom = { model: config.model, turns: agent.numTurns, detail: agent.detail };
      try {
        deps.sink?.emit({ type: 'log', text: `${config.model}: ${agent.detail} — continuing on ${next.model}` });
      } catch {
        /* observability only */
      }
      config = next;
      agent = await openaiRun(config, FALLBACK_PREAMBLE + prompt);
    }
  } else if (agent.stopReason === 'usage-limit' && !config.fallbackModel) {
    agent = { ...agent, detail: `${agent.detail} (set fallbackModel in blox.config.json, or --fallback-model, to finish on another model)` };
  }
  const sync = await syncProject(config.projectPath);

  const user = await gitUserEmail(config.projectPath);
  const date = new Date().toISOString().slice(0, 10);
  const message = renderCommitMessage(config.policy?.commitConvention, {
    prompt, user, model: config.model, date,
  }).slice(0, 72);
  const commit = sync.ok
    ? await commitChanges(config.projectPath, message)
    : { sha: null, files: [] };

  const status = agent.status === 'success' && sync.ok ? 'success' : 'error';
  // The Agent SDK prices a CCR-routed "provider,slug" model at Claude rates
  // (observed ~500x too high for GPT-6 Luna); don't ledger that as spend.
  if (runnerFor(config) === 'claude' && config.model.includes(',')) {
    agent = { ...agent, costUsd: 0, costUnknown: true };
  }
  const routedOrOpenai = runnerFor(config) === 'openai' || (runnerFor(config) === 'claude' && config.model.includes(','));
  // Codex runs are billed to the user's ChatGPT plan.
  const billing: Billing | undefined = runnerFor(config) === 'codex' ? 'subscription' : routedOrOpenai ? 'provider' : deps.authMode;
  const cost = {
    ...(agent.costUnknown ? { costUsd: 0, costUnknown: true as const } : { costUsd: agent.costUsd }),
    ...(billing ? { billing } : {}),
  };

  try {
    appendAuditEntry(config.projectPath, {
      ts: new Date().toISOString(),
      user, model: config.model, turns: agent.numTurns, ...cost,
      status, commit: commit.sha, prompt, stopReason: agent.stopReason,
    });
  } catch (e) {
    console.warn(`blox: failed to write audit ledger: ${(e as Error).message}`);
  }

  return {
    prompt,
    changedFiles: commit.files,
    commitSha: commit.sha,
    numTurns: agent.numTurns,
    ...cost,
    model: config.model,
    ...(fallbackFrom ? { fallbackFrom } : {}),
    ...(agent.tokens ? { tokens: agent.tokens } : {}),
    status,
    stopReason: agent.stopReason,
    detail: sync.ok ? agent.detail : sync.detail,
    ...(agent.finalText ? { finalText: agent.finalText } : {}),
    mode: config.mode,
    effort: config.effort,
    sessionId: agent.sessionId,
    gatedActions: agent.gatedActions,
    deniedByUser: agent.deniedByUser,
    nonGatedDenials: agent.nonGatedDenials,
    assetDecisions: deps.resultDecisions?.(),
  };
}

// src/run.ts
import type { BloxConfig } from './config.js';
import type { StudioBridge } from './bridge/types.js';
import type { ProjectDigest } from './context/digest.js';
import type { ImageInput } from './agent/imageInput.js';
import type { EventSink } from './panel/events.js';
import type { PanelGateChannel } from './agent/buildOptions.js';
import type { ResultRecord } from './panel/gates.js';
import { buildQueryOptions } from './agent/buildOptions.js';
import { runAgent } from './agent/runAgent.js';
import { syncProject, realSpawn } from './sync/rojo.js';
import { commitChanges } from './git/commit.js';
import type { RunReport } from './report.js';
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
}

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

  const options = buildQueryOptions(config, deps.bridge, deps.digest, deps.gate, {
    image: !!deps.image,
    verify: deps.verify,
    resume: deps.resume,
    continueSession: deps.continueSession,
  });
  const agent = await runAgent(prompt, options, {
    sink: deps.sink,
    dockDeniedTools: deps.dockDeniedTools,
    image: deps.image,
    abortController: deps.abortController,
    env: deps.env,
  });
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

  try {
    appendAuditEntry(config.projectPath, {
      ts: new Date().toISOString(),
      user, model: config.model, turns: agent.numTurns, costUsd: agent.costUsd,
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
    costUsd: agent.costUsd,
    status,
    stopReason: agent.stopReason,
    detail: sync.ok ? agent.detail : sync.detail,
    mode: config.mode,
    effort: config.effort,
    sessionId: agent.sessionId,
    gatedActions: agent.gatedActions,
    deniedByUser: agent.deniedByUser,
    nonGatedDenials: agent.nonGatedDenials,
    assetDecisions: deps.resultDecisions?.(),
  };
}

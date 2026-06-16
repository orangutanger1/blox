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
import { syncProject } from './sync/rojo.js';
import { commitChanges } from './git/commit.js';
import type { RunReport } from './report.js';

export interface RunOnceDeps {
  bridge: StudioBridge;
  digest: ProjectDigest;
  gate?: PanelGateChannel;
  sink?: EventSink;
  image?: ImageInput;
  verify?: boolean;
  dockDeniedTools?: () => string[];
  resultDecisions?: () => ResultRecord[];
  abortController?: AbortController;
}

// The shared run pipeline: build options → run the agent → sync to disk →
// commit → assemble the report. Callers own everything around it (digest,
// bridge, rojo serve, panel lifecycle, run_started/run_finished emits, exit
// codes). Used by both the CLI one-shot and the panel daemon.
export async function runOnce(config: BloxConfig, prompt: string, deps: RunOnceDeps): Promise<RunReport> {
  const options = buildQueryOptions(config, deps.bridge, deps.digest, deps.gate, {
    image: !!deps.image,
    verify: deps.verify,
  });
  const agent = await runAgent(prompt, options, {
    sink: deps.sink,
    dockDeniedTools: deps.dockDeniedTools,
    image: deps.image,
    abortController: deps.abortController,
  });
  const sync = await syncProject(config.projectPath);
  const commit = sync.ok
    ? await commitChanges(config.projectPath, `blox: ${prompt}`.slice(0, 72))
    : { sha: null, files: [] };
  return {
    prompt,
    changedFiles: commit.files,
    commitSha: commit.sha,
    numTurns: agent.numTurns,
    costUsd: agent.costUsd,
    status: agent.status === 'success' && sync.ok ? 'success' : 'error',
    stopReason: agent.stopReason,
    detail: sync.ok ? agent.detail : sync.detail,
    mode: config.mode,
    effort: config.effort,
    sessionId: agent.sessionId,
    gatedActions: agent.gatedActions,
    deniedByUser: agent.deniedByUser,
    assetDecisions: deps.resultDecisions?.(),
  };
}

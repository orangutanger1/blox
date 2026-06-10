#!/usr/bin/env node
import { parseArgs, type ParsedArgs } from './args.js';
import { loadConfig, overridesFromArgs } from './config.js';
import { buildDigest } from './context/digest.js';
import { syncProject } from './sync/rojo.js';
import { commitChanges } from './git/commit.js';
import { createStudioMcpBridge, studioLauncher } from './bridge/mcpBridge.js';
import { createMockStudioBridge } from './bridge/mockBridge.js';
import { buildQueryOptions } from './agent/buildOptions.js';
import { runAgent } from './agent/runAgent.js';
import { runDoctor, formatDoctorReport } from './doctor.js';
import { checkRojoServe, rojoServeUrl, formatServeCheck } from './sync/serveCheck.js';
import { ensureServe, stopServe, registerServeTeardown, type ServeSession } from './sync/serve.js';
import { formatReport, type RunReport } from './report.js';

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const { command, prompt, mock, projectPath } = args;

  if (command === 'doctor') {
    const report = await runDoctor(studioLauncher());
    console.log(formatDoctorReport(report));
    const serve = await checkRojoServe(rojoServeUrl());
    console.log(formatServeCheck(serve));
    process.exit(report.connected ? 0 : 1);
  }

  if (command === 'serve') {
    const cwd = projectPath ?? process.cwd();
    const config = loadConfig(cwd, projectPath ? { projectPath } : {});
    const session = await ensureServe(config.projectPath);
    if (session.mode === 'reused') {
      console.log(`rojo serve already running at ${session.url} — nothing to manage`);
      process.exit(0);
    }
    console.log(`rojo serve up on :${session.port} (${session.url})`);
    console.log("→ click Connect in Studio's Rojo plugin to start syncing");
    console.log('   (Ctrl-C to stop)');
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      process.on('SIGINT', done);
      process.on('SIGTERM', done);
    });
    await stopServe(session);
    process.exit(0);
  }

  if (!prompt) {
    console.error('usage: blox "<prompt>" [--mock] [--project <dir>]  |  blox doctor');
    process.exit(2);
  }

  const cwd = projectPath ?? process.cwd();
  const config = loadConfig(cwd, overridesFromArgs(args));
  const digest = buildDigest(config.projectPath);
  const bridge = mock ? createMockStudioBridge() : createStudioMcpBridge();
  const options = buildQueryOptions(config, bridge, digest);

  // Mock runs never touch real Studio/serve. Real runs ensure the rojo serve
  // sync channel is up (reuse-first); a serve failure is non-fatal — the run
  // proceeds but the agent's verify loop may see stale files.
  let session: ServeSession | null = null;
  if (!mock) {
    try {
      session = await ensureServe(config.projectPath);
      if (session.mode === 'spawned') {
        registerServeTeardown(session);
        console.log(`rojo serve up on :${session.port} — click Connect in Studio's Rojo plugin`);
      }
    } catch (e) {
      console.error(`warning: could not start rojo serve: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  try {
    const agent = await runAgent(prompt, options);
    const sync = await syncProject(config.projectPath);
    const commit = sync.ok
      ? await commitChanges(config.projectPath, `blox: ${prompt}`.slice(0, 72))
      : { sha: null, files: [] };

    const report: RunReport = {
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
    };
    console.log(formatReport(report));
    process.exitCode = report.status === 'success' ? 0 : 1;
  } finally {
    if (session) await stopServe(session);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

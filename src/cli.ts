#!/usr/bin/env node
import { parseArgs, type ParsedArgs } from './args.js';
import { loadConfig, overridesFromArgs } from './config.js';
import { buildDigest } from './context/digest.js';
import { createStudioMcpBridge, studioLauncher } from './bridge/mcpBridge.js';
import { createMockStudioBridge } from './bridge/mockBridge.js';
import { loadImageFromFile, type ImageInput } from './agent/imageInput.js';
import { runDoctor, formatDoctorReport } from './doctor.js';
import { checkRojoServe, rojoServeUrl, formatServeCheck } from './sync/serveCheck.js';
import { ensureServe, stopServe, registerServeTeardown, type ServeSession } from './sync/serve.js';
import { formatReport } from './report.js';
import { runOnce } from './run.js';
import { basename } from 'node:path';
import { pullScripts, mockPulledScripts } from './onboard/pull.js';
import { planLayout } from './onboard/layout.js';
import { writePlan } from './onboard/write.js';
import { formatOnboardReport } from './onboard/report.js';
import { PanelServer } from './panel/server.js';
import { studioPluginsDir, installPanel } from './panel/install.js';
import { startDaemon } from './panel/daemon.js';
import { randomUUID } from 'node:crypto';

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

  if (command === 'init') {
    const dir = projectPath ?? process.cwd();
    const strategy = args.onConflict ?? 'abort';
    const name = basename(dir) || 'blox-game';
    let scripts;
    try {
      scripts = mock ? mockPulledScripts() : await pullScripts(studioLauncher());
    } catch (e) {
      console.error(`blox init failed: ${(e as Error).message}`);
      process.exit(1);
    }
    const plan = planLayout(scripts, strategy, name);
    const result = await writePlan(dir, plan, { force: args.force });
    if (result.refused) {
      console.error(`default.project.json already exists in ${dir} — re-run with --force to overwrite`);
      process.exit(1);
    }
    console.log(
      formatOnboardReport({
        written: result.written,
        baselineSha: result.baselineSha,
        renamed: plan.renamed,
        conflicts: plan.conflicts,
      }),
    );
    process.exit(plan.conflicts.length > 0 ? 1 : 0);
  }

  if (command === 'panel') {
    if (prompt === 'serve') {
      const cwd = projectPath ?? process.cwd();
      const config = loadConfig(cwd, projectPath ? { projectPath } : {});
      const server = await startDaemon(config);
      console.log(`blox panel daemon on :${config.panel.port} — open the blox dock in Studio`);
      console.log('   (Ctrl-C to stop)');
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        process.on('SIGINT', done);
        process.on('SIGTERM', done);
      });
      await server.stop();
      process.exit(0);
    }
    if (prompt !== 'install') {
      console.error('usage: blox panel install | blox panel serve');
      process.exit(2);
    }
    try {
      const dir = await studioPluginsDir();
      const dest = await installPanel({ pluginsDir: dir });
      console.log(`blox panel installed → ${dest}`);
      console.log('→ in Studio: Plugins toolbar → blox → blox panel (enable HttpService requests if prompted)');
      process.exit(0);
    } catch (e) {
      console.error(`panel install failed: ${(e as Error).message}`);
      console.error('hint: set BLOX_STUDIO_PLUGINS_DIR to your Studio plugins folder and re-run');
      process.exit(1);
    }
  }

  if (!prompt) {
    console.error(
      'usage: blox "<prompt>" [--mock] [--project <dir>] [--auto|--ask] [--max-turns <N>] [--budget <USD>] [--effort high|xhigh] [--image <path>|--image-from-dock] [--verify]  |  blox doctor  |  blox init [--on-conflict abort|suffix] [--force]  |  blox panel install  |  blox panel serve',
    );
    process.exit(2);
  }

  const cwd = projectPath ?? process.cwd();
  const config = loadConfig(cwd, overridesFromArgs(args));
  const digest = buildDigest(config.projectPath);
  const bridge = mock ? createMockStudioBridge() : createStudioMcpBridge();

  // --image: read from disk now so a bad path fails before any model call.
  let image: ImageInput | undefined;
  if (args.imagePath) {
    try {
      image = loadImageFromFile(args.imagePath);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
  }

  // Panel server: a window into the run for the Studio dock plugin. Never
  // blocks or fails the run — startup errors degrade to a headless run with
  // today's gating behavior. Mock runs skip it (fixed port vs parallel tests).
  const runId = randomUUID();
  let panel: PanelServer | null = null;
  if (!mock) {
    try {
      const p = new PanelServer({
        runId,
        project: digest.name,
        port: config.panel.port,
        gateTimeoutMs: config.panel.gateTimeoutSeconds * 1000,
      });
      await p.start();
      panel = p;
    } catch (e) {
      console.error(`warning: panel server failed to start: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  // --image-from-dock: ask the connected dock to upload a reference image.
  if (args.imageFromDock) {
    if (!panel) {
      console.error('--image-from-dock needs the panel server (unavailable in --mock or after a panel start failure)');
      process.exit(2);
    }
    console.log('waiting for a reference image — click "Pick image" in the blox Studio panel…');
    try {
      image = await panel.requestImage();
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
  }

  const gate = panel
    ? {
        isConnected: () => panel!.isConnected(),
        request: (tool: string, input: Record<string, unknown>) => panel!.gates.request(tool, input),
        requestResult: (tool: string, tag: string | null, inputSummary: string) =>
          panel!.gates.requestResult(tool, tag, inputSummary),
      }
    : undefined;

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
    panel?.emit({
      type: 'run_started',
      runId,
      prompt,
      mode: config.mode,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      model: config.model,
    });
    const report = await runOnce(config, prompt, {
      bridge,
      digest,
      gate,
      sink: panel ?? undefined,
      image,
      verify: args.verify,
      dockDeniedTools: panel ? () => panel!.gates.dockDeniedTools() : undefined,
      resultDecisions: panel ? () => panel!.gates.resultDecisions() : undefined,
    });
    panel?.emit({
      type: 'run_finished',
      status: report.status,
      stopReason: report.stopReason ?? '',
      turns: report.numTurns,
      costUsd: report.costUsd,
    });
    console.log(formatReport(report));
    process.exitCode = report.status === 'success' ? 0 : 1;
  } finally {
    if (session) await stopServe(session);
    if (panel) await panel.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

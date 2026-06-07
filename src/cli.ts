#!/usr/bin/env node
import { parseArgs } from './args.js';
import { loadConfig } from './config.js';
import { buildDigest } from './context/digest.js';
import { syncProject } from './sync/rojo.js';
import { commitChanges } from './git/commit.js';
import { createStudioMcpBridge } from './bridge/mcpBridge.js';
import { createMockStudioBridge } from './bridge/mockBridge.js';
import { buildQueryOptions } from './agent/buildOptions.js';
import { runAgent } from './agent/runAgent.js';
import { formatReport, type RunReport } from './report.js';

async function main(): Promise<void> {
  const { prompt, mock, projectPath } = parseArgs(process.argv.slice(2));
  if (!prompt) {
    console.error('usage: blox "<prompt>" [--mock] [--project <dir>]');
    process.exit(2);
  }

  const cwd = projectPath ?? process.cwd();
  const config = loadConfig(cwd, projectPath ? { projectPath } : {});
  const digest = buildDigest(config.projectPath);
  const bridge = mock ? createMockStudioBridge() : createStudioMcpBridge();
  const options = buildQueryOptions(config, bridge, digest);

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
    detail: sync.ok ? agent.detail : sync.detail,
  };
  console.log(formatReport(report));
  process.exit(report.status === 'success' ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

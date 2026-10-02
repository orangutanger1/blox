import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, setupAgent } from '../cliTools.js';
import { StudioSession } from '../studio/session.js';
import { resolveStudioLaunch } from '../studio/launcher.js';
import { formatBenchMarkdown, runBench, validateTasks, type AgentSpec } from './harness.js';

// blox bench — see harness.ts. Agent profiles:
//   blox          this checkout's built-in runner (blox "<prompt>"); --runner openai
//                 runs it on the vendor-neutral loop (needs --model)
//   legacy        another blox checkout's runner: --legacy-cli <path/to/dist/cli.js>
//   claude-code   `claude -p` with this checkout's blox MCP server wired in
//   openai        dist/bench/openaiAgent.js: any OpenAI-compatible endpoint
//                 (OPENAI_BASE_URL, default OpenRouter) + blox MCP; needs --model
//   custom        --agent-cmd '["prog","arg","{prompt}"]' ({project}, {promptFile})

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function agentSpec(name: string, o: Record<string, string | boolean>): AgentSpec {
  const budget = typeof o.budget === 'string' ? o.budget : '4';
  const turns = typeof o['max-turns'] === 'string' ? o['max-turns'] : '60';
  const modelId = typeof o.model === 'string' ? o.model : undefined;
  const model = modelId ? ['--model', modelId] : [];
  const runner = typeof o.runner === 'string' ? o.runner : undefined;
  const runnerArgs = ['--project', '{project}', '--auto', '--budget', budget, '--max-turns', turns, ...model, '{prompt}'];
  if (name === 'blox') {
    const argv = [process.execPath, join(repoRoot, 'dist', 'cli.js'), ...(runner ? ['--runner', runner] : []), ...runnerArgs];
    return { name: `blox${runner ? ` --runner ${runner}` : ''} (${repoRoot})`, model: modelId, argv };
  }
  if (name === 'legacy') {
    const cli = o['legacy-cli'];
    if (typeof cli !== 'string') throw new Error('--agent legacy needs --legacy-cli <path to old dist/cli.js>');
    // The legacy launcher trusts mcp.bat, which a Studio auto-update can leave
    // pointing at a deleted version dir. --legacy-launch-fix hands it the
    // resolved StudioMCP.exe so the rest of its pipeline can be measured.
    const env = o['legacy-launch-fix'] ? { BLOX_STUDIO_MCP_CMD: resolveStudioLaunch().command } : undefined;
    return { name: `legacy (${cli})${env ? ' +launch-fix' : ''}`, model: modelId, argv: [process.execPath, cli, ...runnerArgs], env };
  }
  if (name === 'claude-code') {
    return {
      name: 'claude-code + blox MCP',
      model: modelId,
      argv: ['claude', '-p', '{prompt}', '--mcp-config', '{project}/.mcp.json', '--strict-mcp-config',
        '--permission-mode', 'bypassPermissions', '--max-turns', turns, '--output-format', 'stream-json', '--verbose', ...model],
      cwdIsProject: true,
      env: { BLOX_AGENT_NAME: 'claude-code' },
      // claude -p prefers an API key in the env over its stored login.
      billing: process.env.ANTHROPIC_API_KEY ? 'apiKey' : 'subscription',
      prepare: (wd) => { setupAgent('claude', wd); },
    };
  }
  if (name === 'openai') {
    if (!modelId) throw new Error('--agent openai needs --model <provider model id>');
    return {
      name: `openai-compat agent + blox MCP`,
      model: modelId,
      argv: [process.execPath, join(repoRoot, 'dist', 'bench', 'openaiAgent.js'), '--project', '{project}', '--model', modelId,
        '--max-turns', turns, '--budget', budget, '{prompt}'],
    };
  }
  if (name === 'custom') {
    const cmd = o['agent-cmd'];
    if (typeof cmd !== 'string') throw new Error('--agent custom needs --agent-cmd \'["prog","{prompt}"]\'');
    return { name: `custom ${cmd}`, model: modelId, argv: JSON.parse(cmd) as string[], cwdIsProject: true };
  }
  throw new Error(`unknown agent "${name}" (blox | legacy | claude-code | openai | custom)`);
}

export async function runBenchCommand(argv: string[]): Promise<void> {
  const f = parseFlags(argv);
  const o = f.opts;
  const root = resolve(typeof o.root === 'string' ? o.root : join(repoRoot, 'bench'));
  const tasks = typeof o.tasks === 'string' ? o.tasks.split(',') : undefined;
  const session = new StudioSession({ match: process.env.BLOX_STUDIO || (typeof o.studio === 'string' ? o.studio : undefined) });
  try {
    if (o.validate) {
      const v = await validateTasks(session, root, tasks);
      const out = join(root, 'results', 'validation.json');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), tasks: v }, null, 2));
      console.log(`${v.filter((x) => x.valid).length}/${v.length} tasks valid → ${out}`);
      process.exitCode = v.every((x) => x.valid) ? 0 : 1;
      return;
    }
    const agentName = typeof o.agent === 'string' ? o.agent : 'blox';
    const agent = agentSpec(agentName, o);
    const label = typeof o.label === 'string' ? o.label : `${agentName}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
    const dir = join(root, 'results');
    mkdirSync(dir, { recursive: true });
    const save = (r: Parameters<typeof formatBenchMarkdown>[0]) => {
      writeFileSync(join(dir, `${label}.json`), JSON.stringify(r, null, 2));
      writeFileSync(join(dir, `${label}.md`), formatBenchMarkdown(r));
    };
    const report = await runBench(session, {
      root, label, agent, tasks, onRun: save,
      repeat: typeof o.repeat === 'string' ? Number(o.repeat) : 1,
      timeoutSec: typeof o.timeout === 'string' ? Number(o.timeout) : 1800,
      evaluateSynced: !o['no-synced'],
    });
    save(report);
    console.log(formatBenchMarkdown(report));
    console.log(`results → ${join(dir, `${label}.json`)}`);
  } finally {
    await session.close();
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { TOOLS, findTool, invokeTool, type ToolCtx } from './tools/registry.js';
import { serveMcp, studioSessionFor } from './mcp/server.js';
import { scaffoldProject } from './scaffold.js';
import { AGENT_GUIDE } from './agentGuide.js';
import { approveAsset } from './assets/manifest.js';
import { approveRelease } from './release/publish.js';

// CLI front-end for the blox toolset. Every command maps onto the same tool
// registry the MCP server exposes, so an agent without MCP (or a human, or CI)
// gets the identical contract:  blox <tool> [flags]  |  blox tool <name> '<json>'.

interface Flags {
  project?: string;
  rest: string[];
  opts: Record<string, string | boolean>;
}

export function parseFlags(argv: string[]): Flags {
  const f: Flags = { rest: [], opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') f.project = argv[++i];
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        f.opts[k] = next;
        i++;
      } else f.opts[k] = true;
    } else f.rest.push(a);
  }
  return f;
}

function vec(s: string | boolean | undefined): [number, number, number] | undefined {
  if (typeof s !== 'string') return undefined;
  const p = s.split(',').map(Number);
  return p.length === 3 && p.every(Number.isFinite) ? (p as [number, number, number]) : undefined;
}

// Translate friendly CLI flags into tool args.
export function cliArgs(cmd: string, f: Flags): { tool: string; args: Record<string, unknown> } | null {
  const o = f.opts;
  switch (cmd) {
    case 'status':
      return { tool: 'status', args: {} };
    case 'sync':
      return { tool: 'sync', args: { ...(o.force ? { force: true } : {}) } };
    case 'test':
      return {
        tool: 'run_tests',
        args: {
          ...(f.rest[0] ? { filter: f.rest[0] } : {}),
          ...(typeof o.context === 'string' ? { contexts: o.context.split(',') } : {}),
          ...(o['no-sync'] ? { sync: false } : {}),
        },
      };
    case 'playtest':
      return {
        tool: 'playtest',
        args: {
          ...(typeof o.seconds === 'string' ? { seconds: Number(o.seconds) } : {}),
          ...(typeof o.server === 'string' ? { server_code: o.server } : {}),
          ...(typeof o.client === 'string' ? { client_code: o.client } : {}),
          ...(o.screenshot ? { screenshot: true } : {}),
          ...(vec(o.camera) ? { camera_position: vec(o.camera) } : {}),
          ...(vec(o['look-at']) ? { look_at: vec(o['look-at']) } : {}),
          ...(o['keep-running'] ? { keep_running: true } : {}),
        },
      };
    case 'luau':
      return { tool: 'run_luau', args: { code: f.rest.join(' '), ...(typeof o.context === 'string' ? { context: o.context } : {}) } };
    case 'play':
      return { tool: 'play', args: { action: f.rest[0] ?? 'state' } };
    case 'logs':
      return { tool: 'logs', args: { ...(typeof o.context === 'string' ? { context: o.context } : {}), ...(typeof o.since === 'string' ? { since_seconds: Number(o.since) } : {}) } };
    case 'screenshot':
      return { tool: 'screenshot', args: { ...(vec(o.camera) ? { camera_position: vec(o.camera) } : {}), ...(vec(o['look-at']) ? { look_at: vec(o['look-at']) } : {}) } };
    case 'task':
      return { tool: 'task', args: f.rest[0] ? JSON.parse(f.rest.join(' ')) : { action: 'get' } };
    case 'design': {
      const action = f.rest[0] ?? 'get';
      if (action === 'set') return { tool: 'design', args: { action, doc: JSON.parse(f.rest.slice(1).join(' ')) } };
      return {
        tool: 'design',
        args: {
          action,
          ...(typeof o.runs === 'string' ? { runs: Number(o.runs) } : {}),
          ...(typeof o.horizon === 'string' ? { horizon: Number(o.horizon) } : {}),
          ...(typeof o.seed === 'string' ? { seed: Number(o.seed) } : {}),
          ...(typeof o.archetypes === 'string' ? { archetypes: o.archetypes.split(',') } : {}),
        },
      };
    }
    case 'check':
      return { tool: 'check', args: o.fix === true ? { fix: true } : {} };
    case 'kit':
      return f.rest[0] === 'apply' ? { tool: 'kit', args: { action: 'apply', name: f.rest[1] } } : { tool: 'kit', args: { action: 'list' } };
    case 'metrics':
      return {
        tool: 'metrics',
        args: {
          action: f.rest[0] ?? 'ftue',
          ...(typeof o.seconds === 'string' ? { seconds: Number(o.seconds) } : {}),
          ...(typeof o.bot === 'string' ? { bot: o.bot } : {}),
          ...(typeof o.archetype === 'string' ? { archetype: o.archetype } : {}),
          ...(typeof o.tolerance === 'string' ? { tolerance: Number(o.tolerance) } : {}),
        },
      };
    case 'ui':
      return {
        tool: 'ui',
        args: {
          action: f.rest[0] ?? 'lint',
          ...(typeof o.seconds === 'string' ? { seconds: Number(o.seconds) } : {}),
          ...(typeof o.prepare === 'string' ? { prepare: o.prepare } : {}),
          ...(typeof o.devices === 'string' ? { devices: o.devices.split(',') } : {}),
        },
      };
    case 'present': {
      const action = f.rest[0] ?? 'get';
      if (action === 'set') return { tool: 'present', args: { action, doc: JSON.parse(f.rest.slice(1).join(' ')) } };
      return { tool: 'present', args: { action, ...(typeof o.shots === 'string' ? { ids: o.shots.split(',') } : {}) } };
    }
    case 'multiplayer':
      return {
        tool: 'multiplayer',
        args: {
          ...(f.rest[0] ? { filter: f.rest[0] } : {}),
          ...(typeof o.clients === 'string' ? { clients: Number(o.clients) } : {}),
          ...(typeof o.timeout === 'string' ? { timeout: Number(o.timeout) } : {}),
        },
      };
    case 'model': {
      const action = f.rest[0] ?? 'list';
      const id = f.rest[1];
      const list = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).split(',').map((x) => x.trim()).filter(Boolean) : undefined);
      switch (action) {
        case 'brief':
          return {
            tool: 'model',
            args: {
              action, id,
              prompt: typeof o.prompt === 'string' ? o.prompt : f.rest.slice(2).join(' '),
              ...(typeof o.style === 'string' ? { style: o.style } : {}),
              ...(typeof o.tris === 'string' ? { tris: Number(o.tris) } : {}),
              ...(o.rig === true ? { rig: true } : {}),
              ...(list('anims') ? { animations: list('anims') } : {}),
              ...(list('refs') ? { refs: list('refs') } : {}),
            },
          };
        case 'run':
          // blox model run <id> <build.py>
          return { tool: 'model', args: { action, id, code: f.rest[2] ? readFileSync(f.rest[2], 'utf8') : '' } };
        case 'preview':
          return { tool: 'model', args: { action, id, ...(typeof o.at === 'string' ? { at: (o.at as string).split(',').map(Number) } : {}) } };
        default:
          return { tool: 'model', args: { action, ...(id ? { id } : {}) } };
      }
    }
    case 'asset': {
      const action = f.rest[0] ?? 'list';
      const num = (k: string) => (typeof o[k] === 'string' ? { [k]: Number(o[k]) } : {});
      switch (action) {
        case 'add':
          return { tool: 'asset', args: { action, entry: JSON.parse(f.rest.slice(1).join(' ')) } };
        case 'sanitize':
          return { tool: 'asset', args: { action, path: f.rest[1], ...(typeof o.id === 'string' ? { id: o.id } : {}), ...(typeof o['asset-id'] === 'string' ? { asset_id: Number(o['asset-id']) } : {}), ...(o['keep-scripts'] === true ? { keep_scripts: true } : {}) } };
        case 'normalize':
          return { tool: 'asset', args: { action, file: f.rest[1], ...(typeof o.out === 'string' ? { out: o.out } : {}), ...num('tris'), ...num('height'), ...(typeof o.id === 'string' ? { id: o.id } : {}) } };
        case 'upload':
          return { tool: 'asset', args: { action, id: f.rest[1], ...(o.confirm === true ? { confirm: true } : {}) } };
        default:
          return { tool: 'asset', args: { action } };
      }
    }
    case 'release':
      return { tool: 'release', args: { action: f.rest[0] ?? 'check', ...(o.confirm === true ? { confirm: true } : {}) } };
    case 'liveops': {
      const action = f.rest[0] ?? 'report';
      return {
        tool: 'liveops',
        args: {
          action,
          ...(typeof o.from === 'string' ? { from: o.from } : {}),
          ...(typeof o.finding === 'string' ? { finding: o.finding } : {}),
          ...(action === 'apply' && f.rest[1] ? { proposal: f.rest[1] } : {}),
          ...(action === 'push' && f.rest[1] ? { kind: f.rest[1] } : {}),
          ...(o.confirm === true ? { confirm: true } : {}),
        },
      };
    }
    case 'tool':
      return { tool: f.rest[0] ?? '', args: f.rest[1] ? JSON.parse(f.rest.slice(1).join(' ')) : {} };
    default:
      return null;
  }
}

function selfCliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'cli.js');
}

export function mcpServerEntry(projectPath: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [selfCliPath(), 'mcp', '--project', resolve(projectPath)] };
}

function writeMcpJson(file: string, projectPath: string): string {
  let cfg: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} exists but is not valid JSON — fix or remove it first`);
    }
  }
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), blox: mcpServerEntry(projectPath) };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return file;
}

// Wire an agent to this project's blox MCP server + workflow guide.
export function setupAgent(agent: string, projectPath: string): string[] {
  const out: string[] = [];
  const agentsMd = join(projectPath, 'AGENTS.md');
  if (!existsSync(agentsMd)) {
    writeFileSync(agentsMd, AGENT_GUIDE);
    out.push(`wrote ${agentsMd}`);
  }
  const entry = mcpServerEntry(projectPath);
  if (agent === 'claude') {
    out.push(`wrote ${writeMcpJson(join(projectPath, '.mcp.json'), projectPath)} (project MCP server "blox")`);
    const claudeMd = join(projectPath, 'CLAUDE.md');
    if (!existsSync(claudeMd)) {
      writeFileSync(claudeMd, '@AGENTS.md\n');
      out.push(`wrote ${claudeMd} (imports AGENTS.md)`);
    }
    out.push('→ start `claude` in the project and approve the "blox" MCP server.');
  } else if (agent === 'cursor') {
    out.push(`wrote ${writeMcpJson(join(projectPath, '.cursor', 'mcp.json'), projectPath)}`);
  } else if (agent === 'codex') {
    out.push('Add to ~/.codex/config.toml:', '', '[mcp_servers.blox]', `command = ${JSON.stringify(entry.command)}`, `args = ${JSON.stringify(entry.args)}`, '', 'Codex reads AGENTS.md from the project root.');
  } else {
    out.push('MCP server (stdio):', JSON.stringify({ blox: entry }, null, 2));
  }
  return out;
}

const HELP = `blox — Roblox development runtime for AI agents

Project:   blox new <dir>                 scaffold a project (src/, world/, tests/, AGENTS.md)
           blox setup claude|cursor|codex wire an agent to this project's blox MCP server
           blox mcp                       run the MCP server (stdio)
Develop:   blox status                    Studio/sync/tests/task report
           blox sync [--force]            push files into Studio
           blox test [filter] [--context edit,server,client] [--no-sync]
           blox playtest [--seconds N] [--server '<luau>'] [--client '<luau>'] [--screenshot]
           blox luau '<code>' [--context edit|server|client]
           blox play start|stop|state     blox logs [--context server] [--since 60]
           blox screenshot [--camera x,y,z --look-at x,y,z]
           blox task ['{"action":"get"}']  blox tool <name> '<json args>'
           blox design [get|validate|simulate|codegen]  blox design set '<json>'
           blox check [--fix]             (stylua + luau-lsp + rojo build, no Studio)
           blox kit [list]                blox kit apply <name>   (format kits: proven loops)
           blox metrics ftue|soak|install [--seconds N] [--bot walk|idle|<file>] [--archetype id]
           blox ui lint|install [--devices a,b] [--prepare '<client luau>']
           blox present get|generate|render|lint [--shots a,b]   blox present set '<json>'
           blox multiplayer [filter] [--clients N]   (tests/*.mp.luau via the dock plugin)
           blox asset list|scan|lint|sanitize <path>|normalize <file>|upload <id> [--confirm]
           blox asset approve|reject <id>   (human sign-off; not available to agents over MCP)
           blox model brief <id> --prompt '…' [--tris N --rig --anims walk,run --refs a.png,b.png]
           blox model run <id> <build.py> | check|export|preview|import <id> | list   (Blender, headless)
Ship:      blox release check|build|publish [--confirm]   blox release approve  (human sign-off)
           blox liveops report [--from export.json]|propose|apply <id>|push config|thumbnails [--confirm]
Observe:   blox dashboard [--port 35780]
Measure:   blox bench --agent <cmd> [--tasks id,id|all] [--label name]
Agent:     blox "<prompt>"                built-in Claude runner (uses the same tools)
Other:     blox doctor | init | panel | auth | model | report | relay | eval
All commands take --project <dir> (default: cwd).`;

export const TOOL_COMMANDS = new Set(['status', 'sync', 'test', 'playtest', 'luau', 'play', 'logs', 'screenshot', 'task', 'design', 'check', 'kit', 'metrics', 'ui', 'present', 'multiplayer', 'asset', 'model', 'release', 'liveops', 'tool', 'mcp', 'new', 'setup', 'help', '--help', '-h']);

// Returns true when argv was a toolset command (handled here).
export async function runToolCommand(argv: string[]): Promise<boolean> {
  const cmd = argv[0];
  if (!cmd || !TOOL_COMMANDS.has(cmd)) return false;
  const f = parseFlags(argv.slice(1));
  const projectPath = resolve(f.project ?? process.cwd());

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return true;
  }
  if (cmd === 'new') {
    const dir = resolve(f.rest[0] ?? projectPath);
    const r = scaffoldProject(dir, typeof f.opts.name === 'string' ? f.opts.name : undefined);
    console.log(`scaffolded ${r.dir}\n  created: ${r.created.join(', ') || '(nothing)'}`);
    console.log(`next: cd ${dir} && blox setup claude   (or: blox status)`);
    return true;
  }
  if (cmd === 'setup') {
    try {
      for (const l of setupAgent(f.rest[0] ?? 'generic', projectPath)) console.log(l);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
    }
    return true;
  }
  if (cmd === 'release' && f.rest[0] === 'approve') {
    // Human sign-off on the current build (not an MCP action).
    try {
      console.log(`approved build ${approveRelease(projectPath).slice(0, 12)}… for publishing`);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
    }
    return true;
  }
  if (cmd === 'asset' && (f.rest[0] === 'approve' || f.rest[0] === 'reject')) {
    // Human sign-off lives only here (not an MCP action).
    const id = f.rest[1];
    const err = id ? approveAsset(projectPath, id, f.rest[0] === 'approve' ? 'approved' : 'rejected') : 'usage: blox asset approve|reject <id>';
    if (err) {
      console.error(err);
      process.exitCode = 1;
    } else console.log(`${f.rest[0] === 'approve' ? 'approved' : 'rejected'} ${id}`);
    return true;
  }
  const config = loadConfig(projectPath, { projectPath });
  if (cmd === 'mcp') {
    await serveMcp(config);
    return true;
  }
  let mapped: ReturnType<typeof cliArgs>;
  try {
    mapped = cliArgs(cmd, f);
  } catch (e) {
    console.error(`bad arguments: ${(e as Error).message}`);
    process.exitCode = 2;
    return true;
  }
  const tool = mapped && findTool(mapped.tool);
  if (!mapped || !tool) {
    console.error(`unknown tool "${mapped?.tool ?? cmd}". Tools: ${TOOLS.map((t) => t.name).join(', ')}`);
    process.exitCode = 2;
    return true;
  }
  const session = studioSessionFor(config);
  const ctx: ToolCtx = { session, projectPath, config, agent: process.env.BLOX_AGENT_NAME || 'cli' };
  try {
    const out = await invokeTool(tool, mapped.args, ctx);
    console.log(out.text);
    process.exitCode = out.isError ? 1 : 0;
  } finally {
    await session.close();
  }
  return true;
}

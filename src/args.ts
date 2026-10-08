/** The toolset verbs (src/cliTools.ts handles them before the agent runner). */
export const TOOL_COMMANDS = new Set(['status', 'sync', 'test', 'playtest', 'luau', 'play', 'logs', 'screenshot', 'task', 'design', 'check', 'kit', 'metrics', 'ui', 'present', 'multiplayer', 'asset', 'scout', 'map', 'idea', 'model', 'release', 'liveops', 'animate', 'image', 'tool', 'mcp', 'new', 'setup', 'help', '--help', '-h']);
/** The runner's own subcommands (parseArgs below). */
export const RUNNER_COMMANDS = ['init', 'doctor', 'serve', 'panel', 'auth', 'model', 'report', 'relay', 'eval'] as const;
/** Flags that take a value, so the word after them is not part of the prompt. */
const VALUED_FLAGS = new Set(['--project', '--max-turns', '--budget', '--effort', '--on-conflict', '--image', '--auth', '--model', '--runner', '--fallback-model', '--key', '--base-url', '--since', '--resume']);

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/**
 * An agent run auto-commits the working tree, so a mistyped or unknown verb
 * (`blox scout obby`, `blox animte rig`) must not quietly become a prompt.
 * Returns the refusal when the prompt's first argument is a bare word (no
 * spaces): agent prompts are quoted, `blox "add a coin counter"`.
 */
export function strayPrompt(argv: readonly string[]): string | null {
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (VALUED_FLAGS.has(argv[i])) i++;
      continue;
    }
    words.push(argv[i]);
  }
  if (words.length === 0 || /\s/.test(words[0])) return null;
  const word = words[0];
  const known = [...TOOL_COMMANDS, ...RUNNER_COMMANDS].filter((c) => !c.startsWith('-'));
  const near = known
    .map((c) => ({ c, d: editDistance(word.toLowerCase(), c) }))
    .filter((x) => x.d <= Math.max(1, Math.floor(word.length / 3)))
    .sort((x, y) => x.d - y.d)[0];
  return [
    `"${word}" is not a blox command${near ? ` — did you mean "${near.c}"?` : ''}`,
    `To ask the agent, quote the prompt: blox "${words.join(' ')}"  (an agent run commits the working tree when it ends)`,
    'Commands: blox help',
  ].join('\n');
}

export interface ParsedArgs {
  command: 'doctor' | 'serve' | 'init' | 'panel' | 'auth' | 'model' | 'report' | 'relay' | 'eval' | null;
  prompt: string | null;
  authMode: 'subscription' | 'apiKey' | 'relay' | null;
  mock: boolean;
  projectPath: string | null;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  effort: 'high' | 'xhigh' | null;
  mode: 'auto' | 'ask' | null;
  onConflict: 'abort' | 'suffix' | null;
  force: boolean;
  fix: boolean;
  imagePath: string | null;
  imageFromDock: boolean;
  verify: boolean;
  model: string | null;
  runner: 'claude' | 'openai' | 'codex' | null;
  fallbackModel: string | null;
  usageSource: 'auto' | 'local' | 'relay'; // blox report: --local / --relay
  key: string | null;
  baseUrl: string | null;
  since: number | null;
  json: boolean;
  // Resume a prior SDK session by id (Options.resume) or continue the most
  // recent session in the project (Options.continue). Mutually exclusive.
  resume: string | null;
  continueSession: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let mock = false;
  let projectPath: string | null = null;
  let command: 'doctor' | 'serve' | 'init' | 'panel' | 'auth' | 'model' | 'report' | 'relay' | 'eval' | null = null;
  let authMode: 'subscription' | 'apiKey' | 'relay' | null = null;
  let maxTurns: number | null = null;
  let maxBudgetUsd: number | null = null;
  let effort: 'high' | 'xhigh' | null = null;
  let mode: 'auto' | 'ask' | null = null;
  let onConflict: 'abort' | 'suffix' | null = null;
  let force = false;
  let fix = false;
  let imagePath: string | null = null;
  let imageFromDock = false;
  let verify = false;
  let model: string | null = null;
  let runner: 'claude' | 'openai' | 'codex' | null = null;
  let fallbackModel: string | null = null;
  let usageSource: 'auto' | 'local' | 'relay' = 'auto';
  let key: string | null = null;
  let baseUrl: string | null = null;
  let since: number | null = null;
  let json = false;
  let resume: string | null = null;
  let continueSession = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') mock = true;
    else if (a === '--project') projectPath = argv[++i] ?? null;
    else if (a === '--max-turns') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error('--max-turns must be a positive integer');
      maxTurns = n;
    } else if (a === '--budget') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--budget must be a positive number');
      maxBudgetUsd = n;
    } else if (a === '--effort') {
      const v = argv[++i];
      if (v !== 'high' && v !== 'xhigh') throw new Error('--effort must be high or xhigh');
      effort = v;
    } else if (a === '--auto') mode = 'auto';
    else if (a === '--ask') mode = 'ask';
    else if (a === '--on-conflict') {
      const v = argv[++i];
      if (v !== 'abort' && v !== 'suffix') throw new Error('--on-conflict must be abort or suffix');
      onConflict = v;
    } else if (a === '--force') force = true;
    else if (a === '--fix') fix = true;
    else if (a === '--image') {
      const v = argv[++i];
      if (v == null) throw new Error('--image needs a file path');
      imagePath = v;
    } else if (a === '--image-from-dock') imageFromDock = true;
    else if (a === '--verify') verify = true;
    else if (a === '--auth') {
      const v = argv[++i];
      if (v === 'key') authMode = 'apiKey';
      else if (v === 'subscription') authMode = 'subscription';
      else if (v === 'relay') authMode = 'relay';
      else throw new Error('--auth must be subscription, key or relay');
    } else if (a === '--model') model = argv[++i] ?? null;
    else if (a === '--runner') {
      const v = argv[++i];
      if (v !== 'claude' && v !== 'openai' && v !== 'codex') throw new Error('--runner must be claude, openai or codex');
      runner = v;
    }
    else if (a === '--fallback-model') fallbackModel = argv[++i] ?? null;
    else if (a === '--key') key = argv[++i] ?? null;
    else if (a === '--base-url') baseUrl = argv[++i] ?? null;
    else if (a === '--since') {
      const raw = argv[++i];
      const n = Number(String(raw ?? '').replace(/d$/, ''));
      if (!Number.isInteger(n) || n <= 0) throw new Error('--since must be a positive integer number of days (e.g. 7 or 7d)');
      since = n;
    } else if (a === '--json') json = true;
    else if (a === '--local') usageSource = 'local';
    else if (a === '--relay') usageSource = 'relay';
    else if (a === '--resume') {
      const v = argv[++i];
      if (v == null) throw new Error('--resume needs a session id');
      resume = v;
    } else if (a === '--continue') continueSession = true;
    else if (a === 'init' && command === null && positional.length === 0) command = 'init';
    else if (a === 'doctor' && command === null && positional.length === 0) command = 'doctor';
    else if (a === 'serve' && command === null && positional.length === 0) command = 'serve';
    else if (a === 'panel' && command === null && positional.length === 0) command = 'panel';
    else if (a === 'auth' && command === null && positional.length === 0) command = 'auth';
    else if (a === 'model' && command === null && positional.length === 0) command = 'model';
    else if (a === 'report' && command === null && positional.length === 0) command = 'report';
    else if (a === 'relay' && command === null && positional.length === 0) command = 'relay';
    else if (a === 'eval' && command === null && positional.length === 0) command = 'eval';
    else positional.push(a);
  }
  if (imagePath !== null && imageFromDock) {
    throw new Error('--image and --image-from-dock are mutually exclusive');
  }
  if (resume !== null && continueSession) {
    throw new Error('--resume and --continue are mutually exclusive');
  }
  return {
    command,
    prompt: positional.join(' ').trim() || null,
    authMode,
    mock,
    projectPath,
    maxTurns,
    maxBudgetUsd,
    effort,
    mode,
    onConflict,
    force,
    fix,
    imagePath,
    imageFromDock,
    verify,
    model,
    runner,
    fallbackModel,
    usageSource,
    key,
    baseUrl,
    since,
    json,
    resume,
    continueSession,
  };
}

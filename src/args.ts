export interface ParsedArgs {
  command: 'doctor' | 'serve' | 'init' | 'panel' | 'auth' | 'model' | 'report' | 'relay' | null;
  prompt: string | null;
  authMode: 'subscription' | 'apiKey' | null;
  mock: boolean;
  projectPath: string | null;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  effort: 'high' | 'xhigh' | null;
  mode: 'auto' | 'ask' | null;
  onConflict: 'abort' | 'suffix' | null;
  force: boolean;
  imagePath: string | null;
  imageFromDock: boolean;
  verify: boolean;
  model: string | null;
  key: string | null;
  baseUrl: string | null;
  since: number | null;
  json: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let mock = false;
  let projectPath: string | null = null;
  let command: 'doctor' | 'serve' | 'init' | 'panel' | 'auth' | 'model' | 'report' | 'relay' | null = null;
  let authMode: 'subscription' | 'apiKey' | null = null;
  let maxTurns: number | null = null;
  let maxBudgetUsd: number | null = null;
  let effort: 'high' | 'xhigh' | null = null;
  let mode: 'auto' | 'ask' | null = null;
  let onConflict: 'abort' | 'suffix' | null = null;
  let force = false;
  let imagePath: string | null = null;
  let imageFromDock = false;
  let verify = false;
  let model: string | null = null;
  let key: string | null = null;
  let baseUrl: string | null = null;
  let since: number | null = null;
  let json = false;
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
      else throw new Error('--auth must be subscription or key');
    } else if (a === '--model') model = argv[++i] ?? null;
    else if (a === '--key') key = argv[++i] ?? null;
    else if (a === '--base-url') baseUrl = argv[++i] ?? null;
    else if (a === '--since') {
      const raw = argv[++i];
      const n = Number(String(raw ?? '').replace(/d$/, ''));
      if (!Number.isInteger(n) || n <= 0) throw new Error('--since must be a positive integer number of days (e.g. 7 or 7d)');
      since = n;
    } else if (a === '--json') json = true;
    else if (a === 'init' && command === null && positional.length === 0) command = 'init';
    else if (a === 'doctor' && command === null && positional.length === 0) command = 'doctor';
    else if (a === 'serve' && command === null && positional.length === 0) command = 'serve';
    else if (a === 'panel' && command === null && positional.length === 0) command = 'panel';
    else if (a === 'auth' && command === null && positional.length === 0) command = 'auth';
    else if (a === 'model' && command === null && positional.length === 0) command = 'model';
    else if (a === 'report' && command === null && positional.length === 0) command = 'report';
    else if (a === 'relay' && command === null && positional.length === 0) command = 'relay';
    else positional.push(a);
  }
  if (imagePath !== null && imageFromDock) {
    throw new Error('--image and --image-from-dock are mutually exclusive');
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
    imagePath,
    imageFromDock,
    verify,
    model,
    key,
    baseUrl,
    since,
    json,
  };
}

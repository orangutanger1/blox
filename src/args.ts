export interface ParsedArgs {
  command: 'doctor' | 'serve' | 'init' | 'panel' | null;
  prompt: string | null;
  mock: boolean;
  projectPath: string | null;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  effort: 'high' | 'xhigh' | null;
  mode: 'auto' | 'ask' | null;
  onConflict: 'abort' | 'suffix' | null;
  force: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let mock = false;
  let projectPath: string | null = null;
  let command: 'doctor' | 'serve' | 'init' | 'panel' | null = null;
  let maxTurns: number | null = null;
  let maxBudgetUsd: number | null = null;
  let effort: 'high' | 'xhigh' | null = null;
  let mode: 'auto' | 'ask' | null = null;
  let onConflict: 'abort' | 'suffix' | null = null;
  let force = false;
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
    else if (a === 'init' && command === null && positional.length === 0) command = 'init';
    else if (a === 'doctor' && command === null && positional.length === 0) command = 'doctor';
    else if (a === 'serve' && command === null && positional.length === 0) command = 'serve';
    else if (a === 'panel' && command === null && positional.length === 0) command = 'panel';
    else positional.push(a);
  }
  return {
    command,
    prompt: positional.join(' ').trim() || null,
    mock,
    projectPath,
    maxTurns,
    maxBudgetUsd,
    effort,
    mode,
    onConflict,
    force,
  };
}

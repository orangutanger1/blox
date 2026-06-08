export interface ParsedArgs {
  command: 'doctor' | null;
  prompt: string | null;
  mock: boolean;
  projectPath: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let mock = false;
  let projectPath: string | null = null;
  let command: 'doctor' | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') mock = true;
    else if (a === '--project') projectPath = argv[++i] ?? null;
    else if (a === 'doctor' && command === null && positional.length === 0) command = 'doctor';
    else positional.push(a);
  }
  return { command, prompt: positional.join(' ').trim() || null, mock, projectPath };
}

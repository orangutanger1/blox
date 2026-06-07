export interface ParsedArgs {
  prompt: string | null;
  mock: boolean;
  projectPath: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let mock = false;
  let projectPath: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') mock = true;
    else if (a === '--project') projectPath = argv[++i] ?? null;
    else positional.push(a);
  }
  return { prompt: positional.join(' ').trim() || null, mock, projectPath };
}

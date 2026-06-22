// app/main/onboardState.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function createOnboardState(filePath: string) {
  const read = (): { complete: boolean } => {
    if (!existsSync(filePath)) return { complete: false };
    try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return { complete: false }; }
  };
  return {
    isComplete: () => read().complete === true,
    markComplete: () => writeFileSync(filePath, JSON.stringify({ complete: true })),
  };
}

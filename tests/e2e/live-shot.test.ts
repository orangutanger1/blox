import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const enabled = process.env.BLOX_LIVE_SHOT === '1';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// Live: blox --image builds a UI in the real project. Asserts the run exits 0;
// the agent's exact output is non-deterministic, so we check completion only.
describe.skipIf(!enabled)('blox --image screenshot→UI (live)', () => {
  it('completes a run with an image attached', () => {
    const img = join(tmpdir(), 'blox-live-shot.png');
    writeFileSync(img, PNG_1X1);
    try {
      const out = execFileSync(
        'node',
        ['dist/cli.js', '--image', img, '--auto', '--max-turns', '6', 'Build a simple ScreenGui that matches this image'],
        { encoding: 'utf8', timeout: 300_000 },
      );
      expect(out).toMatch(/status:\s*success|turns/i);
    } finally {
      if (existsSync(img)) rmSync(img, { force: true });
    }
  });
});

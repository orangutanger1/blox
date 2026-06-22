// app/main/onboardState.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOnboardState } from './onboardState.js';

const file = join(tmpdir(), `blox-onboard-${Date.now()}.json`);
afterEach(() => rmSync(file, { force: true }));

describe('createOnboardState', () => {
  it('starts incomplete and persists completion', () => {
    const s = createOnboardState(file);
    expect(s.isComplete()).toBe(false);
    s.markComplete();
    expect(createOnboardState(file).isComplete()).toBe(true);
  });
});

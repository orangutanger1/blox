import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(__dirname, '../test-fixtures/game');

describe('fixture game', () => {
  it('has a valid Rojo project with the expected tree', () => {
    const proj = JSON.parse(readFileSync(resolve(dir, 'default.project.json'), 'utf8'));
    expect(proj.name).toBe('blox-fixture');
    expect(Object.keys(proj.tree)).toContain('ReplicatedStorage');
    expect(Object.keys(proj.tree)).toContain('ServerScriptService');
  });

  it('ships the Greeter and Hello scripts', () => {
    const greeter = readFileSync(resolve(dir, 'src/ReplicatedStorage/Greeter.luau'), 'utf8');
    expect(greeter).toContain('function Greeter.greet');
  });
});

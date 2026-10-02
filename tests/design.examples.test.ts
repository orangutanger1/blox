// tests/design.examples.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateDesign } from '../src/design/schema.js';
import { runSimulation } from '../src/design/report.js';
import { renderTunables } from '../src/design/codegen.js';

for (const name of ['incremental', 'steal-tycoon']) {
  describe(`example ${name}`, () => {
    const raw = JSON.parse(readFileSync(new URL(`../docs/examples/design/${name}.json`, import.meta.url), 'utf8'));
    it('validates, passes its own assertions, and codegens', () => {
      const v = validateDesign(raw);
      if (!v.ok) throw new Error(JSON.stringify(v.errors, null, 2));
      const r = runSimulation(v.doc, { runs: 20 });
      const failed = r.assertions.filter((a) => !a.ok);
      expect(failed.map((a) => `${a.id}: ${a.detail}`)).toEqual([]);
      expect(r.assertions.length).toBeGreaterThanOrEqual(3);
      expect(renderTunables(v.doc)).toMatch(/^-- GENERATED/);
    });
  });
}

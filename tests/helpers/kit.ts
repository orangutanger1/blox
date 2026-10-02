import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDesign, type DesignDoc } from '../../src/design/schema.js';
import { renderTunables, TUNABLES_PATH } from '../../src/design/codegen.js';

export const KIT_DIR = fileURLToPath(new URL('../../kits/incremental/', import.meta.url));

export function kitDesign(): DesignDoc {
  const v = validateDesign(JSON.parse(readFileSync(join(KIT_DIR, 'design.json'), 'utf8')));
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.doc;
}

// A project made of the kit's files plus Tunables generated from its design.
export function kitProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'blox-kit-'));
  cpSync(join(KIT_DIR, 'files'), d, { recursive: true });
  mkdirSync(join(d, 'src/ReplicatedStorage/Design'), { recursive: true });
  writeFileSync(join(d, TUNABLES_PATH), renderTunables(kitDesign()));
  return d;
}

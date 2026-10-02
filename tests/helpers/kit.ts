import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDesign, type DesignDoc } from '../../src/design/schema.js';
import { renderTunables, TUNABLES_PATH } from '../../src/design/codegen.js';

export const KITS_DIR = fileURLToPath(new URL('../../kits/', import.meta.url));
export const KIT_DIR = join(KITS_DIR, 'incremental');

export function kitDesign(kit = 'incremental'): DesignDoc {
  const v = validateDesign(JSON.parse(readFileSync(join(KITS_DIR, kit, 'design.json'), 'utf8')));
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.doc;
}

// A project made of the kit's files plus Tunables generated from its design.
export function kitProject(kit = 'incremental'): string {
  const d = mkdtempSync(join(tmpdir(), 'blox-kit-'));
  cpSync(join(KITS_DIR, '_common/files'), d, { recursive: true });
  cpSync(join(KITS_DIR, kit, 'files'), d, { recursive: true });
  mkdirSync(join(d, 'src/ReplicatedStorage/Design'), { recursive: true });
  writeFileSync(join(d, TUNABLES_PATH), renderTunables(kitDesign(kit)));
  return d;
}

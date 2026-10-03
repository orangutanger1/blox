import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bloxDir, readJson } from '../state/store.js';
import { loadManifest } from '../assets/manifest.js';
import { QUARANTINE } from '../assets/scout.js';

// Release readiness: every deterministic gate blox can run, in one place.
// "ready" means the machine checks pass; the human gates are listed, not judged.

export type GateStatus = 'pass' | 'fail' | 'missing' | 'stale' | 'n/a';
export interface Gate {
  id: string;
  required: boolean;
  status: GateStatus;
  detail: string;
}
export interface ReleaseReport {
  ranAt: string;
  ready: boolean;
  gates: Gate[];
  humanGates: string[];
}

export const HUMAN_GATES = [
  'concept/theme and "is it fun" — play it',
  'final title, description and art (present lint passing is necessary, not sufficient)',
  'monetization: prices, passes, products',
  'publish: `blox release approve` (binds to this build), then release {action:"publish", confirm:true}',
];

type Results = { ranAt: string; results: { id: string; ok: boolean }[] };

function fromResults(id: string, required: boolean, r: Results | null, prefix?: string): Gate {
  const list = (r?.results ?? []).filter((x) => !prefix || x.id.startsWith(prefix));
  if (!r || !list.length) return { id, required, status: 'missing', detail: 'not run' };
  const bad = list.filter((x) => !x.ok);
  return bad.length
    ? { id, required, status: 'fail', detail: `${bad.length}/${list.length} failing: ${bad.slice(0, 4).map((x) => x.id).join(', ')}` }
    : { id, required, status: 'pass', detail: `${list.length} check(s) pass` };
}

function hasMpSpecs(projectPath: string): boolean {
  const root = join(projectPath, 'tests');
  if (!existsSync(root)) return false;
  const walk = (d: string): boolean => readdirSync(d).some((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : /\.mp\.luau$/i.test(e)));
  return walk(root);
}

export function releaseCheck(projectPath: string): ReleaseReport {
  const gates: Gate[] = [];
  const lt = readJson<{ tests: { status: string; name: string }[]; fileErrors?: unknown[] }>(projectPath, 'last-tests.json');
  if (!lt) gates.push({ id: 'tests', required: true, status: 'missing', detail: 'run_tests has not run' });
  else {
    const bad = lt.tests.filter((t) => t.status !== 'pass');
    const fe = Array.isArray(lt.fileErrors) ? lt.fileErrors.length : 0;
    gates.push(bad.length || fe ? { id: 'tests', required: true, status: 'fail', detail: `${bad.length} failing test(s), ${fe} file error(s)` } : { id: 'tests', required: true, status: 'pass', detail: `${lt.tests.length} test(s) pass` });
  }
  const designFile = join(bloxDir(projectPath), 'design.json');
  if (!existsSync(designFile)) gates.push({ id: 'design', required: false, status: 'n/a', detail: 'no design.json' });
  else {
    const sim = readJson<{ ranAt: string; assertions: { id: string; ok: boolean }[] }>(projectPath, 'sim-report.json');
    if (!sim) gates.push({ id: 'design', required: true, status: 'missing', detail: 'design simulate has not run' });
    else if (Date.parse(sim.ranAt) < statSync(designFile).mtimeMs) gates.push({ id: 'design', required: true, status: 'stale', detail: 'design.json changed after the last simulate' });
    else gates.push(fromResults('design', true, { ranAt: sim.ranAt, results: sim.assertions }));
  }
  const met = readJson<Results>(projectPath, 'metrics-report.json');
  gates.push(fromResults('ftue', true, met, 'ftue:'));
  gates.push(fromResults('soak', false, met, 'soak:'));
  if (hasMpSpecs(projectPath)) {
    const mp = readJson<{ ranAt: string; results: { file: string; name: string; status: string }[]; error?: string }>(projectPath, 'mp-report.json');
    if (!mp) gates.push({ id: 'multiplayer', required: true, status: 'missing', detail: 'multiplayer has not run' });
    else gates.push(fromResults('multiplayer', true, { ranAt: mp.ranAt, results: [...mp.results.map((r) => ({ id: `${r.file} › ${r.name}`, ok: r.status === 'pass' })), ...(mp.error ? [{ id: mp.error, ok: false }] : [])] }));
  } else gates.push({ id: 'multiplayer', required: false, status: 'n/a', detail: 'no *.mp.luau specs' });
  gates.push(fromResults('ui', true, readJson<Results>(projectPath, 'ui-report.json')));
  gates.push(fromResults('present', true, readJson<Results>(projectPath, 'present-report.json')));
  if (existsSync(join(bloxDir(projectPath), 'assets.json'))) {
    gates.push(fromResults('assets', true, readJson<Results>(projectPath, 'asset-report.json')));
    gates.push(...provenanceGates(projectPath));
  } else gates.push({ id: 'assets', required: false, status: 'n/a', detail: 'no assets.json' });
  const ready = gates.every((g) => !g.required || g.status === 'pass');
  return { ranAt: new Date().toISOString(), ready, gates, humanGates: HUMAN_GATES };
}

// Every asset the game uses (adopted into the place, or uploaded) needs a human
// sign-off and a known licence; a quarantined try that was never adopted does not.
// Adopted Creator Store packs live only in the place file — Rojo does not
// rebuild them — so that is surfaced too.
function provenanceGates(projectPath: string): Gate[] {
  let m;
  try {
    m = loadManifest(projectPath);
  } catch (e) {
    return [{ id: 'provenance', required: true, status: 'fail', detail: (e as Error).message.split('\n')[0] }];
  }
  const inGame = m.assets.filter((a) => a.uploaded || (a.ref.path && !a.ref.path.startsWith(`${QUARANTINE}.`) && a.ref.path !== QUARANTINE));
  const unapproved = inGame.filter((a) => a.status !== 'approved');
  const unknown = inGame.filter((a) => a.licence === 'unknown');
  const bad = [
    ...(unapproved.length ? [`${unapproved.length} in use but not approved: ${unapproved.slice(0, 5).map((a) => a.id).join(', ')} (\`blox asset approve <id>\` after checking each)`] : []),
    ...(unknown.length ? [`${unknown.length} with unknown licence: ${unknown.slice(0, 5).map((a) => a.id).join(', ')}`] : []),
  ];
  const gates: Gate[] = [
    bad.length
      ? { id: 'provenance', required: true, status: 'fail', detail: bad.join('; ') }
      : inGame.length
        ? { id: 'provenance', required: true, status: 'pass', detail: `${inGame.length} asset(s) in use, all approved` }
        : { id: 'provenance', required: false, status: 'n/a', detail: 'no assets in use' },
  ];
  const placeOnly = inGame.filter((a) => a.ref.path && !a.uploaded && !a.ref.file && a.source === 'creator-store');
  if (placeOnly.length) gates.push({ id: 'place-only', required: false, status: 'fail', detail: `${placeOnly.length} adopted pack(s) exist only in the Studio place (${placeOnly.slice(0, 4).map((a) => a.ref.path).join(', ')}): save the place file — sync from files will not recreate them` });
  return gates;
}

const MARK: Record<GateStatus, string> = { pass: '✓', fail: '✗', missing: '–', stale: '!', 'n/a': '·' };

export function formatRelease(r: ReleaseReport): string {
  const lines = [`release check: ${r.ready ? 'READY (machine gates)' : 'NOT READY'}`];
  for (const g of r.gates) lines.push(`  ${MARK[g.status]} ${g.id.padEnd(11)} ${g.status}${g.required ? '' : ' (advisory)'} — ${g.detail}`);
  lines.push('human gates (always):', ...r.humanGates.map((h) => `  • ${h}`));
  return lines.join('\n');
}

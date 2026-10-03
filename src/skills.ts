import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Roblox knowledge skills (vendored roblox-brain, MIT — skills/roblox-brain/
// VENDOR.md), served on demand through the `skill` tool so any model or agent
// can load just the guidance a task needs instead of carrying it every turn.
// Layout: skills/<pack>/<library>/<skill>/SKILL.md (+ references/full.md).

export const SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url));
const FULL_LIMIT = 12_000;

export interface SkillInfo {
  name: string;
  library: string;
  description: string;
  dir: string;
}

function frontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^(\w[\w-]*):\s*(.+)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return { meta, body: md.slice(m[0].length) };
}

let cache: SkillInfo[] | null = null;

export function listSkills(root = SKILLS_ROOT): SkillInfo[] {
  if (root === SKILLS_ROOT && cache) return cache;
  const out: SkillInfo[] = [];
  const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);
  for (const pack of dirs(root)) {
    for (const library of dirs(join(root, pack))) {
      for (const skill of dirs(join(root, pack, library))) {
        const file = join(root, pack, library, skill, 'SKILL.md');
        if (!existsSync(file)) continue;
        const { meta } = frontmatter(readFileSync(file, 'utf8'));
        out.push({ name: meta.name ?? skill, library, description: meta.description ?? '', dir: join(root, pack, library, skill) });
      }
    }
  }
  if (root === SKILLS_ROOT) cache = out;
  return out;
}

export function formatSkillList(skills: SkillInfo[]): string {
  const lines = ['Roblox skills (skill {name} to load one; skill {name, section} for its deep reference):'];
  let lib = '';
  for (const s of skills) {
    if (s.library !== lib) lines.push(`${(lib = s.library)}:`);
    lines.push(`  ${s.name} — ${s.description.replace(/^Use when /, '')}`);
  }
  return lines.join('\n');
}

// "## Heading" sections of the reference, split on level-2 headings.
function sections(md: string): { title: string; text: string }[] {
  const parts = md.split(/^(?=## )/m);
  return parts.filter((p) => p.startsWith('## ')).map((p) => ({ title: p.split('\n', 1)[0].slice(3).trim(), text: p.trimEnd() }));
}

export function loadSkill(name: string, section?: string, root = SKILLS_ROOT): { text: string; ok: boolean } {
  const all = listSkills(root);
  const s = all.find((x) => x.name === name) ?? all.find((x) => x.name === `roblox-${name}`);
  if (!s) return { ok: false, text: `no skill "${name}". ${formatSkillList(all)}` };
  if (section === undefined) {
    const { body } = frontmatter(readFileSync(join(s.dir, 'SKILL.md'), 'utf8'));
    const hasRef = existsSync(join(s.dir, 'references', 'full.md'));
    return { ok: true, text: `# skill: ${s.name}\n${body.trim()}${hasRef ? `\n\n(deep reference: skill {name:"${s.name}", section:"<heading or 'toc'>"})` : ''}` };
  }
  const ref = join(s.dir, 'references', 'full.md');
  if (!existsSync(ref)) return { ok: false, text: `${s.name} has no deep reference` };
  const md = readFileSync(ref, 'utf8');
  const secs = sections(md);
  const toc = () => `${s.name} reference sections:\n${secs.map((x) => `  - ${x.title}`).join('\n')}`;
  const q = section.trim().toLowerCase();
  if (!q || q === 'toc') return { ok: true, text: md.length <= FULL_LIMIT ? md : toc() };
  const hits = secs.filter((x) => x.title.toLowerCase().includes(q));
  if (!hits.length) return { ok: false, text: `no section matching "${section}". ${toc()}` };
  return { ok: true, text: hits.map((h) => h.text).join('\n\n').slice(0, FULL_LIMIT * 2) };
}

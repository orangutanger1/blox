import { describe, it, expect } from 'vitest';
import { listSkills, loadSkill, formatSkillList } from '../src/skills.js';
import { TOOLS, invokeTool, type ToolCtx } from '../src/tools/registry.js';

describe('skills', () => {
  it('lists the vendored roblox-brain skills and the blox skills by library', () => {
    const all = listSkills();
    expect(all.length).toBe(31);
    expect(new Set(all.map((s) => s.library))).toEqual(new Set(['core', 'gameplay', 'design', 'tools', 'animation', 'ui']));
    expect(all.every((s) => s.description.length > 10)).toBe(true);
    expect(formatSkillList(all)).toMatch(/roblox-security — /);
  });
  it('loads a skill body without frontmatter, accepting a short name', () => {
    const r = loadSkill('security');
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^# skill: roblox-security\n# Roblox Security/);
    expect(r.text).not.toMatch(/last_reviewed/);
    expect(r.text).toMatch(/section:"<heading or 'toc'>"/);
  });
  it('serves reference sections: toc for big references, matched sections by heading', () => {
    const toc = loadSkill('roblox-growth-design', 'toc');
    expect(toc.text).toMatch(/reference sections:\n {2}- /);
    const title = toc.text.split('\n')[1].replace(/^ {2}- /, '');
    const sec = loadSkill('roblox-growth-design', title.slice(0, 12));
    expect(sec.ok).toBe(true);
    expect(sec.text.startsWith(`## ${title}`)).toBe(true);
    expect(loadSkill('roblox-growth-design', 'zzz-nope').ok).toBe(false);
  });
  it('rejects unknown skills with the list', () => {
    const r = loadSkill('../../etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/no skill/);
  });
  it('is exposed as the skill tool', async () => {
    const tool = TOOLS.find((t) => t.name === 'skill')!;
    const out = await invokeTool(tool, { name: 'roblox-data' }, {} as ToolCtx);
    expect(out.isError).toBeFalsy();
    expect(out.text).toMatch(/# skill: roblox-data/);
  });
});

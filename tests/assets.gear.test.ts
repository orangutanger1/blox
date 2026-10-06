import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGearXml } from '../src/assets/gear.js';

const revolver = readFileSync(join(__dirname, 'fixtures', 'gear-revolver.rbxmx'), 'utf8');

describe('parseGearXml', () => {
  it('reads the Tool grip, the Handle size and the Handle\'s own SpecialMesh', () => {
    const g = parseGearXml(revolver)!;
    expect(g.name).toBe('Colt 45');
    expect(g.grip.slice(0, 3)).toEqual([0.175617605, -0.307676286, 0.514754057]);
    expect(g.grip).toHaveLength(12);
    expect(g.handleSize).toEqual([0.510000467, 1.18000245, 1.34999704]);
    expect(g.mesh).toEqual({ meshId: 97886770, textureId: 97888197, scale: [1.79999995, 1.79999995, 1.79999995], offset: [0, 0, 0] });
  });

  it('returns null for something that is not a Tool with a Handle', () => {
    expect(parseGearXml('<roblox><Item class="Model"><Properties><string name="Name">x</string></Properties></Item></roblox>')).toBeNull();
    expect(parseGearXml('<roblox!binary')).toBeNull();
  });

  it('reads a MeshPart handle', () => {
    const xml = `<roblox><Item class="Tool"><Properties><string name="Name">Bombo&apos;s Knife &amp; Co</string>
      <CoordinateFrame name="Grip"><X>0</X><Y>-1</Y><Z>0</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame>
      </Properties><Item class="MeshPart"><Properties><string name="Name">Handle</string>
      <Vector3 name="size"><X>1</X><Y>2</Y><Z>3</Z></Vector3>
      <Content name="MeshId"><url>rbxassetid://123</url></Content><Content name="TextureID"><url>http://www.roblox.com/asset/?id=456</url></Content>
      </Properties></Item></Item></roblox>`;
    expect(parseGearXml(xml)).toMatchObject({ name: "Bombo's Knife & Co", handleSize: [1, 2, 3], mesh: { meshId: 123, textureId: 456 } });
  });
});

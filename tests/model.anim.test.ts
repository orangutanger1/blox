import { describe, it, expect } from 'vitest';
import { BASIS, IDENTITY, boneOrder, checkMotion, inv, keyframeSequenceXml, mul, prepare, priorityToken, toRoblox, type AnimJson, type Mat4 } from '../src/model/anim.js';

const rotX = (deg: number, at: [number, number, number] = [0, 0, 0]): Mat4 => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  // rotation about X through point `at`: T(at) R T(-at)
  const R: Mat4 = [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
  const T = (x: number, y: number, z: number): Mat4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
  return mul(mul(T(...at), R), T(-at[0], -at[1], -at[2]));
};
const translate = (x: number, y: number, z: number): Mat4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];

// A root bone at (0,0,1) and a head bone at (0,-2,2) (Blender: -Y is the front).
function anim(headDeg: number[], loop = true): AnimJson {
  const rootRest = translate(0, 0, 1);
  const headRest = translate(0, -2, 2);
  return {
    name: 'Nod', fps: 24, loop, meshes: ['Body'], meshCenter: [0, 0, 1],
    bones: { root: { parent: null, rest: rootRest, head: [0, 0, 1] }, head: { parent: 'root', rest: headRest, head: [0, -2, 2] } },
    frames: headDeg.map((d, i) => ({ t: i / 24, bones: { root: rootRest, head: mul(rotX(d, [0, -2, 2]), headRest) } })),
  };
}

describe('anim maths', () => {
  it('inv undoes mul', () => {
    const m = mul(rotX(30, [1, 2, 3]), translate(4, 5, 6));
    const r = mul(m, inv(m));
    r.forEach((v, i) => expect(v).toBeCloseTo(IDENTITY[i], 9));
  });
  it('basis maps Blender front (-Y) to Roblox front (-Z) and up (Z) to Y', () => {
    expect(toRoblox([0, -1, 0], [0, 0, 0])).toEqual([-0, 0, -1]);
    expect(toRoblox([0, 0, 1], [0, 0, 0])).toEqual([-0, 1, 0]);
    expect(BASIS).toHaveLength(16);
  });
  it('parents come before children', () => {
    expect(boneOrder({ b: { parent: 'a', rest: IDENTITY, head: [0, 0, 0] }, a: { parent: null, rest: IDENTITY, head: [0, 0, 0] } })).toEqual(['a', 'b']);
  });
  it('a nod is a pure head rotation relative to the root, about the head', () => {
    const p = prepare(anim([0, 30, 0]));
    const q = p.keyframes[1].q.head;
    // rotation about Roblox X (Blender X flips sign under the basis), angle 30°
    const angle = (Math.acos((q[3] + q[7] + q[11] - 1) / 2) * 180) / Math.PI;
    expect(angle).toBeCloseTo(30, 4);
    expect(p.keyframes[1].q.root.slice(0, 3)).toEqual([0, 0, 0]);
    // the head pivot (mesh-centred Roblox axes) stays put under its own motion
    expect(p.restHeads.head).toEqual([-0, 1, -2]);
    expect(p.keyframes[1].heads.head[1]).toBeCloseTo(1, 6);
  });
  it('checks: closed loop passes, open loop and snaps fail, still animation flagged', () => {
    expect(checkMotion(prepare(anim([0, 20, 0]))).every((c) => c.ok)).toBe(true);
    const open = checkMotion(prepare(anim([0, 20, 40])));
    expect(open.find((c) => c.id === 'anim:loop')!.ok).toBe(false);
    const snap = checkMotion(prepare(anim([0, 170, 0])));
    expect(snap.find((c) => c.id === 'anim:speed')!.ok).toBe(false);
    expect(checkMotion(prepare(anim([0, 0, 0]))).some((c) => c.id === 'anim:moves' && !c.ok)).toBe(true);
  });
  it('priority from the name', () => {
    expect([priorityToken('Idle'), priorityToken('Sleep'), priorityToken('Walk'), priorityToken('Attack')]).toEqual([0, 0, 1, 2]);
  });
  it('rbxmx nests bone poses under the part pose, per keyframe', () => {
    const xml = keyframeSequenceXml({
      name: 'Walk', loop: true, part: 'body', order: ['root', 'head'], parents: { root: null, head: 'root' },
      frames: [{ t: 0, poses: { root: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], head: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] } }],
    });
    expect(xml).toMatch(/<Item class="KeyframeSequence"[^>]*><Properties><string name="Name">Walk<\/string><bool name="Loop">true<\/bool><token name="Priority">1<\/token>/);
    expect(xml).toMatch(/<string name="Name">body<\/string>.*<string name="Name">root<\/string>.*<string name="Name">head<\/string>/);
    expect(xml.match(/class="Pose"/g)).toHaveLength(3);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { initNode } from '../src/kernel/node';
import { runProject, live } from '../src/kernel/runtime';
import { simulateDynamics, holdTest, dropTest } from '../src/kernel/physics';
import { box, sphere } from '../src/kernel/ops';
import { Assembly } from '../src/kernel/assembly';
import { EXAMPLES } from '../src/app/examples';

beforeAll(async () => { await initNode(); });

describe('rigid-body dynamics', () => {
  it('drops a box that falls, lands and comes to rest on the ground', () => {
    const r = dropTest(box(20, 20, 20), { height: 50, duration: 1.5 });
    const p = r.summary.parts.Part;
    const zs = r.frames.map((f) => f.transforms.Part[14]);
    console.log('drop', p, r.summary.maxPenetrationMm, zs.slice(0, 40).filter((_, i) => i % 5 === 0));
    expect(p.finalCenterMm[2]).toBeGreaterThan(8);
    expect(p.finalCenterMm[2]).toBeLessThan(12);
    expect(r.summary.settled).toBe(true);
    expect(r.summary.maxPenetrationMm).toBeLessThan(3);
  });
  it('bounces a ball with restitution', () => {
    const ball = sphere(10);
    const asm = new Assembly('B').addPart('Ball', ball.translate(0, 0, 200), { sim: { material: { restitution: 0.9, staticFriction: 0.5 } } });
    const r = simulateDynamics(asm, { duration: 1.2, ground: { z: 0, restitution: 0.9 } });
    const z = r.frames.map((f) => f.transforms.Ball[14] + 200);
    const firstLow = z.findIndex((v) => v < 15);
    const peakAfter = Math.max(...z.slice(firstLow + 1));
    console.log('bounce', firstLow, peakAfter);
    expect(peakAfter).toBeGreaterThan(80);
  });
  it('stacks two boxes', () => {
    const asm = new Assembly('S').addPart('A', box(40, 40, 20).translate(0, 0, 10)).addPart('B', box(20, 20, 20).translate(0, 0, 32));
    const r = simulateDynamics(asm, { duration: 1.5 });
    console.log('stack', r.summary.parts);
    // boxes sit on z = 0..h: A spans 10..30, so B (20 tall) should rest centred near z = 40
    expect(r.summary.parts.B.finalCenterMm[2]).toBeGreaterThan(38);
    expect(r.summary.parts.B.finalCenterMm[2]).toBeLessThan(41.5);
    expect(r.summary.settled).toBe(true);
  });
  it('slides a box on a tilted plane only when friction is low', () => {
    const ramp = (mu: number) => {
      const asm = new Assembly('R')
        .addPart('Ramp', box(300, 60, 10).translate(0, 0, -10).rotate([0, -20, 0]), { sim: { motion: { kind: 'static' }, material: { staticFriction: mu } } })
        .addPart('Block', box(20, 20, 20).translate(0, 0, 0.2).rotate([0, -20, 0]), { sim: { material: { staticFriction: mu } } });
      return simulateDynamics(asm, { duration: 0.8, ground: false });
    };
    const sticky = ramp(0.8), slick = ramp(0.05);
    console.log('ramp', sticky.summary.parts.Block.displacementMm, slick.summary.parts.Block.displacementMm);
    expect(sticky.summary.parts.Block.displacementMm).toBeLessThan(5);
    expect(slick.summary.parts.Block.displacementMm).toBeGreaterThan(50);
  });
  it('swings a pendulum on a revolute joint with the joint value following', () => {
    const r = ok(`
      const post = box(10, 10, 100).translate(0, 0, 50).withConnectors({ pivot: connector("pivot", { origin: [0, 0, 100], axis: [0, 1, 0], up: [1, 0, 0] }) });
      const arm = box(80, 6, 6).translate(40, 0, 0).withConnectors({ root: connector("root", { origin: [0, 0, 0], axis: [0, -1, 0], up: [1, 0, 0] }) });
      return assembly("P").addPart("Post", post, { sim: Sim.body({ motion: Sim.motion.static() }) }).addPart("Arm", arm)
        .connect("Post.pivot", "Arm.root", { as: "swing", type: "revolute", default: 0 });
    `);
    const asm = live.assemblies.get('P')!;
    const res = simulateDynamics(asm, { duration: 1, ground: false });
    const vals = res.frames.map((f) => f.values.swing);
    console.log('pendulum', Math.min(...vals), Math.max(...vals), res.final);
    expect(Math.max(...vals.map(Math.abs))).toBeGreaterThan(60);
    // the arm stays attached at the pivot
    const T = res.finalTransforms.Arm;
    const pivot = [T[12], T[13], T[14]];
    expect(Math.hypot(pivot[0], pivot[1], pivot[2] - 100)).toBeLessThan(2);
    expect(r.ok).toBe(true);
  });
  it('holds the robot arm example with its servos and reports drive effort', () => {
    const ex = EXAMPLES.find((e) => e.id === 'robot-arm')!;
    ok(ex.files['main.forge.js']);
    const asm = live.assemblies.get('Arm')!;
    const res = simulateDynamics(asm, { duration: 1 });
    console.log('arm', res.final, res.summary.drives);
    expect(Math.abs(res.final.shoulder - 45)).toBeLessThan(5);
    expect(Math.abs(res.final.elbow + 60)).toBeLessThan(5);
    expect(res.summary.drives.shoulder.peakEffort).toBeGreaterThan(0);
    const moved = simulateDynamics(asm, { duration: 2, targets: { shoulder: 80 } });
    console.log('arm moved', moved.final);
    expect(Math.abs(moved.final.shoulder - 80)).toBeLessThan(5);
  });
  it('runs a hold test with a control pass', () => {
    const ex = EXAMPLES.find((e) => e.id === 'hinged-lid')!;
    ok(ex.files['main.forge.js']);
    const asm = live.assemblies.get('Lid box')!;
    const free = simulateDynamics(asm, { duration: 1.5 });
    console.log('lid', free.final, free.summary.parts.Box);
    expect(free.final.open).toBeGreaterThan(60);
    const h = holdTest(asm, { joint: 'open', load: -0.5, seconds: 1, maxTravel: 3 });
    console.log('hold', h);
    expect(h.pass).toBe(false);
  });
  it('is available from scripts as assembly.simulate and Sim.drop', () => {
    const r = ok(`
      const res = Sim.drop(box(10, 10, 10), { height: 30, duration: 0.8 });
      verify.lessThan("lands", res.summary.parts.Part.finalCenterMm[2], 7);
      return box(1,1,1);
    `);
    expect(r.checks?.every((c: any) => c.pass) ?? true).toBe(true);
  });
});

function ok(src: string) {
  const r = runProject({ files: { 'main.forge.js': src } }, {});
  if (!r.ok) throw new Error(r.error?.message);
  return r;
}

describe('examples', () => {
  it('knocks over the whole domino run', () => {
    const ex = EXAMPLES.find((e) => e.id === 'dominoes')!;
    const r = ok(ex.files['main.forge.js']);
    expect(r.checks.length).toBeGreaterThan(0);
    expect(r.checks.every((c: any) => c.pass)).toBe(true);
  });
});

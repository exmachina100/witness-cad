import { beforeAll, describe, expect, it } from 'vitest';
import { initNode } from '../src/kernel/node';
import { box } from '../src/kernel/ops';
import { toTriMesh } from '../src/kernel/mesh';
import { solveStaticStress } from '../src/kernel/fea';

beforeAll(async () => { await initNode(); });

describe('FEA', () => {
  it('matches beam theory for a steel cantilever', () => {
    // 100 x 10 x 10 mm, fixed at x=0, 100 N down at x=100
    const s = box(100, 10, 10);
    const r = solveStaticStress(toTriMesh(s.m), { youngsModulusMPa: 200000, poissonRatio: 0.3, yieldStrengthMPa: 250 },
      [{ region: { kind: 'side', side: 'xmin' } }], [{ kind: 'force', region: { kind: 'side', side: 'xmax' }, force: [0, 0, -100] }], { targetElements: 4000 });
    expect(r.converged).toBe(true);
    expect(r.maxDisplacementMm).toBeGreaterThan(0.2 * 0.9);
    expect(r.maxDisplacementMm).toBeLessThan(0.2 * 1.15);
    expect(r.reactionForceN[2]).toBeCloseTo(100, 0);
    expect(r.p99VonMisesMPa).toBeGreaterThan(45);
    expect(r.maxVonMisesMPa).toBeLessThan(90);
  });
});

import { runProject } from '../src/kernel/runtime';
import { runFea } from '../src/kernel/feaRun';

describe('Fea.* studies', () => {
  const bracket = `
    const plate = box(60, 20, 4);
    const web = box(4, 20, 40).translate(-28, 0, 4);
    const part = plate.add(web).color("#888");
    Fea.study.staticStress("Shelf load", {
      material: Fea.materials.aluminum6061T6(),
      fixtures: [Fea.fix.fixed(Fea.region.side("xmin"))],
      loads: [Fea.load.force(Fea.region.side("xmax"), { newtons: 200, direction: [0, 0, -1] })],
      target: Fea.target.minSafetyFactor(2),
      mesh: Fea.mesh.hex({ targetElements: 5000 }),
    });
    return { bracket: part };`;
  it('lists and runs a declared study', () => {
    const r = runProject({ files: { 'main.forge.js': bracket } });
    expect(r.ok).toBe(true);
    expect(r.feaStudies?.map((s) => s.name)).toEqual(['Shelf load']);
    const res = runFea({});
    expect(res.converged).toBe(true);
    expect(res.maxVonMisesMPa).toBeGreaterThan(1);
    expect(res.safetyFactor).toBeGreaterThan(0);
    expect(res.target).toBe(2);
    expect(Math.abs(res.reactionForceN[2] - 200)).toBeLessThan(5);
    expect(res.field!.vonMises.length).toBe(res.field!.positions.length / 3);
    expect(res.field!.indices.length).toBeGreaterThan(res.body.mesh.indices.length);
  });
  it('runs a quick study on named faces of a part', () => {
    runProject({ files: { 'main.forge.js': 'return { post: cylinder(50, 5) };' } });
    const res = runFea({ quick: { fix: 'bottom', load: 'top', newtons: 1000, direction: [0, 0, -1], material: 'astmA36StructuralSteel' }, targetElements: 4000 });
    // axial compression: sigma = F / A
    const sigma = 1000 / (Math.PI * 25);
    expect(res.p99VonMisesMPa).toBeGreaterThan(sigma * 0.8);
    expect(res.p99VonMisesMPa).toBeLessThan(sigma * 1.5);
  });
  it('Fea.solve runs inside a script', () => {
    const r = runProject({ files: { 'main.forge.js': `const b = box(80, 10, 10);
      const res = Fea.solve(b, { material: Fea.materials.astmA36StructuralSteel(), fixtures: [Fea.fix.fixed(Fea.region.side("xmin"))], loads: [Fea.load.force(Fea.region.side("xmax"), { newtons: 50 })], mesh: Fea.mesh.hex({ targetElements: 2000 }) });
      verify.that("strong enough", res.safetyFactor > 2);
      return b;` } });
    expect(r.ok).toBe(true);
  });
  it('explains a missing fixture', () => {
    runProject({ files: { 'main.forge.js': 'return box(10, 10, 10);' } });
    expect(() => runFea({ quick: { fix: 'nowhere', load: 'top', newtons: 10 } })).toThrow(/nowhere/);
  });
});

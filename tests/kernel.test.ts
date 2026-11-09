import { beforeAll, describe, expect, it } from 'vitest';
import { initNode } from '../src/kernel/node';
import { runProject } from '../src/kernel/runtime';
import { exportModel } from '../src/export';

beforeAll(async () => { await initNode(); });
const run = (src: string, files: Record<string, string> = {}, params = {}) => runProject({ files: { 'main.forge.js': src, ...files } }, params);
const ok = (src: string, files: Record<string, string> = {}, params = {}) => {
  const r = run(src, files, params);
  if (!r.ok) throw new Error(r.error?.message);
  return r;
};

describe('core modelling', () => {
  it('builds the starter box', () => {
    const r = ok('return box(50, 30, 10);');
    expect(r.objects).toHaveLength(1);
    expect(r.objects[0].stats!.volume).toBeCloseTo(15000, 0);
  });
  it('declares params and honours overrides', () => {
    const src = `const w = Param.number("Width", 90, { min: 50, max: 160, unit: "mm" });
      const h = Param.number("Height", 12, { min: 6, max: 32 });
      const base = box(w, 56, h).color("#5f87c6");
      const hole = cylinder(h * 3, 5).translate(0, 0, -h);
      return { "starter plate": base.subtract(hole) };`;
    const r = ok(src, {}, { Width: 100 });
    expect(r.params.map((p) => p.name)).toEqual(['Width', 'Height']);
    expect(r.objects[0].name).toBe('starter plate');
    expect(r.objects[0].stats!.bbox.max[0]).toBeCloseTo(50);
    expect(r.objects[0].color).toBe('#5f87c6');
  });
  it('reports errors with a line number', () => {
    const r = run('const a = 1;\nconst b = box(1, 1, 1);\nthrow new Error("boom");');
    expect(r.ok).toBe(false);
    expect(r.error!.message).toBe('boom');
    expect(r.error!.line).toBe(3);
  });
  it('supports sketches, paths, revolve, loft, sweep and text', () => {
    const r = ok(`
      const prof = path().moveTo(0,0).lineTo(20,0).lineTo(20,5).lineTo(5,5).lineTo(5,30).lineTo(0,30).close();
      const knob = prof.revolve(360);
      const l = loft([rect(20,20), circle2d(8)], [0, 30]);
      const s = sweep(circle2d(2), Curve.Fit([[0,0,0],[20,10,10],[40,0,20]]));
      const t = text2d("WITNESS", { size: 8 }).extrude(2);
      const g = spurGear({ module: 1, teeth: 20, faceWidth: 5, boreDiameter: 5 });
      return group({name:'knob', shape: knob}, {name:'loft', shape: l}, {name:'sweep', shape: s}, {name:'text', shape: t}, {name:'gear', shape: g});`);
    expect(r.objects.map((o) => o.name)).toEqual(['knob', 'loft', 'sweep', 'text', 'gear']);
    for (const o of r.objects) expect(o.stats!.volume).toBeGreaterThan(0);
  });
  it('fillets, chamfers, holes, pockets, shells', () => {
    const r = ok(`let b = box(60, 40, 20);
      b = fillet(b, 3, b.edgesOf('top'));
      b = b.hole('top', { thread: 'M6', u: 15 }).hole('top', { diameter: 5, counterbore: { diameter: 9, depth: 3 }, u: -15 });
      verify.lessThan('lighter than solid', b.volume(), 48000);
      const s = box(40, 40, 30).shell(2, { openFaces: ['top'] });
      verify.volumeApprox('shell volume', s, 40*40*30 - 36*36*28, 0.01);
      return [b, s];`);
    expect(r.checks.every((c) => c.pass)).toBe(true);
  });
  it('requires other files', () => {
    const r = ok(`const { plate } = require("./parts/plate.forge.js"); return plate(10);`, { 'parts/plate.forge.js': 'return { plate: (t) => box(40, 40, t) };' });
    expect(r.objects[0].stats!.volume).toBeCloseTo(16000, 0);
  });
  it('solves a constrained sketch', () => {
    const r = ok(`const s = constrainedSketch();
      const r = s.rect({ width: 40, height: 20 });
      s.fix(r.points[0], 0, 0);
      const solved = s.solve();
      verify.equal('fully constrained', solved.constraintMeta.status, 'fully');
      return solved.extrude(5);`);
    expect(r.checks[0].pass).toBe(true);
    expect(r.objects[0].stats!.volume).toBeCloseTo(4000, 0);
  });
});

describe('assemblies', () => {
  const door = `
    const frame = box(100, 10, 80).withConnectors({ hinge: connector("hinge", { origin: [50, 0, 40], axis: [0, 0, 1], up: [1, 0, 0] }) });
    const door = box(60, 4, 80).translate(30, 0, 0).withConnectors({ hinge: connector("hinge", { origin: [0, 0, 40], axis: [0, 0, -1], up: [1, 0, 0] }) });
    const asm = assembly("Door")
      .addPart("Frame", frame, { sim: { massKg: 1.2 } })
      .addPart("Door", door, { sim: { massKg: 0.6 } })
      .connect("Frame.hinge", "Door.hinge", { as: "swing", type: "revolute", min: 0, max: 110, default: 0 });
    verify.connectorDistance("hinge joined", asm, "Frame.hinge", "Door.hinge", 0, 1e-6);
    return asm;`;
  it('solves joints and exports robot formats', () => {
    const r = ok(door);
    expect(r.assemblies[0].joints[0].name).toBe('swing');
    expect(r.checks[0].pass).toBe(true);
    for (const f of ['urdf', 'mjcf', 'sdf', 'glb', '3mf', 'step', 'stl', 'usd', 'drawing', 'package'] as const) {
      const out = exportModel(r, f, { name: 'door' });
      expect((out.data as any).length).toBeGreaterThan(100);
    }
  });
  it('rotates the child about the hinge', () => {
    const r = ok(door, {}, { __joints__Door: { swing: 90 } });
    const doorObj = r.objects.find((o) => o.part === 'Door')!;
    const T = doorObj.transform!;
    // door body (centred at x=30 locally) should swing to +y or -y of the hinge at x=50
    const cx = T[0] * 30 + T[12], cy = T[1] * 30 + T[13];
    expect(cx).toBeCloseTo(50, 3);
    expect(Math.abs(cy)).toBeCloseTo(30, 3);
  });
});

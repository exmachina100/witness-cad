import { beforeAll, describe, expect, it } from 'vitest';
import { initNode } from '../src/kernel/node';
import { runProject } from '../src/kernel/runtime';

beforeAll(async () => { await initNode(); });
const run = (src: string) => { const r = runProject({ files: { 'main.forge.js': src } }, {}); if (!r.ok) throw new Error(r.error?.message); return r; };
const logs = (src: string) => run(src).logs.map((l: any) => l.message);

describe('surfaces', () => {
  it('thickens a plane and a cylinder into solids of the right volume', () => {
    const out = logs(`const p = Surface.Plane({ width: 40, height: 20 }).thicken(2);
      const c = Surface.Cylinder({ radius: 10, height: 30 }).thicken(1, { side: 'out' });
      console.log(p.volume().toFixed(0), (c.volume() / (Math.PI * (121 - 100) * 30)).toFixed(2), c.genus());
      return c;`);
    const [pv, cr, g] = out[0].split(' ');
    expect(Number(pv)).toBeCloseTo(1600, -1);
    expect(Number(cr)).toBeGreaterThan(0.97);
    expect(g).toBe('1');
  });
  it('sews six planes into a closed solid and checks edges', () => {
    const out = logs(`const s = 10, h = s / 2;
      const P = (o, n, x) => Surface.Plane({ width: s, height: s, origin: o, normal: n, x });
      const body = Surface.Sew([P([0,0,h],[0,0,1],[1,0,0]), P([0,0,-h],[0,0,-1],[1,0,0]), P([h,0,0],[1,0,0],[0,1,0]), P([-h,0,0],[-1,0,0],[0,1,0]), P([0,h,0],[0,1,0],[0,0,1]), P([0,-h,0],[0,-1,0],[0,0,1])]);
      const solid = Surface.Solid(body);
      console.log(body.isClosed(), solid.volume().toFixed(1));
      return solid;`);
    expect(out[0]).toBe('true 1000.0');
  });
  it('lofts, patches, bridges and measures continuity', () => {
    const out = logs(`const a = Surface.Plane({ width: 20, height: 20 });
      const b = Surface.Plane({ width: 20, height: 20, origin: [40, 0, 10] });
      const bridge = Blend.Bridge(a, 'u1', b, 'u0');
      const c1 = Analysis.EdgeContinuity(a, 'u1', bridge, 'v0');
      const lf = Surface.Loft([circle2d(10), circle2d(6).onPlane([0,0,20])]);
      const patch = Surface.Patch([[[0,0,0],[10,0,0]], [[10,0,0],[10,10,2]], [[0,10,0],[10,10,2]], [[0,0,0],[0,10,0]]]);
      const health = Analysis.SurfaceHealth(patch);
      const comb = Analysis.CurvatureComb(Curve.Arc ? [[0,0,0],[5,5,0],[10,0,0]] : [], { samples: 20 });
      console.log(c1.level, lf.opts.closedU, health.ok, comb.points.length);
      console.log(Analysis.BRepValidity(box(5,5,5)).valid, Surface.Torus({ major: 20, minor: 4 }).thicken(1).genus());
      return [bridge, lf];`);
    expect(out[0]).toMatch(/^G[12] true true 20$/);
    expect(out[1]).toBe('true 1');
  });
  it('variable thickness, sculpting and product skins', () => {
    const out = logs(`const sheet = Surface.Plane({ width: 30, height: 10 });
      const t = Thickness.alongU(sheet, [1, 3]);
      const cage = Sculpt.controlBox({ size: [40, 30, 20], divisions: 2 }).move([1, 1, 2], [0, 0, 10]);
      const blob = Sculpt.surfaceFromControlCage(cage);
      const skin = Product.skin(Product.profiles({ z: [0, 40, 80], width: [40, 50, 30], depth: [30, 35, 20] }));
      const body = skin.toShape();
      const carrier = Carrier.productSkin(skin);
      const cutter = SurfaceMembers.roundedSlot(carrier, { u: 0.25, v: 0.5, length: 12, width: 4, depth: 3 });
      console.log(t.volume().toFixed(0), blob.boundingBox().max[2] > 20, body.boundingBox().size[2].toFixed(1), body.subtract(cutter).volume() < body.volume());
      return body;`);
    expect(out[0]).toBe('600 true 80.0 true');
  });
});

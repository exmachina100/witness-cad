import { beforeAll, describe, expect, it } from 'vitest';
import { initNode } from '../src/kernel/node';
import { runProject } from '../src/kernel/runtime';

beforeAll(async () => { await initNode(); });
const run = (src: string) => { const r = runProject({ files: { 'main.forge.js': src } }, {}); if (!r.ok) throw new Error(r.error?.message); return r; };
const logs = (src: string) => run(src).logs.map((l: any) => String(l.message));

describe('surfaces API', () => {
  it('sheet edges, frames and NURBS views', () => {
    const out = logs(`const s = Surface.Loft([Curve.Line([0,0,0],[20,0,0]), Curve.Line([0,10,3],[20,10,3])]);
      const f = s.frameAt(0.5, 0.5); const k = s.curvatureAt(0.5,0.5);
      console.log(s.frontEdge.name, s.rearEdge.name, s.frontCurve.pointAt(1).map(v=>v.toFixed(0)).join(','), f.normal.length, typeof k.H, s.surface.degrees.length);
      return s.thicken(1.5);`);
    expect(out[0]).toBe('front rear 20,0,0 3 number 2');
  });
  it('curve-net builder makes a sheet and solid tubes', () => {
    const r = run(`const net = Surface.Net().lengthwise([Curve.Line([0,0,0],[30,0,0]), Curve.Line([0,10,4],[30,10,4]), Curve.Line([0,20,0],[30,20,0])]);
      const tb = Surface.Tube(Curve.Line([0,0,0],[0,0,40]), 4);
      console.log(tb.volume() > 1900 && tb.volume() < 2050, net.pointAt(0.5,0.5).length);
      return [net.thicken(1), tb];`);
    expect(r.logs[0].message).toBe('true 3');
  });
  it('product skin from stations', () => {
    const out = logs(`const skin = Product.skin('body').axis('z').stations([
        Product.station('base').z(0).roundedRect(40, 30, 8),
        Product.station('mid').z(30).superEllipse(44, 32),
        Product.station('top').z(60).oval(30, 24)]).build();
      const f = skin.frame({ side: 'front', u: 0.5, v: 0.5 });
      console.log(skin.shape.volume() > 40000, f.normal.length); return skin.shape;`);
    expect(out[0]).toBe('true 3');
  });
  it('surface body bands on a cylinder carrier with diagnostics', () => {
    const out = logs(`const c = Carrier.cylinder('bottle').diameter(70).height(120);
      const body = SurfaceBody('clip').carrier(c);
      body.member('ring').path(c.path().around({ from: 0, to: 180, z: 40 })).section({ width: 10, thickness: 3 });
      body.member('pad').plate().at(c.anchor(90, 80)).size(20, 20).section({ thickness: 3 });
      body.join('ring', 'nope');
      const r = body.buildWithDiagnostics();
      console.log(r.shape.volume() > 0, r.diagnostics.map(d=>d.code).join(','));
      return r.shape;`);
    expect(out[0]).toBe('true join.memberMissing');
  });
});

describe('curves', () => {
  it('curve objects expose defining data', () => {
    const out = logs(`const n = Curve.Nurbs([[0,0,0],[10,5,0],[20,0,3]]); const h = Curve.Helix.withPitchAndTurns({ radius: 5, pitch: 2, turns: 3 });
      const f = Curve.Fit([[0,0,0],[10,5,0],[20,0,3]]);
      console.log(n.degree, n.knots.length, n.weights.join(','), h.height, h.ports.end.origin.map(v=>Math.round(v)+0).join(','), f.points.length);
      return box(1,1,1);`);
    expect(out[0]).toBe('2 6 1,1,1 6 5,0,6 3');
  });
  it('Curve.Bridge is a continuity builder', () => {
    const out = logs(`const b = Curve.Bridge({ point:[0,0,0], tangent:[1,0,0] }, { point:[10,10,0], tangent:[0,1,0] });
      const g2 = b.g2().bulge(1.2); const g0 = b.g0();
      console.log(b.continuity, g2.continuity, g2.bulgeValue, g0.pointAt(0.5).map(v=>v.toFixed(0)).join(','), b.pointAt(1).map(v=>v.toFixed(0)).join(','));
      return box(1,1,1);`);
    expect(out[0]).toBe('G1 G2 1.2 5,5,0 10,10,0');
  });
  it('slice stations loft through arbitrary frames', () => {
    const out = logs(`const s = Shape.fromSlices([
        Shape.slicePerpendicularToX(0, rect(10,10)),
        Shape.slicePerpendicularToX(20, circle2d(5)),
        Shape.sliceThrough([40,0,10], [1,0,1], rect(8,8))]);
      const old = Shape.slicePerpendicularToZ(box(10,10,10), 5);
      console.log(s.volume() > 2000, old.area().toFixed(0)); return s;`);
    expect(out[0]).toBe('true 100');
  });
});

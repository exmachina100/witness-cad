import { beforeAll, describe, expect, it } from 'vitest';
import { initNode } from '../src/kernel/node';
import { runProject } from '../src/kernel/runtime';

beforeAll(async () => { await initNode(); });
const ok = (src: string) => {
  const r = runProject({ files: { 'main.forge.js': src } }, {});
  if (!r.ok) throw new Error(r.error?.message);
  return r;
};
const logs = (src: string) => ok(src).logs.map((l: any) => l.message);

describe('API helpers', () => {
  it('Points and Transform helpers', () => {
    const out = logs(`console.log(Points.distance([0,0,0],[3,4,0]), Points.midpoint([0,0,0],[2,2,2]).join(','), Points.polar(10, 90)[1].toFixed(3));
      const m = Transform.rotationAxis([0,0,1], 90, [10,0,0]); console.log(Transform.apply(m, [20,0,0]).map(v=>v.toFixed(3)).join(','));
      const r = Transform.rotateAroundTo([0,0,1],[0,0,0],[1,0,0],[0,1,0]); console.log(Transform.apply(r,[5,0,0]).map(v=>v.toFixed(3)).join(','));
      return box(1,1,1);`);
    expect(out[0]).toBe('5 1,1,1 10.000');
    expect(out[1]).toBe('10.000,10.000,0.000');
    expect(out[2]).toBe('0.000,5.000,0.000');
  });
  it('Shape references, connectors, metadata and slices', () => {
    const out = logs(`const s = box(20,10,5).withConnectors({ a: connector.male('a', { origin:[10,0,2.5], axis:[1,0,0] }), b: connector.female('b', { origin:[-10,0,2.5], axis:[-1,0,0] }) })
        .withReferences({ points: { tip: [10,0,5] } }).withPhysicalMaterial(PhysicalMaterial.presets.pla()).withManufacturing(Manufacturing.print({ layer: 0.2 }));
      const t = s.translate(5,0,0);
      console.log(t.connectorDistance('a','b'), t.connectorsByType('male').length, t.referencePoint('tip').join(','), t.ref('top-front-left').join(','));
      console.log(t.physicalMaterial().id, t.manufacturing().process, t.numBodies(), t.geometryInfo().volume);
      const sk = Shape.slicePerpendicularToX(box(20,10,6), 0); console.log(sk.area().toFixed(1));
      return t;`);
    expect(out[0]).toBe('20 1 15,0,5 -5,-5,5');
    expect(out[1]).toBe('pla print 1 1000');
    expect(out[2]).toBe('60.0');
  });
  it('group connectors follow transforms', () => {
    const out = logs(`const g = group({ name: 'a', shape: box(10,10,10) }).withConnectors({ top: { origin:[0,0,10], axis:[0,0,1] } }).translate(0,0,5);
      console.log(g.connector('top').origin.join(','), g.childNames().join(','), g.portNames().join(','));
      return g;`);
    expect(out[0]).toBe('0,0,15 a top');
  });
  it('addJoint places a child without connectors', () => {
    const r = ok(`const a = assembly('A').addPart('base', box(20,20,5)).addPart('arm', box(4,4,30))
        .addJoint('hinge', 'revolute', 'base', 'arm', { origin: [0,0,5], axis: [1,0,0], min: -90, max: 90 });
      const s = a.solve({ hinge: 0 }); console.log(s.getPart('arm').boundingBox().max[2].toFixed(2));
      const s2 = a.solve({ hinge: 90 }); console.log(Math.abs(s2.getPart('arm').boundingBox().max[2]).toFixed(2));
      return a;`);
    const m = r.logs.map((l: any) => l.message);
    expect(m[0]).toBe('35.00');
    expect(Number(m[1])).toBeLessThan(10);
  });
  it('route builder, optics and wood joinery', () => {
    const out = logs(`const r = route([0,0]).right(10).up(10).arcLeft(5, 90).left(10).done();
      console.log(r.end.map(v=>v.toFixed(2)).join(','), r.length.toFixed(2));
      console.log(Optics.thinLens({ focalLength: 50, objectDistance: 100 }).imageDistance);
      const board = Wood.board(100, 50, 18);
      const d = Wood.dado(board, 'top', { width: 18, depth: 6 });
      const rb = Wood.rabbet(board, 'top', 'right', { width: 10, depth: 9 });
      console.log((board.volume() - d.volume()).toFixed(0), (board.volume() - rb.volume()).toFixed(0), lib.gearRatio(10, 20));
      return d;`);
    expect(out[0]).toBe('-5.00,15.00 37.85');
    expect(out[1]).toBe('100');
    const [dv, rv, gr] = out[2].split(' ').map(Number);
    expect(dv).toBeCloseTo(10800, -2); expect(rv).toBeCloseTo(4500, -1); expect(gr).toBe(-2);
  });
});

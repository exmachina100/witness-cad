import { beforeAll, describe, expect, it } from 'vitest';
import { initNode } from '../src/kernel/node';
import { runProject } from '../src/kernel/runtime';

beforeAll(async () => { await initNode(); });
const run = (src: string) => { const r = runProject({ files: { 'main.forge.js': src } }, {}); if (!r.ok) throw new Error(r.error?.message); return r; };
const logs = (src: string) => run(src).logs.map((l: any) => String(l.message));

describe('core object model', () => {
  it('Transform objects chain and still act as matrices', () => {
    const out = logs(`const t = Transform.translation(10,0,0).rotateZ(90); console.log(t.point([0,0,0]).map(v=>v.toFixed(3)).join(','), t.inverse().point(t.point([1,2,3])).map(v=>v.toFixed(3)).join(','), t.toArray().length);
      return box(1,1,1).transform(t);`);
    expect(out[0]).toBe('0.000,10.000,0.000 1.000,2.000,3.000 16');
  });
  it('shape.ref resolves points, faces and edges', () => {
    const out = logs(`const b = box(20,10,4); const p = b.ref('top-front-left'), f = b.ref('top'), e = b.ref('top.edges');
      console.log(p.kind, p.join(','), f.kind, f.face().name, e.kind, e.edges().length, b.ref('nope').status().ok); return b;`);
    expect(out[0]).toBe('point -10,-5,4 face top edges 4 false');
  });
  it('split results answer inside/outside and positive/negative', () => {
    const out = logs(`const b = box(20,20,20); const s = b.split(box(10,10,40)); const p = b.splitBySurface({ origin:[0,0,10], normal:[0,0,1] });
      console.log(s.inside().volume().toFixed(0), s.outside().volume().toFixed(0), p.positive().volume().toFixed(0), b.trimBySurface({ origin:[0,0,5], normal:[0,0,1] }).volume().toFixed(0)); return b;`);
    expect(out[0]).toBe('2000 6000 4000 6000');
  });
  it('2D geometry classes', () => {
    const out = logs(`const l = Line2D.fromCoordinates(0,0,10,0); const m = Line2D.fromPointAndAngle(new Point2D(5,-5), 90, 10);
      const r = Rectangle2D.fromCenterAndDimensions([0,0], 20, 10); const c = new Circle2D([0,0], 5);
      console.log(l.length, l.intersect(m).x.toFixed(0), r.side('top').length, r.vertex('top-right').x, r.diagonals()[0].length.toFixed(2), c.area.toFixed(2), r.extrude(3).volume());
      return c.extrude(2);`);
    expect(out[0]).toBe('10 5 20 10 22.36 78.54 600');
  });
  it('param value objects', () => {
    const out = logs(`const p = Param.path2d('P', [[0,0],[10,0],[10,10]]); const s = Param.spline2d('S', [[0,0],[10,5],[20,0]], { closed: false });
      console.log(p.closed, p.points().length, s.degree, s.nodes().length, s.toPathOnXY(2).pointAt(1)[2], s.toCurveSegmentsOnXZ().length);
      return p.toStroke(2).extrude(1);`);
    expect(out[0]).toBe('true 3 3 3 2 2');
  });
});

describe('library objects', () => {
  it('tangent loops measure wraps and spans', () => {
    const out = logs(`const L = lib.tangentLoop2d([{ center:[0,0], radius:10, name:'a' }, { center:[50,0], radius:10, name:'b' }]);
      console.log(L.length.toFixed(2), L.straightSpans.length, Math.round(L.wrapByPulley.a), L.offsetBand(2).area().toFixed(0));
      return L.toSketch(2).extrude(5);`);
    expect(out[0].split(' ')[0]).toBe((100 + 20 * Math.PI).toFixed(2));
    expect(out[0].split(' ').slice(1, 3).join(' ')).toBe('2 180');
  });
  it('flat laser parts with finger and tab joints', () => {
    const out = logs(`const a = Laser.panel('base', 100, 60, 3); const b = Laser.panel('side', 100, 40, 3);
      const j = Laser.fingerJoint(a, 'top', b, 'bottom', { foldAngle: 90 });
      const kit = Laser.kit({ sheetWidth: 300, sheetHeight: 200, material: 'plywood' }).addPart(a).addPart(b, { qty: 2 });
      const prev = kit.assemblyPreview();
      console.log(a.joints.length, j.options.fingers % 2, kit.cutSheets().length, kit.bom()[1].quantity, Object.keys(kit.partSvgs()).length, kit.inventorySvg().startsWith('<svg'), kit.formatInstructions().includes('Join base'));
      console.log(prev.child('side').boundingBox().size[2].toFixed(1), a.solid().volume() < 100*60*3);
      return prev;`);
    expect(out[0]).toBe('1 1 1 2 2 true true');
    expect(out[1]).toBe('40.0 true');
  });
  it('wood boards keep stock info through cuts', () => {
    const out = logs(`const shelf = Wood.board(300, 200, 18, { species: 'oak' }); const side = Wood.board(18, 200, 400).translate(150 - 9 + 6, 0, 0);
      const d = Wood.dado(side, shelf.translate(0,0,150)); const mt = Wood.mortiseAndTenon(side, shelf.translate(0,0,250));
      console.log(shelf.species, shelf.thickness, d.width, d.volume() < side.volume(), mt.tenon.volume() < shelf.volume(), shelf.material().species);
      return d;`);
    expect(out[0]).toBe('oak 18 18 true true oak');
  });
});

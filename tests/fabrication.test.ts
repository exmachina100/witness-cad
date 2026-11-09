import { beforeAll, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { initNode, ensureStepReaderNode } from '../src/kernel/node';
import { runProject } from '../src/kernel/runtime';
import { exportModel } from '../src/export';

beforeAll(async () => { await initNode(); });
const run = (src: string, files: Record<string, string> = {}) => {
  const r = runProject({ files: { 'main.forge.js': src, ...files } }, {});
  if (!r.ok) throw new Error(r.error?.message);
  return r;
};
const logs = (src: string, files: Record<string, string> = {}) => run(src, files).logs.map((l: any) => l.message);

const DXF = ['0', 'SECTION', '2', 'ENTITIES',
  '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1', '10', '0', '20', '0', '10', '40', '20', '0', '10', '40', '20', '20', '10', '0', '20', '20',
  '0', 'CIRCLE', '8', '0', '10', '20', '20', '10', '40', '5',
  '0', 'LINE', '8', '0', '10', '50', '20', '0', '11', '60', '21', '0',
  '0', 'LINE', '8', '0', '10', '60', '20', '0', '11', '60', '21', '10',
  '0', 'LINE', '8', '0', '10', '60', '20', '10', '11', '50', '21', '0',
  '0', 'ENDSEC', '0', 'EOF'].join('\n');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="10" height="10"/><path d="M20 0 L30 0 L30 10 Z"/></svg>';
const OBJ = `v 0 0 0\nv 10 0 0\nv 0 10 0\nv 0 0 10\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n`;

describe('imports', () => {
  it('reads DXF outlines with holes and chained lines', () => {
    const out = logs(`const s = Import.dxfSketch('part.dxf'); console.log(s.area().toFixed(0)); return s.extrude(2);`, { 'part.dxf': DXF });
    expect(Number(out[0])).toBeCloseTo(800 - Math.PI * 25 + 50, -1);
  });
  it('reads SVG shapes', () => {
    const out = logs(`console.log(Import.svgSketch('logo.svg').area().toFixed(0)); return box(1,1,1);`, { 'logo.svg': SVG });
    expect(out[0]).toBe('150');
  });
  it('reads OBJ and STL meshes, and 3MF from a data URL', async () => {
    const out = logs(`console.log(Import.mesh('t.obj').volume().toFixed(2)); return box(1,1,1);`, { 't.obj': OBJ });
    expect(Number(out[0])).toBeCloseTo(1000 / 6, 1);
    const model = '<?xml version="1.0"?><model unit="millimeter"><resources><object id="1" name="tet"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object></resources></model>';
    const zip = zipSync({ '3D/3dmodel.model': strToU8(model) });
    const url = 'data:model/3mf;base64,' + Buffer.from(zip).toString('base64');
    const out2 = logs(`console.log(Import.mesh('t.3mf').volume().toFixed(2)); return box(1,1,1);`, { 't.3mf': url });
    expect(Number(out2[0])).toBeCloseTo(1000 / 6, 1);
  });
  it('reads STEP through OpenCascade', async () => {
    const text = exportModel(run('return box(20, 10, 5);'), 'step', { name: 'box' }).data as string;
    expect(await ensureStepReaderNode()).toBe(true);
    const out = logs(`const s = Import.step('box.step'); console.log(s.volume().toFixed(0)); return s;`, { 'box.step': text });
    expect(Number(out[0])).toBeCloseTo(1000, -1);
  });
});

describe('sheet metal and laser', () => {
  it('folds flanges and unfolds a flat pattern with bend allowance', () => {
    const out = logs(`const rule = SheetMetal.ruleFromGauge(16, 'steel');
      const p = sheetMetal({ width: 100, height: 60, rule }).flange('right', { length: 20 }).flange('left', { length: 20 }).cutout(circle2d(5));
      const flat = p.flatPattern(), f = p.folded();
      const ba = rule.bendAllowance(90);
      console.log(rule.thickness, p.regionNames().join(','), flat.bounds().width.toFixed(3), (100 + 2 * (ba + 20)).toFixed(3));
      console.log(f.boundingBox().size.map(v => v.toFixed(2)).join(','), f.numBodies());
      return f;`);
    const [t, regions, w, want] = out[0].split(' ');
    expect(Number(t)).toBeCloseTo(1.519);
    expect(regions).toBe('base,flange-right,flange-left');
    expect(w).toBe(want);
    const size = out[1].split(' ')[0].split(',').map(Number);
    expect(size[0]).toBeCloseTo(100 + 2 * (1.519 * 2), 1);
    expect(size[2]).toBeCloseTo(1.519 * 2 + 20, 1);
  });
  it('builds a laser kit, nests it and writes instructions', () => {
    const out = logs(`const t = 3;
      const side = Laser.panel({ width: 120, height: 80, thickness: t, material: 'plywood', holes: [{ x: 0, y: 0, d: 10 }] });
      const top = Laser.part(rect(120, 120), { thickness: t, material: 'plywood' });
      const kit = Laser.kit([{ name: 'side', shape: side, quantity: 4 }, { name: 'top', shape: top }], { sheetWidth: 300, sheetHeight: 300 });
      const ins = Laser.instructions(kit);
      console.log(Laser.lookupKerf('plywood', 3), kit.sheetCount(), ins.steps.length, Laser.formatInstructions(ins).includes('4 x side'));
      console.log(kit.toSvg(0).startsWith('<svg'), Laser.tabSlot({ length: 60, thickness: 3 }).centers.length);
      return kit;`);
    expect(out[0]).toBe('0.15 1 2 true');
    expect(out[1]).toBe('true 3');
  });
});

describe('constrained sketch extras', () => {
  it('solves shape width, area and centroid constraints', () => {
    const out = logs(`const cs = constrainedSketch();
      const r = cs.groupRect({ width: 20 });
      cs.fix(r.points[0], 0, 0);
      cs.shapeArea(r, 300);
      const s = cs.solve();
      const sk = s.toSketch(); const b = sk.bounds();
      console.log(sk.area().toFixed(1), b.width.toFixed(2));
      return sk;`);
    expect(out[0]).toBe('300.0 20.00');
  });
});

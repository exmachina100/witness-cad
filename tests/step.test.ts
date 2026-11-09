// Exact STEP export: files are read back with OpenCascade and compared with the true geometry.
import { beforeAll, describe, expect, it } from 'vitest';
import { initNode } from '../src/kernel/node';
import { runProject } from '../src/kernel/runtime';
import { exportModel } from '../src/export';
import { worldMeshes } from '../src/export/mesh';
import { buildBrep } from '../src/export/brep';
import { contourPieces } from '../src/kernel/surfaces';
import { readStep } from './helpers/occt';

beforeAll(async () => { await initNode(); });

const build = (src: string) => {
  const r = runProject({ files: { 'main.forge.js': src } }, {});
  if (!r.ok) throw new Error(r.error?.message);
  return r;
};
const step = (src: string) => exportModel(build(src), 'step', { name: 'part' }).data as string;
const PI = Math.PI;

describe('exact STEP export', () => {
  // [script, true volume, expected B-rep face count]. Low segment counts make the mesh visibly wrong,
  // so a STEP volume close to the true one proves the surfaces are exact.
  const cases: [string, string, number, number][] = [
    ['box', 'return box(20, 10, 5);', 1000, 6],
    ['cylinder', 'return cylinder(20, 5, undefined, 12);', PI * 25 * 20, 3],
    ['cone', 'return cylinder(10, 5, 0, 12);', (PI * 25 * 10) / 3, 2],
    ['frustum', 'return cylinder(10, 5, 3, 12);', ((PI * 10) / 3) * (25 + 15 + 9), 3],
    ['sphere', 'return sphere(10, 12);', (4 / 3) * PI * 1000, 2],
    ['torus', 'return circle2d(4).translate(12, 0).revolve();', 2 * PI * PI * 12 * 16, 2],
    ['plate with hole', 'return box(40, 30, 10).subtract(cylinder(30, 5, undefined, 12).translate(0, 0, -10));', 12000 - PI * 25 * 10, 7],
    ['hole() feature', 'return box(40, 40, 10).hole("top", { diameter: 6 });', 16000 - PI * 9 * 10, 7],
    ['rounded extrusion', 'return roundedRect(40, 20, 5).extrude(10);', (40 * 20 - (4 - PI) * 25) * 10, 10],
    ['hollow box', 'return box(20, 20, 20).subtract(box(10, 10, 10).translate(0, 0, 5));', 7000, 12],
    ['capsule', 'return cylinder(20, 5, undefined, 16).add(sphere(5, 16)).add(sphere(5, 16).translate(0, 0, 20));', PI * 25 * 20 + (4 / 3) * PI * 125, 3],
  ];
  for (const [name, src, volume, faces] of cases)
    it(`${name}: true surfaces, exact volume`, async () => {
      const text = step(src);
      expect(text).toContain('ADVANCED_BREP_SHAPE_REPRESENTATION');
      expect(text).not.toContain('FACETED_BREP');
      const rb = await readStep(text, 0.002);
      expect(rb.ok).toBe(true);
      expect(rb.faces).toBe(faces);
      expect(Math.abs(rb.volume - volume) / volume).toBeLessThan(2e-3);
    }, 60000);

  it('writes analytic surface and curve entities', () => {
    const text = step('return box(40, 30, 10).subtract(cylinder(30, 5).translate(0, 0, -10)).add(sphere(4).translate(30, 0, 5)).add(cylinder(5, 3, 1).translate(-25, 0, 10));');
    for (const e of ['PLANE(', 'CYLINDRICAL_SURFACE(', 'SPHERICAL_SURFACE(', 'CONICAL_SURFACE(', 'CIRCLE(', 'LINE(']) expect(text).toContain(e);
  });

  it('fits B-spline edges where two cylinders cross', async () => {
    const text = step('return cylinder(40, 10).subtract(cylinder(40, 4).rotateX(90).translate(0, 20, 20));');
    expect(text).toContain('B_SPLINE_CURVE_WITH_KNOTS');
    const rb = await readStep(text);
    expect(rb.faces).toBe(4);
  });

  it('keeps exact surfaces through rotations, mirrors and assemblies', async () => {
    const rot = await readStep(step('return box(40, 20, 10).subtract(cylinder(30, 4, undefined, 12).translate(0, 0, -5)).rotateX(37).rotateZ(12).translate(3.3, 1.7, 0);'), 0.002);
    expect(rot.faces).toBe(7);
    expect(Math.abs(rot.volume - (8000 - PI * 16 * 10)) / 8000).toBeLessThan(2e-3);
    const mir = await readStep(step('return cylinder(10, 5).add(box(20, 4, 4)).mirror([1, 0, 0]);'));
    expect(mir.faces).toBeLessThan(15);
  });

  it('falls back to flat facets for surfaces it cannot trace', () => {
    const b = buildBrep(worldMeshes(build('return cylinder(10, 5, undefined, 16).scale([1, 2, 1]);').objects)[0]);
    expect(b.curvedFaces).toBe(0);
    expect(b.faces.length).toBe(18);
  });

  it('exports every example as exact B-rep', async () => {
    const { EXAMPLES } = await import('../src/app/examples');
    for (const ex of EXAMPLES) {
      const r = runProject({ files: ex.files }, {});
      if (!r.ok) continue;
      const text = exportModel(r, 'step').data as string;
      expect(text, ex.id).toContain('exact B-rep');
      const rb = await readStep(text, 0.05);
      const mv = r.objects.filter((o) => o.kind === 'solid' && !o.mock).reduce((s, o) => s + o.stats!.volume, 0);
      expect(Math.abs(rb.volume - mv) / mv, ex.id).toBeLessThan(0.01);
    }
  }, 120000);
});

describe('profile analysis', () => {
  it('finds arcs and straight sides in a rounded rectangle', () => {
    const pts: [number, number][] = [];
    const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= 8; i++) { const a = a0 + (i / 8) * (PI / 2); pts.push([cx + 5 * Math.cos(a), cy + 5 * Math.sin(a)]); } };
    corner(15, 5, 0); corner(-15, 5, PI / 2); corner(-15, -5, PI); corner(15, -5, 1.5 * PI);
    const pieces = contourPieces(pts);
    expect(pieces.filter((p) => p.kind === 'arc')).toHaveLength(4);
    for (const p of pieces) if (p.kind === 'arc') expect(p.r).toBeCloseTo(5, 9);
  });
  it('does not mistake a hexagon for a circle', () => {
    const hex: [number, number][] = Array.from({ length: 6 }, (_, i) => [10 * Math.cos((i * PI) / 3), 10 * Math.sin((i * PI) / 3)]);
    expect(contourPieces(hex).every((p) => p.kind === 'line')).toBe(true);
  });
});

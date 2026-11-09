// OpenCascade native BREP (text, "CASCADE Topology V1") export: a closed shell of planar triangular
// faces per body, with shared edges and vertices, wrapped as solids in a compound.
import type { ExportMesh } from './mesh';
import { weld } from './weld';

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const nrm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const f = (v: number) => { const s = (Math.abs(v) < 1e-15 ? 0 : v).toPrecision(15); return String(Number(s)); };

export function toOccBrep(meshes: ExportMesh[]): string {
  const curves2d: string[] = [], curves: string[] = [], surfaces: string[] = [];
  // Shapes are collected children-first; references are written as (count - index + 1).
  const shapes: { text: (ref: (i: number) => number) => string }[] = [];
  const add = (text: (ref: (i: number) => number) => string) => { shapes.push({ text }); return shapes.length; };
  const solids: number[] = [];

  for (const m of meshes) {
    const { pos, tri } = weld(m);
    if (!tri.length) continue;
    const P = (i: number): V3 => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    const vIdx = new Map<number, number>();
    const vertex = (i: number) => {
      let s = vIdx.get(i);
      if (s == null) { const p = P(i); s = add(() => `Ve\n1e-07\n${f(p[0])} ${f(p[1])} ${f(p[2])}\n0 0\n\n0101101\n*`); vIdx.set(i, s); }
      return s;
    };
    // Edges: one per undirected pair, line from lower to higher vertex index, with a pcurve per adjacent face.
    const edges = new Map<string, { a: number; b: number; curve: number; L: number; pcurves: { c2d: number; surf: number }[]; shape?: number }>();
    const faces: { surf: number; loop: { key: string; forward: boolean }[] }[] = [];
    for (let t = 0; t < tri.length; t += 3) {
      const ids = [tri[t], tri[t + 1], tri[t + 2]];
      const [A, B, C] = ids.map(P);
      const n = cross(sub(B, A), sub(C, A));
      if (len(n) < 1e-14) continue;
      const N = nrm(n), X = nrm(sub(B, A)), Y = cross(N, X);
      surfaces.push(`1 ${A.map(f).join(' ')} ${N.map(f).join(' ')} ${X.map(f).join(' ')} ${Y.map(f).join(' ')}`);
      const surf = surfaces.length;
      const loop: { key: string; forward: boolean }[] = [];
      for (let k = 0; k < 3; k++) {
        const i0 = ids[k], i1 = ids[(k + 1) % 3];
        const a = Math.min(i0, i1), b = Math.max(i0, i1), key = `${a}_${b}`;
        let e = edges.get(key);
        if (!e) {
          const pa = P(a), d = sub(P(b), pa), L = len(d), dir = nrm(d);
          curves.push(`1 ${pa.map(f).join(' ')} ${dir.map(f).join(' ')}`);
          e = { a, b, curve: curves.length, L, pcurves: [] };
          edges.set(key, e);
        }
        const pa = P(a), dir = nrm(sub(P(b), pa)), rel = sub(pa, A);
        curves2d.push(`1 ${f(dot(rel, X))} ${f(dot(rel, Y))} ${f(dot(dir, X))} ${f(dot(dir, Y))}`);
        e.pcurves.push({ c2d: curves2d.length, surf });
        loop.push({ key, forward: i0 === a });
      }
      faces.push({ surf, loop });
    }
    for (const e of edges.values()) {
      const va = vertex(e.a), vb = vertex(e.b);
      const reps = [`1  ${e.curve} 0 0 ${f(e.L)}`, ...e.pcurves.map((p) => `2  ${p.c2d} ${p.surf} 0 0 ${f(e.L)}`)].join('\n');
      e.shape = add((ref) => `Ed\n 1e-07 1 1 0\n${reps}\n0\n\n0101000\n+${ref(va)} 0 -${ref(vb)} 0 *`);
    }
    const faceShapes: number[] = [];
    for (const fc of faces) {
      const es = fc.loop.map((l) => ({ s: edges.get(l.key)!.shape!, o: l.forward ? '+' : '-' }));
      const wire = add((ref) => `Wi\n\n0101100\n${es.map((e) => `${e.o}${ref(e.s)} 0`).join(' ')} *`);
      faceShapes.push(add((ref) => `Fa\n0  1e-07 ${fc.surf} 0\n\n0101000\n+${ref(wire)} 0 *`));
    }
    const shell = add((ref) => `Sh\n\n0101100\n${faceShapes.map((s) => `+${ref(s)} 0`).join(' ')} *`);
    solids.push(add((ref) => `So\n\n0100000\n+${ref(shell)} 0 *`));
  }
  const root = add((ref) => `Co\n\n1100000\n${solids.map((s) => `+${ref(s)} 0`).join(' ')} *`);
  const N = shapes.length, ref = (i: number) => N - i + 1;
  return [
    'DBRep_DrawableShape', '', 'CASCADE Topology V1, (c) Matra-Datavision', 'Locations 0',
    `Curve2ds ${curves2d.length}`, ...curves2d,
    `Curves ${curves.length}`, ...curves,
    'Polygon3D 0', 'PolygonOnTriangulations 0',
    `Surfaces ${surfaces.length}`, ...surfaces,
    'Triangulations 0', '',
    `TShapes ${N}`, ...shapes.map((s) => s.text(ref)), '',
    `+${ref(root)} 0`, '',
  ].join('\n');
}

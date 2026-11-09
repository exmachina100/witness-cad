// 2D outlines of the built model (projection or section) for DXF and SVG export.
import { K } from '../kernel/wasm';
import { Sketch } from '../kernel/sketch';
import { mat4 } from '../kernel/math';
import { sketchToDxf, sketchToSvg } from '../kernel/output';
import type { ExportMesh } from './mesh';

export type OutlineView = 'top' | 'front' | 'right' | 'section';
const VIEW_ROT: Record<string, number[]> = {
  top: mat4.identity(),
  front: mat4.axisAngle([1, 0, 0], -90), // looking along +y: x right, z up
  right: mat4.mul(mat4.axisAngle([1, 0, 0], -90), mat4.axisAngle([0, 0, 1], -90)),
};

/** Union of every solid, projected onto the view plane (or sliced at `at` along Z for 'section'). */
export function outlineSketch(meshes: ExportMesh[], o: { view?: OutlineView; at?: number } = {}): Sketch {
  const k = K();
  const parts = meshes.map((m) => { const mesh = new k.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices }); mesh.merge(); return new k.Manifold(mesh); });
  let all = k.Manifold.union(parts);
  const view = o.view ?? 'top';
  if (view === 'section') {
    const bb = all.boundingBox();
    const z = o.at ?? (bb.min[2] + bb.max[2]) / 2;
    return new Sketch(all.slice(z));
  }
  all = all.transform(VIEW_ROT[view] as any);
  return new Sketch(all.project());
}
export const outlineDxf = (m: ExportMesh[], o: { view?: OutlineView; at?: number } = {}) => sketchToDxf(outlineSketch(m, o));
export const outlineSvg = (m: ExportMesh[], o: { view?: OutlineView; at?: number } = {}) => sketchToSvg(outlineSketch(m, o), { strokeWidth: 0.2 });

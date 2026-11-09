// Merge coincident vertices of an export mesh so faces share vertices and edges.
import type { ExportMesh } from './mesh';

export function weld(m: ExportMesh, eps = 1e-6): { pos: number[]; tri: number[] } {
  const map = new Map<string, number>(), remap: number[] = [], pos: number[] = [];
  const q = (v: number) => Math.round(v / eps);
  for (let i = 0; i < m.positions.length / 3; i++) {
    const k = `${q(m.positions[i * 3])},${q(m.positions[i * 3 + 1])},${q(m.positions[i * 3 + 2])}`;
    let r = map.get(k);
    if (r == null) { r = pos.length / 3; map.set(k, r); pos.push(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]); }
    remap.push(r);
  }
  const tri: number[] = [];
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = remap[m.indices[i]], b = remap[m.indices[i + 1]], c = remap[m.indices[i + 2]];
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  }
  return { pos, tri };
}

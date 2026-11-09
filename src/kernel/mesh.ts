// Mesh extraction and analysis helpers shared by topology queries, exports and checks.
import type { Manifold } from 'manifold-3d';
import { v3, Vec3 } from './math';

export interface TriMesh {
  positions: Float32Array; // xyz per vertex
  indices: Uint32Array; // 3 per triangle
}

export function toTriMesh(m: Manifold): TriMesh {
  const mesh = m.getMesh();
  const np = mesh.numProp;
  const nv = mesh.vertProperties.length / np;
  const positions = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    positions[i * 3] = mesh.vertProperties[i * np];
    positions[i * 3 + 1] = mesh.vertProperties[i * np + 1];
    positions[i * 3 + 2] = mesh.vertProperties[i * np + 2];
  }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}

export function vert(m: TriMesh, i: number): Vec3 {
  return [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
}

export function triNormal(m: TriMesh, t: number): Vec3 {
  const a = vert(m, m.indices[t * 3]), b = vert(m, m.indices[t * 3 + 1]), c = vert(m, m.indices[t * 3 + 2]);
  return v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));
}

export function triArea(m: TriMesh, t: number): number {
  const a = vert(m, m.indices[t * 3]), b = vert(m, m.indices[t * 3 + 1]), c = vert(m, m.indices[t * 3 + 2]);
  return v3.len(v3.cross(v3.sub(b, a), v3.sub(c, a))) / 2;
}

export function triCentroid(m: TriMesh, t: number): Vec3 {
  const a = vert(m, m.indices[t * 3]), b = vert(m, m.indices[t * 3 + 1]), c = vert(m, m.indices[t * 3 + 2]);
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

export interface FeatureEdge {
  a: Vec3;
  b: Vec3;
  t1: number; // triangle on one side
  t2: number; // triangle on the other side
  n1: Vec3;
  n2: Vec3;
  convex: boolean;
  angleDeg: number; // dihedral deviation from flat
}

/** Edges whose adjacent triangles meet at more than `minAngleDeg`. */
export function featureEdges(m: TriMesh, minAngleDeg = 20): FeatureEdge[] {
  // Weld vertices by position so edges match across property splits.
  const key = (i: number) => `${m.positions[i * 3].toFixed(5)},${m.positions[i * 3 + 1].toFixed(5)},${m.positions[i * 3 + 2].toFixed(5)}`;
  const weld = new Map<string, number>();
  const id = new Uint32Array(m.positions.length / 3);
  for (let i = 0; i < id.length; i++) {
    const k = key(i);
    let w = weld.get(k);
    if (w === undefined) { w = i; weld.set(k, i); }
    id[i] = w;
  }
  const edges = new Map<string, { a: number; b: number; tris: number[] }>();
  const nt = m.indices.length / 3;
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const i = id[m.indices[t * 3 + e]], j = id[m.indices[t * 3 + ((e + 1) % 3)]];
      const k = i < j ? `${i}_${j}` : `${j}_${i}`;
      let rec = edges.get(k);
      if (!rec) { rec = { a: Math.min(i, j), b: Math.max(i, j), tris: [] }; edges.set(k, rec); }
      rec.tris.push(t);
    }
  }
  const cosLim = Math.cos((minAngleDeg * Math.PI) / 180);
  const out: FeatureEdge[] = [];
  for (const rec of edges.values()) {
    if (rec.tris.length !== 2) continue;
    const [t1, t2] = rec.tris;
    const n1 = triNormal(m, t1), n2 = triNormal(m, t2);
    const d = v3.dot(n1, n2);
    if (d > cosLim) continue;
    const a = vert(m, rec.a), b = vert(m, rec.b);
    // Convex when tri2's far vertex lies behind tri1's plane.
    let far: Vec3 = a;
    for (let k = 0; k < 3; k++) {
      const vi = id[m.indices[t2 * 3 + k]];
      if (vi !== rec.a && vi !== rec.b) far = vert(m, vi);
    }
    const convex = v3.dot(v3.sub(far, a), n1) < 1e-9;
    out.push({ a, b, t1, t2, n1, n2, convex, angleDeg: (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI });
  }
  return out;
}

export function meshBounds(m: TriMesh): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], m.positions[i + k]);
      max[k] = Math.max(max[k], m.positions[i + k]);
    }
  return { min, max };
}

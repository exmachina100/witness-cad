// Exact B-rep reconstruction for STEP export.
//
// The kernel works on triangle meshes, but every triangle remembers which primitive it came from and
// that primitive's exact surfaces (kernel/surfaces.ts). Here we:
//   1. assign each triangle to the exact surface it lies on (plane, cylinder, cone, sphere, torus),
//      falling back to coplanar grouping for triangles with no recorded surface;
//   2. merge connected triangles on the same surface into B-rep faces;
//   3. rebuild the topology: vertices where three or more faces meet, edges between pairs of faces,
//      and the oriented loops that bound each face;
//   4. snap vertices and edge points onto the exact surfaces and fit each edge as a line, a circle or
//      an interpolating cubic B-spline.
// The result is written as AP214 ADVANCED_BREP geometry, which CAD tools open as true surfaces.
import type { ExportMesh } from './mesh';
import type { ProfileHint, SurfaceDef } from '../kernel/surfaces';
import { mat4, Mat4, v3, Vec2, Vec3 } from '../kernel/math';
import { closestOnSurface, NurbsSurface, surfaceNormal, transformSurfaceNurbs } from '../kernel/nurbs';

type Analytic = Exclude<SurfaceDef, { type: 'nurbs' }>;
/**
 * A surface in export coordinates: an analytic surface, a NURBS surface, or an analytic surface seen
 * through a non-uniform scale (`mapped`, e.g. an elliptic cylinder or an ellipsoid), which is written
 * out as an exact rational B-spline.
 */
export type Surf =
  | Analytic
  | { type: 'nurbs'; surf: NurbsSurface; tol: number; key: string; hint?: ProfileHint; M?: Mat4; Minv?: Mat4 }
  | { type: 'mapped'; base: Analytic; M: Mat4; Minv: Mat4; tol: number; key: string; range?: [number, number] };

export class BrepError extends Error {}

// ------------------------------------------------------------------ surface maths

function project(s: Surf, p: Vec3): Vec3 {
  if (s.type === 'nurbs') return closestOnSurface(s.surf, p).p;
  if (s.type === 'mapped') return mat4.apply(s.M, projectA(s.base, mat4.apply(s.Minv, p)));
  return projectA(s, p);
}

function normalAt(s: Surf, p: Vec3): Vec3 {
  if (s.type === 'nurbs') { const c = closestOnSurface(s.surf, p); return surfaceNormal(s.surf, c.u, c.v); }
  if (s.type === 'mapped') {
    const q = projectA(s.base, mat4.apply(s.Minv, p));
    const n = normalAtA(s.base, q), m = s.Minv;
    return v3.norm([m[0] * n[0] + m[1] * n[1] + m[2] * n[2], m[4] * n[0] + m[5] * n[1] + m[6] * n[2], m[8] * n[0] + m[9] * n[1] + m[10] * n[2]]);
  }
  return normalAtA(s, p);
}

function projectA(s: Analytic, p: Vec3): Vec3 {
  switch (s.type) {
    case 'plane': return v3.sub(p, v3.scale(s.normal, v3.dot(v3.sub(p, s.origin), s.normal)));
    case 'cylinder': {
      const q = v3.sub(p, s.origin), h = v3.dot(q, s.axis);
      const rad = v3.sub(q, v3.scale(s.axis, h));
      const l = v3.len(rad);
      const u: Vec3 = l > 1e-12 ? v3.scale(rad, 1 / l) : v3.perp(s.axis);
      return v3.add(s.origin, v3.add(v3.scale(s.axis, h), v3.scale(u, s.radius)));
    }
    case 'cone': {
      const q = v3.sub(p, s.origin), h = v3.dot(q, s.axis);
      const rad = v3.sub(q, v3.scale(s.axis, h));
      const rho = v3.len(rad);
      const u: Vec3 = rho > 1e-12 ? v3.scale(rad, 1 / rho) : v3.perp(s.axis);
      const k = s.slope;
      const t = (h + (rho - s.radius) * k) / (1 + k * k);
      const r = Math.max(0, s.radius + k * t);
      return v3.add(s.origin, v3.add(v3.scale(s.axis, t), v3.scale(u, r)));
    }
    case 'sphere': {
      const d = v3.sub(p, s.center), l = v3.len(d);
      return l > 1e-12 ? v3.add(s.center, v3.scale(d, s.radius / l)) : v3.add(s.center, [0, 0, s.radius]);
    }
    case 'torus': {
      const q = v3.sub(p, s.center), h = v3.dot(q, s.axis);
      const rad = v3.sub(q, v3.scale(s.axis, h));
      const l = v3.len(rad);
      const u: Vec3 = l > 1e-12 ? v3.scale(rad, 1 / l) : v3.perp(s.axis);
      const ring = v3.add(s.center, v3.scale(u, s.major));
      const d = v3.sub(p, ring), dl = v3.len(d);
      return dl > 1e-12 ? v3.add(ring, v3.scale(d, s.minor / dl)) : v3.add(ring, v3.scale(u, s.minor));
    }
  }
}

/** The surface's own normal (outward from the axis or centre; the plane's stored normal). */
function normalAtA(s: Analytic, p: Vec3): Vec3 {
  switch (s.type) {
    case 'plane': return s.normal;
    case 'cylinder': case 'cone': {
      const q = v3.sub(p, s.origin), h = v3.dot(q, s.axis);
      const u = v3.norm(v3.sub(q, v3.scale(s.axis, h)));
      return s.type === 'cylinder' ? u : v3.norm(v3.sub(u, v3.scale(s.axis, s.slope)));
    }
    case 'sphere': return v3.norm(v3.sub(p, s.center));
    case 'torus': {
      const q = v3.sub(p, s.center), h = v3.dot(q, s.axis);
      const u = v3.norm(v3.sub(q, v3.scale(s.axis, h)));
      return v3.norm(v3.sub(p, v3.add(s.center, v3.scale(u, s.major))));
    }
  }
}

const dist = (s: Surf, p: Vec3) => v3.dist(p, project(s, p));

/** Project onto several surfaces at once by cycling projections (converges for transversal surfaces). */
function projectAll(ss: Surf[], p: Vec3, iters = 60): Vec3 {
  if (ss.length === 1) return project(ss[0], p);
  if (ss.every((s) => s.type === 'plane')) return nearestOnPlanes(ss as Extract<Surf, { type: 'plane' }>[], p);
  let q = p;
  const eps = 1e-12 * Math.max(1, v3.len(p));
  for (let i = 0; i < iters; i++) {
    const prev = q;
    for (const s of ss) q = project(s, q);
    if (v3.dist(prev, q) < eps) break;
  }
  return q;
}

/** Point closest to p that satisfies every plane equation (least squares, regularised towards p). */
function nearestOnPlanes(ps: Extract<Surf, { type: 'plane' }>[], p: Vec3): Vec3 {
  // minimise |x - p|^2 * w + sum (n.x - d)^2 with tiny w: (N^T N + w I) x = N^T d + w p
  const w = 1e-9;
  const A = [[w, 0, 0], [0, w, 0], [0, 0, w]];
  const b = [w * p[0], w * p[1], w * p[2]];
  for (const s of ps) {
    const n = s.normal, d = v3.dot(n, s.origin);
    for (let i = 0; i < 3; i++) { b[i] += n[i] * d; for (let j = 0; j < 3; j++) A[i][j] += n[i] * n[j]; }
  }
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (!Number.isFinite(D) || Math.abs(D) < 1e-30) return p;
  const col = (k: number) => A.map((r, i) => r.map((x, j) => (j === k ? b[i] : x)));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

// Float32 run transforms and vertices carry ~1e-7 relative noise. Snap values that are clearly meant
// to be round numbers back to them so planes land on exact offsets.
const NICE = [0, 0.5, Math.SQRT1_2, Math.sqrt(3) / 2, 1];
function snapUnit(x: number): number {
  for (const n of NICE) if (Math.abs(Math.abs(x) - n) < 2e-7) return Math.sign(x) * n;
  return x;
}
function snapLen(x: number): number {
  const r = Math.round(x * 1e5) / 1e5;
  return Math.abs(r - x) <= 1e-6 * Math.max(1, Math.abs(x)) ? r : x;
}
function snapDir(d: Vec3): Vec3 { return v3.norm([snapUnit(d[0]), snapUnit(d[1]), snapUnit(d[2])]); }

function runMatrix(xf: Float32Array, r: number): Mat4 {
  // Manifold leaves runTransform empty for meshes that were never transformed.
  if (xf.length < (r + 1) * 12) return mat4.identity();
  const a = Array.from(xf.subarray(r * 12, r * 12 + 12));
  // Manifold stores a column-major 3x4 matrix.
  const m = [a[0], a[1], a[2], 0, a[3], a[4], a[5], 0, a[6], a[7], a[8], 0, a[9], a[10], a[11], 1];
  for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) m[i] = snapUnit(m[i]);
  for (const i of [12, 13, 14]) m[i] = snapLen(m[i]);
  return m;
}

function transformSurface(s: SurfaceDef, m: Mat4, key: string): Surf | null {
  const c0: Vec3 = [m[0], m[1], m[2]], c1: Vec3 = [m[4], m[5], m[6]], c2: Vec3 = [m[8], m[9], m[10]];
  const l0 = v3.len(c0), l1 = v3.len(c1), l2 = v3.len(c2);
  const conformal = Math.abs(l0 - l1) < 1e-6 * l0 && Math.abs(l0 - l2) < 1e-6 * l0 &&
    Math.abs(v3.dot(c0, c1)) < 1e-6 * l0 * l1 && Math.abs(v3.dot(c0, c2)) < 1e-6 * l0 * l2 && Math.abs(v3.dot(c1, c2)) < 1e-6 * l1 * l2;
  const sc = l0;
  if (s.type === 'nurbs') return { type: 'nurbs', surf: transformSurfaceNurbs(s.surf, m), tol: s.tol * Math.max(l0, l1, l2), key, hint: s.hint, M: m, Minv: mat4.invert(m) };
  const P = (p: Vec3) => mat4.apply(m, p);
  const D = (d: Vec3) => v3.norm(mat4.applyDir(m, d));
  if (s.type === 'plane') {
    if (conformal) return { ...s, origin: P(s.origin), normal: D(s.normal) };
    const inv = mat4.invert(m);
    // normals transform by the inverse transpose
    const n = v3.norm([inv[0] * s.normal[0] + inv[1] * s.normal[1] + inv[2] * s.normal[2], inv[4] * s.normal[0] + inv[5] * s.normal[1] + inv[6] * s.normal[2], inv[8] * s.normal[0] + inv[9] * s.normal[1] + inv[10] * s.normal[2]]);
    return { ...s, origin: P(s.origin), normal: n };
  }
  if (!conformal) return { type: 'mapped', base: s, M: m, Minv: mat4.invert(m), tol: s.tol * Math.max(l0, l1, l2), key };
  switch (s.type) {
    case 'cylinder': return { ...s, origin: P(s.origin), axis: D(s.axis), radius: s.radius * sc, tol: s.tol * sc };
    case 'cone': return { ...s, origin: P(s.origin), axis: D(s.axis), radius: s.radius * sc, tol: s.tol * sc };
    case 'sphere': return { ...s, center: P(s.center), radius: s.radius * sc, tol: s.tol * sc };
    case 'torus': return { ...s, center: P(s.center), axis: D(s.axis), major: s.major * sc, minor: s.minor * sc, tol: s.tol * sc };
  }
}

function sameSurface(a: Surf, b: Surf, tol: number): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'nurbs') return a.key === (b as typeof a).key || sameExtrusion(a, b as typeof a);
  if (a.type === 'mapped') return a.key === (b as typeof a).key;
  const near = (x: number, y: number) => Math.abs(x - y) <= tol;
  const par = (x: Vec3, y: Vec3) => Math.abs(Math.abs(v3.dot(x, y)) - 1) < 1e-9;
  const onAxis = (o: Vec3, ax: Vec3, p: Vec3) => { const q = v3.sub(p, o); return v3.len(v3.sub(q, v3.scale(ax, v3.dot(q, ax)))) <= tol; };
  switch (a.type) {
    case 'plane': { const B = b as typeof a; return par(a.normal, B.normal) && Math.abs(v3.dot(v3.sub(B.origin, a.origin), a.normal)) <= tol; }
    case 'cylinder': { const B = b as typeof a; return near(a.radius, B.radius) && par(a.axis, B.axis) && onAxis(a.origin, a.axis, B.origin); }
    case 'cone': {
      const B = b as typeof a;
      if (!par(a.axis, B.axis) || !onAxis(a.origin, a.axis, B.origin) || v3.dot(a.axis, B.axis) < 0 || !near(a.slope, B.slope)) return false;
      return near(a.radius + a.slope * v3.dot(v3.sub(B.origin, a.origin), a.axis), B.radius);
    }
    case 'sphere': { const B = b as typeof a; return near(a.radius, B.radius) && v3.dist(a.center, B.center) <= tol; }
    case 'torus': { const B = b as typeof a; return near(a.major, B.major) && near(a.minor, B.minor) && par(a.axis, B.axis) && v3.dist(a.center, B.center) <= tol; }
  }
}

type NurbsSurf = Extract<Surf, { type: 'nurbs' }>;
const keyBase = (k: string) => k.slice(0, k.indexOf(':', k.indexOf(':') + 1));

/**
 * Two placements of the same extruded wall that differ only by a shift along the extrusion (an extrude
 * unioned with a moved copy of itself, as shell() does) lie on one surface.
 */
function sameExtrusion(a: NurbsSurf, b: NurbsSurf): boolean {
  if (a.hint?.mode !== 'extrude' || b.hint?.mode !== 'extrude' || !a.M || !b.M) return false;
  if (keyBase(a.key) !== keyBase(b.key) || a.surf.nv !== 2 || b.surf.nv !== 2) return false;
  for (let i = 0; i < 12; i++) if (i % 4 !== 3 && Math.abs(a.M[i] - b.M[i]) > 1e-9 * (1 + Math.abs(a.M[i]))) return false;
  const d = v3.norm(mat4.applyDir(a.M, [0, 0, 1]));
  const t: Vec3 = [b.M[12] - a.M[12], b.M[13] - a.M[13], b.M[14] - a.M[14]];
  return v3.len(v3.sub(t, v3.scale(d, v3.dot(t, d)))) <= 1e-9 * (1 + v3.len(t));
}

/** Grow extrusion `a` along its direction so that it also spans `b` (see sameExtrusion). */
function extendExtrusion(a: NurbsSurf, b: NurbsSurf): NurbsSurf {
  const A = a.surf.ctrl, B = b.surf.ctrl;
  const d = v3.sub(A[1], A[0]), dd = v3.dot(d, d);
  if (dd < 1e-24) return a;
  const lo = Math.min(0, v3.dot(v3.sub(B[0], A[0]), d) / dd), hi = Math.max(1, v3.dot(v3.sub(B[1], A[0]), d) / dd);
  if (lo === 0 && hi === 1) return a;
  const ctrl = A.map((p, i) => (i % 2 === 0 ? v3.add(p, v3.scale(d, lo)) : v3.add(A[i - 1], v3.scale(d, hi))));
  return { ...a, surf: { ...a.surf, ctrl } };
}

// ------------------------------------------------------------------ topology

export interface BrepVertex { p: Vec3 }
export type CurveGeom =
  | { type: 'line'; p: Vec3; d: Vec3 }
  | { type: 'circle'; c: Vec3; axis: Vec3; ref: Vec3; r: number }
  | { type: 'bspline'; degree: number; ctrl: Vec3[]; knots: number[]; mults: number[] };
export interface BrepEdge { v0: number; v1: number; curve: CurveGeom }
export interface BrepLoop { edges: { edge: number; forward: boolean }[] }
export interface BrepFace { surface: number; sense: boolean; loops: BrepLoop[]; outer?: number }
export interface BrepShell { faces: number[]; volume: number; min: Vec3; max: Vec3 }
export interface Brep { surfaces: Surf[]; vertices: BrepVertex[]; edges: BrepEdge[]; faces: BrepFace[]; shells: BrepShell[]; curvedFaces: number }

/**
 * Remove zero-area slivers whose corners weld together (float rounding after booleans). The sliver's two
 * remaining edges run a->c and c->a, so its neighbours pair up directly and the mesh stays closed.
 */
function dropDegenerate(mesh: ExportMesh, tv: Int32Array): ExportMesh & { degenerateFree: true } {
  const nt = tv.length / 3;
  const keep = new Uint8Array(nt);
  const I: number[] = [];
  for (let t = 0; t < nt; t++) {
    const a = tv[t * 3], b = tv[t * 3 + 1], c = tv[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    keep[t] = 1;
    I.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]);
  }
  let exact = mesh.exact;
  if (exact) {
    const R = exact.runs;
    const before = new Uint32Array(nt + 1);
    for (let t = 0; t < nt; t++) before[t + 1] = before[t] + keep[t];
    const index = R.index.map((x) => before[x / 3] * 3);
    let faceID: Uint32Array | undefined;
    if (R.faceID) { const f: number[] = []; for (let t = 0; t < nt; t++) if (keep[t]) f.push(R.faceID[t]); faceID = new Uint32Array(f); }
    exact = { ...exact, runs: { ...R, index, faceID } };
  }
  return { ...mesh, indices: new Uint32Array(I), exact, degenerateFree: true };
}

/** Rebuild an exact B-rep from one export mesh. Throws BrepError when the mesh is not a closed manifold. */
export function buildBrep(mesh: ExportMesh & { degenerateFree?: boolean }): Brep {
  const P = mesh.positions, I = mesh.indices;
  const nt = I.length / 3;
  if (!nt) throw new BrepError('empty mesh');
  let maxAbs = 0;
  for (let i = 0; i < P.length; i++) maxAbs = Math.max(maxAbs, Math.abs(P[i]));
  const ptol = 2e-6 * Math.max(1, maxAbs);

  // Weld identical positions (property splits) into shared vertices.
  const weld = new Map<string, number>();
  const pos: Vec3[] = [];
  const vmap = new Int32Array(P.length / 3);
  for (let i = 0; i < vmap.length; i++) {
    const k = `${P[i * 3]},${P[i * 3 + 1]},${P[i * 3 + 2]}`;
    let w = weld.get(k);
    if (w === undefined) { w = pos.length; weld.set(k, w); pos.push([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]); }
    vmap[i] = w;
  }
  const nv = pos.length;
  const tv = new Int32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) tv[i] = vmap[I[i]];
  for (let t = 0; t < nt; t++) {
    const a = tv[t * 3], b = tv[t * 3 + 1], c = tv[t * 3 + 2];
    if (a === b || b === c || a === c) {
      if (mesh.degenerateFree) throw new BrepError('degenerate triangle');
      return buildBrep(dropDegenerate(mesh, tv));
    }
  }
  // Half-edges: h = t*3+k runs tv[h] -> tv[t*3+(k+1)%3].
  const tail = (h: number) => tv[h];
  const head = (h: number) => tv[(h - (h % 3)) + ((h % 3) + 1) % 3];
  const heMap = new Map<number, number>();
  for (let h = 0; h < nt * 3; h++) {
    const key = tail(h) * nv + head(h);
    if (heMap.has(key)) throw new BrepError('non-manifold edge');
    heMap.set(key, h);
  }
  const opp = new Int32Array(nt * 3);
  for (let h = 0; h < nt * 3; h++) {
    const o = heMap.get(head(h) * nv + tail(h));
    if (o === undefined) throw new BrepError('open mesh');
    opp[h] = o;
  }
  heMap.clear();

  const triN: Vec3[] = new Array(nt), triA = new Float64Array(nt), triC: Vec3[] = new Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = pos[tv[t * 3]], b = pos[tv[t * 3 + 1]], c = pos[tv[t * 3 + 2]];
    const cr = v3.cross(v3.sub(b, a), v3.sub(c, a));
    const l = v3.len(cr);
    triA[t] = l / 2;
    triN[t] = l > 0 ? v3.scale(cr, 1 / l) : [0, 0, 0];
    triC[t] = v3.scale(v3.add(v3.add(a, b), c), 1 / 3);
  }

  // ---- 1. surfaces and triangle assignment
  const surfaces: Surf[] = [];
  // Deduplicate surfaces through buckets keyed on one size parameter (neighbouring buckets are checked too).
  const buckets = new Map<string, number[]>();
  const q = 100 * ptol;
  const keyOf = (s: Surf): [string, number] => {
    switch (s.type) {
      case 'plane': return ['p', Math.round(Math.abs(v3.dot(s.origin, s.normal)) / q)];
      case 'cylinder': return ['c', Math.round(s.radius / q)];
      case 'cone': return ['k', 0];
      case 'sphere': return ['s', Math.round(s.radius / q)];
      case 'torus': return ['t', Math.round(s.minor / q)];
      case 'nurbs': return ['n' + (s.hint?.mode === 'extrude' ? keyBase(s.key) : s.key), 0];
      default: return ['n' + s.key, 0];
    }
  };
  const addSurface = (s: Surf): number => {
    const tol = Math.max(ptol, 1e-9);
    const [t, k] = keyOf(s);
    for (const kk of [k - 1, k, k + 1])
      for (const i of buckets.get(t + kk) ?? []) if (sameSurface(surfaces[i], s, tol)) {
        const e = surfaces[i];
        if (e.type === 'nurbs' && s.type === 'nurbs' && e.key !== s.key) surfaces[i] = extendExtrusion(e, s);
        return i;
      }
    surfaces.push(s);
    const id = surfaces.length - 1;
    const lst = buckets.get(t + k);
    if (lst) lst.push(id); else buckets.set(t + k, [id]);
    return id;
  };
  const triSurf = new Int32Array(nt).fill(-1);
  const ex = mesh.exact;
  if (ex) {
    const R = ex.runs;
    for (let r = 0; r < R.ids.length; r++) {
      const defs = ex.surfaces[R.ids[r]];
      if (!defs?.length) continue;
      let M = runMatrix(R.xf, r);
      if (ex.transform) M = mat4.mul(ex.transform, M);
      const planes: number[] = [], curved: number[] = [];
      const tags = new Map<number, number>();
      defs.forEach((d, di) => {
        const s = transformSurface(d, M, `${R.ids[r]}:${di}:${M.map((x) => x.toFixed(9)).join(',')}`);
        if (!s) return;
        const id = addSurface(s);
        if (d.tag !== undefined) tags.set(d.tag, id);
        else (s.type === 'plane' ? planes : curved).push(id);
      });
      const Minv = mat4.invert(M);
      const lscale = Math.cbrt(Math.abs(det3(M))) || 1;
      const ltol = ptol / lscale;
      const fid = R.faceID;
      const t0 = R.index[r] / 3, t1 = R.index[r + 1] / 3;
      for (let t = t0; t < t1; t++) {
        if (fid && tags.size) {
          const id = tags.get(fid[t]);
          if (id !== undefined) { triSurf[t] = id; continue; }
        }
        const vs = [pos[tv[t * 3]], pos[tv[t * 3 + 1]], pos[tv[t * 3 + 2]]];
        let best = -1, bestD = Infinity;
        const tn = triN[t], big = triA[t] > 1e-10 * Math.max(1, maxAbs * maxAbs);
        for (const id of planes) {
          const s = surfaces[id] as Extract<Surf, { type: 'plane' }>;
          const n = s.normal;
          if (big && Math.abs(tn[0] * n[0] + tn[1] * n[1] + tn[2] * n[2]) < 0.99) continue;
          const off = n[0] * s.origin[0] + n[1] * s.origin[1] + n[2] * s.origin[2];
          let d = 0;
          for (const v of vs) d = Math.max(d, Math.abs(n[0] * v[0] + n[1] * v[1] + n[2] * v[2] - off));
          if (d <= ptol && d < bestD) { best = id; bestD = d; }
        }
        if (best < 0 && curved.length) {
          let local: Vec3[] | null = null, ln: Vec3 | null = null;
          const loc = () => {
            if (!local) {
              local = vs.map((v) => mat4.apply(Minv, v));
              const cr = v3.cross(v3.sub(local[1], local[0]), v3.sub(local[2], local[0]));
              ln = v3.len(cr) > 0 ? v3.norm(cr) : [0, 0, 0];
            }
            return { L: local!, n: ln! };
          };
          for (const id of curved) {
            const s = surfaces[id];
            let d: number;
            if (s.type === 'nurbs') {
              if (!s.hint) continue;
              const { L, n } = loc();
              d = hintDistance(s.hint, L, n) * lscale;
              if (d > Math.max(ptol, s.tol)) continue;
            } else if (s.type === 'mapped') {
              const { L, n } = loc();
              const b = s.base;
              d = Math.max(...L.map((v) => v3.dist(v, projectA(b, v))));
              if (d > Math.max(ltol, b.tol)) continue;
              const c = v3.scale(v3.add(v3.add(L[0], L[1]), L[2]), 1 / 3);
              if (big && Math.abs(v3.dot(n, normalAtA(b, projectA(b, c)))) < 0.7) continue;
              d *= lscale;
            } else {
              d = Math.max(dist(s, vs[0]), dist(s, vs[1]), dist(s, vs[2]));
              if (d > Math.max(ptol, s.tol)) continue;
              if (triA[t] > 1e-12 * Math.max(1, maxAbs * maxAbs) && Math.abs(v3.dot(triN[t], normalAt(s, project(s, triC[t])))) < 0.7) continue;
            }
            if (d >= bestD) continue;
            best = id; bestD = d;
          }
        }
        triSurf[t] = best;
      }
    }
  }
  // Remaining triangles: group connected coplanar ones into planes.
  {
    const order = Array.from({ length: nt }, (_, i) => i).filter((t) => triSurf[t] < 0).sort((a, b) => triA[b] - triA[a]);
    const group = new Int32Array(nt).fill(-1);
    for (const seed of order) {
      if (group[seed] >= 0 || triSurf[seed] >= 0) continue;
      const n = triN[seed], o = pos[tv[seed * 3]];
      const members = [seed];
      group[seed] = seed;
      for (let qi = 0; qi < members.length; qi++) {
        const t = members[qi];
        for (let k = 0; k < 3; k++) {
          const u = Math.floor(opp[t * 3 + k] / 3);
          if (group[u] >= 0 || triSurf[u] >= 0) continue;
          let on = true;
          for (let j = 0; j < 3 && on; j++) if (Math.abs(v3.dot(v3.sub(pos[tv[u * 3 + j]], o), n)) > ptol) on = false;
          if (!on) continue;
          group[u] = seed;
          members.push(u);
        }
      }
      let nn: Vec3 = [0, 0, 0], cc: Vec3 = [0, 0, 0], area = 0;
      for (const t of members) { nn = v3.add(nn, v3.scale(triN[t], triA[t])); cc = v3.add(cc, v3.scale(triC[t], triA[t])); area += triA[t]; }
      const normal = snapDir(v3.len(nn) > 0 ? nn : n);
      const c = area > 0 ? v3.scale(cc, 1 / area) : o;
      const off = snapLen(v3.dot(c, normal));
      const id = addSurface({ type: 'plane', origin: v3.scale(normal, off), normal, tol: 0 });
      for (const t of members) triSurf[t] = id;
    }
  }

  // Stretched cylinders and cones are written as finite B-spline patches: find how far along the axis they reach.
  for (let t = 0; t < nt; t++) {
    const s = surfaces[triSurf[t]];
    if (s.type !== 'mapped' || (s.base.type !== 'cylinder' && s.base.type !== 'cone')) continue;
    const b = s.base;
    for (let k = 0; k < 3; k++) {
      const h = v3.dot(v3.sub(mat4.apply(s.Minv, pos[tv[t * 3 + k]]), b.origin), b.axis);
      s.range = s.range ? [Math.min(s.range[0], h), Math.max(s.range[1], h)] : [h, h];
    }
  }
  for (const s of surfaces)
    if (s.type === 'mapped' && s.range) {
      const pad = Math.max(1e-6, (s.range[1] - s.range[0]) * 0.02);
      s.range = [s.range[0] - pad, s.range[1] + pad];
      if (s.base.type === 'cone') {
        // never run past the apex
        const apex = -s.base.radius / s.base.slope;
        if (s.range[0] < apex) s.range[0] = apex;
      }
    }

  // ---- 2. faces: connected triangles on the same surface
  const faceOf = new Int32Array(nt).fill(-1);
  const faces: BrepFace[] = [];
  const faceTris: number[][] = [];
  for (let t = 0; t < nt; t++) {
    if (faceOf[t] >= 0) continue;
    const f = faces.length;
    const tris = [t];
    faceOf[t] = f;
    for (let qi = 0; qi < tris.length; qi++) {
      const u = tris[qi];
      for (let k = 0; k < 3; k++) {
        const w = Math.floor(opp[u * 3 + k] / 3);
        if (faceOf[w] < 0 && triSurf[w] === triSurf[t]) { faceOf[w] = f; tris.push(w); }
      }
    }
    const s = surfaces[triSurf[t]];
    let sense = 0;
    // free-form surfaces need a closest-point search per sample, so sample the largest triangles only
    const sample = s.type === 'nurbs' || s.type === 'mapped' ? [...tris].sort((a, b) => triA[b] - triA[a]).slice(0, 24) : tris;
    for (const u of sample) sense += triA[u] * v3.dot(triN[u], normalAt(s, project(s, triC[u])));
    faces.push({ surface: triSurf[t], sense: sense >= 0, loops: [] });
    faceTris.push(tris);
  }
  const isB = (h: number) => faceOf[Math.floor(h / 3)] !== faceOf[Math.floor(opp[h] / 3)];

  // ---- 3. topology
  const vFaces: number[][] = Array.from({ length: nv }, () => []);
  const outB = new Int32Array(nv);
  for (let h = 0; h < nt * 3; h++) {
    const f = faceOf[Math.floor(h / 3)];
    const lst = vFaces[tail(h)];
    if (!lst.includes(f)) lst.push(f);
    if (isB(h)) outB[tail(h)]++;
  }
  const topo = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) if (vFaces[v].length >= 3 || outB[v] > 2) topo[v] = 1;

  const heOut = (t: number, v: number) => { for (let k = 0; k < 3; k++) if (tv[t * 3 + k] === v) return t * 3 + k; throw new BrepError('broken fan'); };
  /** Next boundary half-edge of the same face, walking the triangle fan around head(h). */
  const nextB = (h: number): number => {
    const b = head(h);
    let t = Math.floor(h / 3);
    for (let guard = 0; guard < 10000; guard++) {
      const e = heOut(t, b);
      if (isB(e)) return e;
      t = Math.floor(opp[e] / 3);
    }
    throw new BrepError('fan walk did not terminate');
  };

  const edgeOf = new Int32Array(nt * 3).fill(-1);
  const edgeFwd = new Uint8Array(nt * 3);
  const chains: { verts: number[]; fL: number; fR: number }[] = [];
  const trace = (h0: number) => {
    const verts = [tail(h0)];
    const hes: number[] = [];
    let h = h0;
    for (let guard = 0; guard <= nt * 3; guard++) {
      hes.push(h);
      verts.push(head(h));
      if (topo[head(h)]) break;
      h = nextB(h);
      if (h === h0) break;
    }
    const e = chains.length;
    chains.push({ verts, fL: faceOf[Math.floor(h0 / 3)], fR: faceOf[Math.floor(opp[h0] / 3)] });
    for (const x of hes) { edgeOf[x] = e; edgeFwd[x] = 1; edgeOf[opp[x]] = e; edgeFwd[opp[x]] = 0; }
  };
  for (let h = 0; h < nt * 3; h++) if (isB(h) && edgeOf[h] < 0 && topo[tail(h)]) trace(h);
  for (let h = 0; h < nt * 3; h++) if (isB(h) && edgeOf[h] < 0) { topo[tail(h)] = 1; trace(h); }

  // Vertices: snap onto every surface that meets there.
  const vIndex = new Int32Array(nv).fill(-1);
  const vertices: BrepVertex[] = [];
  const vertexId = (v: number) => {
    if (vIndex[v] < 0) {
      const ss = vFaces[v].map((f) => surfaces[faces[f].surface]);
      vIndex[v] = vertices.length;
      vertices.push({ p: projectAll(dedupe(ss), pos[v], 100) });
    }
    return vIndex[v];
  };

  const edges: BrepEdge[] = chains.map((c) => {
    const sA = surfaces[faces[c.fL].surface], sB = surfaces[faces[c.fR].surface];
    const v0 = vertexId(c.verts[0]), v1 = vertexId(c.verts[c.verts.length - 1]);
    const bothPlanar = sA.type === 'plane' && sB.type === 'plane';
    if (bothPlanar && v0 !== v1) return { v0, v1, curve: { type: 'line', p: vertices[v0].p, d: v3.norm(v3.sub(vertices[v1].p, vertices[v0].p)) } as CurveGeom };
    const pts: Vec3[] = c.verts.map((v, i) => (i === 0 ? vertices[v0].p : i === c.verts.length - 1 ? vertices[v1].p : projectAll([sA, sB], pos[v])));
    const curve = fitCurve(pts, v0 === v1, bothPlanar, ptol);
    if (curve.type !== 'bspline' || pts.length > 300) return { v0, v1, curve };
    // A free-form intersection: add exact points between the mesh points before fitting the spline.
    const k = Math.max(1, Math.min(4, Math.floor(300 / pts.length)));
    const dense: Vec3[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      for (let j = 1; j < k; j++) dense.push(projectAll([sA, sB], v3.lerp(pts[i - 1], pts[i], j / k), 30));
      dense.push(pts[i]);
    }
    return { v0, v1, curve: interpolate(dense) };
  });

  // Loops
  const seen = new Uint8Array(nt * 3);
  for (let f = 0; f < faces.length; f++) {
    for (const t of faceTris[f])
      for (let k = 0; k < 3; k++) {
        const h0 = t * 3 + k;
        if (seen[h0] || !isB(h0)) continue;
        const loopHe: number[] = [];
        let h = h0;
        for (let guard = 0; guard <= nt * 3; guard++) {
          seen[h] = 1;
          loopHe.push(h);
          h = nextB(h);
          if (h === h0) break;
          if (seen[h]) throw new BrepError('loop walk crossed itself');
        }
        // Start the loop where one edge ends and the next begins, then collapse half-edges into edges.
        const L = loopHe.length;
        let s = 0;
        for (let i = 0; i < L; i++) if (edgeOf[loopHe[i]] !== edgeOf[loopHe[(i - 1 + L) % L]]) { s = i; break; }
        const loop: BrepLoop = { edges: [] };
        for (let i = 0; i < L; i++) {
          const x = loopHe[(s + i) % L];
          const last = loop.edges[loop.edges.length - 1];
          if (last && last.edge === edgeOf[x]) continue;
          loop.edges.push({ edge: edgeOf[x], forward: edgeFwd[x] === 1 });
        }
        faces[f].loops.push(loop);
      }
  }

  // Closed surfaces with no boundary (a whole sphere or torus) get synthetic seam circles.
  let curvedFaces = 0;
  const extraFaces: BrepFace[] = [];
  for (const f of faces) {
    const s = surfaces[f.surface];
    if (s.type !== 'plane') curvedFaces++;
    if (f.loops.length) continue;
    if (s.type === 'sphere') {
      const ref: Vec3 = [1, 0, 0], axis: Vec3 = [0, 0, 1];
      const v = vertices.push({ p: v3.add(s.center, v3.scale(ref, s.radius)) }) - 1;
      const e = edges.push({ v0: v, v1: v, curve: { type: 'circle', c: s.center, axis, ref, r: s.radius } }) - 1;
      f.loops.push({ edges: [{ edge: e, forward: f.sense }] });
      extraFaces.push({ surface: f.surface, sense: f.sense, loops: [{ edges: [{ edge: e, forward: !f.sense }] }] });
    } else if (s.type === 'torus') {
      const u0 = v3.perp(s.axis), u1 = v3.scale(u0, -1);
      const mk = (u: Vec3) => {
        const c = v3.add(s.center, v3.scale(u, s.major));
        const v = vertices.push({ p: v3.add(c, v3.scale(u, s.minor)) }) - 1;
        return edges.push({ v0: v, v1: v, curve: { type: 'circle', c, axis: v3.norm(v3.cross(s.axis, u)), ref: u, r: s.minor } }) - 1;
      };
      const e0 = mk(u0), e1 = mk(u1);
      f.loops.push({ edges: [{ edge: e0, forward: f.sense }] }, { edges: [{ edge: e1, forward: !f.sense }] });
      extraFaces.push({ surface: f.surface, sense: f.sense, loops: [{ edges: [{ edge: e0, forward: !f.sense }] }, { edges: [{ edge: e1, forward: f.sense }] }] });
    } else if (s.type === 'mapped' && (s.base.type === 'sphere' || s.base.type === 'torus')) {
      // a whole stretched sphere or torus: split it like the round ones, with spline seams
      const b = s.base;
      const ring = (c: Vec3, axis: Vec3, ref: Vec3, r: number) => {
        const y = v3.cross(axis, ref), pts: Vec3[] = [];
        for (let i = 0; i <= 64; i++) {
          const a = (i / 64) * 2 * Math.PI;
          pts.push(mat4.apply(s.M, v3.add(c, v3.add(v3.scale(ref, r * Math.cos(a)), v3.scale(y, r * Math.sin(a))))));
        }
        pts[64] = pts[0];
        const v = vertices.push({ p: pts[0] }) - 1;
        return edges.push({ v0: v, v1: v, curve: interpolate(pts) }) - 1;
      };
      if (b.type === 'sphere') {
        const e = ring(b.center, [0, 0, 1], [1, 0, 0], b.radius);
        // mapping may mirror: orientation follows the mapped axis direction
        const fw = det3(s.M) > 0 ? f.sense : !f.sense;
        // Spline surfaces need an explicit seam: a meridian from the equator start to each pole,
        // along the u = 0 line of the spline sphere.
        const v0 = edges[e].v0;
        const seam = (dir: 1 | -1) => {
          const pts: Vec3[] = [];
          for (let i = 0; i <= 32; i++) {
            const a = (dir * (i / 32) * Math.PI) / 2;
            pts.push(mat4.apply(s.M, v3.add(b.center, [b.radius * Math.cos(a), 0, b.radius * Math.sin(a)])));
          }
          const pole = vertices.push({ p: pts[32] }) - 1;
          return edges.push({ v0, v1: pole, curve: interpolate(pts) }) - 1;
        };
        const sn = seam(1), ss = seam(-1);
        f.loops.push({ edges: [{ edge: e, forward: fw }, { edge: sn, forward: true }, { edge: sn, forward: false }] });
        extraFaces.push({ surface: f.surface, sense: f.sense, loops: [{ edges: [{ edge: e, forward: !fw }, { edge: ss, forward: true }, { edge: ss, forward: false }] }] });
      } else {
        const u0 = v3.perp(b.axis), u1 = v3.scale(u0, -1);
        const mk = (u: Vec3) => ring(v3.add(b.center, v3.scale(u, b.major)), v3.norm(v3.cross(b.axis, u)), u, b.minor);
        const e0 = mk(u0), e1 = mk(u1);
        const fw = det3(s.M) > 0 ? f.sense : !f.sense;
        f.loops.push({ edges: [{ edge: e0, forward: fw }] }, { edges: [{ edge: e1, forward: !fw }] });
        extraFaces.push({ surface: f.surface, sense: f.sense, loops: [{ edges: [{ edge: e0, forward: !fw }] }, { edges: [{ edge: e1, forward: fw }] }] });
      }
    } else throw new BrepError(`unbounded ${s.type} face`);
  }

  // Face centroids (used to tell which pole a spherical cap covers).
  const cent = new Map<BrepFace, Vec3>();
  faces.forEach((f, i) => {
    let c: Vec3 = [0, 0, 0], a = 0;
    for (const t of faceTris[i]) { c = v3.add(c, v3.scale(triC[t], triA[t])); a += triA[t]; }
    cent.set(f, a > 0 ? v3.scale(c, 1 / a) : triC[faceTris[i][0]]);
  });
  for (const xf of extraFaces) {
    const s = surfaces[xf.surface];
    if (s.type === 'sphere') cent.set(xf, v3.add(s.center, [0, 0, -s.radius / 2]));
  }
  addSeams([...faces, ...extraFaces], surfaces, vertices, edges, cent, ptol);

  // Outer bound for planar faces: the loop enclosing the largest area.
  for (const f of faces) {
    const s = surfaces[f.surface];
    if (s.type !== 'plane' || f.loops.length < 2) continue;
    let best = 0, bestA = -Infinity;
    f.loops.forEach((l, i) => {
      let a: Vec3 = [0, 0, 0];
      const pts = loopPoints(l, edges, vertices);
      for (let k = 0; k < pts.length; k++) a = v3.add(a, v3.cross(pts[k], pts[(k + 1) % pts.length]));
      const area = Math.abs(v3.dot(a, s.normal));
      if (area > bestA) { bestA = area; best = i; }
    });
    f.outer = best;
  }

  // ---- shells: connected components of triangles, with signed volume for void detection
  const faceShell = new Int32Array(faces.length).fill(-1);
  const shells: BrepShell[] = [];
  for (let f0 = 0; f0 < faces.length; f0++) {
    if (faceShell[f0] >= 0) continue;
    const sh: BrepShell = { faces: [], volume: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const stack = [f0];
    faceShell[f0] = shells.length;
    while (stack.length) {
      const f = stack.pop()!;
      sh.faces.push(f);
      for (const t of faceTris[f]) {
        const a = pos[tv[t * 3]], b = pos[tv[t * 3 + 1]], c = pos[tv[t * 3 + 2]];
        sh.volume += v3.dot(a, v3.cross(b, c)) / 6;
        for (const p of [a, b, c]) for (let k = 0; k < 3; k++) { sh.min[k] = Math.min(sh.min[k], p[k]); sh.max[k] = Math.max(sh.max[k], p[k]); }
        for (let k = 0; k < 3; k++) {
          const g = faceOf[Math.floor(opp[t * 3 + k] / 3)];
          if (faceShell[g] < 0) { faceShell[g] = shells.length; stack.push(g); }
        }
      }
    }
    shells.push(sh);
  }
  for (const xf of extraFaces) {
    const owner = faces.findIndex((f) => f.surface === xf.surface && f.loops.length && f.loops[0].edges[0].edge === xf.loops[0].edges[0].edge);
    faces.push(xf);
    shells[faceShell[owner]].faces.push(faces.length - 1);
  }
  return { surfaces, vertices, edges, faces, shells, curvedFaces };
}

function dedupe(ss: Surf[]): Surf[] { return [...new Set(ss)]; }

function det3(m: Mat4): number {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

function segDist2(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

/**
 * How far a triangle (in the surface's local frame) is from the profile it was swept from; Infinity
 * when its orientation rules it out (an extrusion's caps lie on the profile too but face along z).
 */
function hintDistance(h: ProfileHint, L: Vec3[], n: Vec3): number {
  if (h.mode === 'extrude') {
    if (Math.abs(n[2]) > 0.5) return Infinity;
    const e = 1e-9 * Math.max(1, Math.abs(h.z1));
    let d = 0;
    for (const v of L) {
      if (v[2] < h.z0 - e - 1e-6 || v[2] > h.z1 + e + 1e-6) return Infinity;
      let m = Infinity;
      for (let i = 0; i + 1 < h.poly.length; i++) m = Math.min(m, segDist2([v[0], v[1]], h.poly[i], h.poly[i + 1]));
      d = Math.max(d, Math.sqrt(m));
    }
    return d;
  }
  let d = 0;
  for (const v of L) {
    const q: Vec2 = [Math.hypot(v[0], v[1]), v[2]];
    let m = Infinity;
    for (let i = 0; i + 1 < h.poly.length; i++) m = Math.min(m, segDist2(q, h.poly[i], h.poly[i + 1]));
    d = Math.max(d, Math.sqrt(m));
  }
  return d;
}

/**
 * Faces on cylinders, cones and spheres that wrap all the way around (a hole wall, a shaft, a dome)
 * get an explicit seam edge, the way CAD systems write them: the loop runs around one rim, up the
 * seam, around the other rim (or to the apex / pole) and back down the seam. Readers then need no
 * healing. Faces whose rims are not plain circles are left as they are.
 */
function addSeams(faces: BrepFace[], surfaces: Surf[], vertices: BrepVertex[], edges: BrepEdge[], cent: Map<BrepFace, Vec3>, tol: number) {
  const vUse = new Int32Array(vertices.length);
  for (const e of edges) { vUse[e.v0]++; if (e.v1 !== e.v0) vUse[e.v1]++; }
  const pinned = new Map<number, Vec3>();
  for (const f of faces) {
    const s = surfaces[f.surface];
    if (s.type !== 'cylinder' && s.type !== 'cone' && s.type !== 'sphere') continue;
    const isRing = (l: BrepLoop) => {
      if (l.edges.length !== 1) return false;
      const e = edges[l.edges[0].edge];
      return e.v0 === e.v1 && e.curve.type === 'circle' && vUse[e.v0] === 1;
    };
    const rings = f.loops.filter(isRing);
    const islands = f.loops.filter((l) => !isRing(l));
    if (!rings.length || rings.length > 2) continue;
    const c0 = edges[rings[0].edges[0].edge].curve as Extract<CurveGeom, { type: 'circle' }>;
    const axis = s.type === 'sphere' ? c0.axis : s.axis;
    const origin = s.type === 'sphere' ? s.center : s.origin;
    // every ring must be a circle around the same axis
    const coaxial = rings.every((l) => {
      const c = edges[l.edges[0].edge].curve as Extract<CurveGeom, { type: 'circle' }>;
      const q = v3.sub(c.c, origin);
      return Math.abs(Math.abs(v3.dot(c.axis, axis)) - 1) < 1e-9 && v3.len(v3.sub(q, v3.scale(axis, v3.dot(q, axis)))) <= tol;
    });
    if (!coaxial) continue;
    if (s.type === 'cylinder' && rings.length !== 2) continue;
    const r0 = v3.perp(axis), r1 = v3.cross(axis, r0);
    const theta = (p: Vec3) => { const q = v3.sub(p, origin); return Math.atan2(v3.dot(q, r1), v3.dot(q, r0)); };
    const dirAt = (t: number): Vec3 => v3.add(v3.scale(r0, Math.cos(t)), v3.scale(r1, Math.sin(t)));
    // Seam direction: shared with a neighbour that already placed one, else clear of any islands.
    const pins = rings.map((l) => pinned.get(l.edges[0].edge)).filter((x): x is Vec3 => !!x);
    let seamT: number;
    if (pins.length) {
      if (pins.length === 2 && v3.dist(pins[0], pins[1]) > 1e-9) continue;
      seamT = theta(v3.add(origin, pins[0]));
    } else {
      const angs: number[] = [];
      for (const l of islands) for (const p of loopPoints(l, edges, vertices)) angs.push(theta(p));
      seamT = 0;
      if (angs.length) {
        let best = -1;
        for (let k = 0; k < 144; k++) {
          const t = -Math.PI + (k * Math.PI) / 72;
          let clear = Infinity;
          for (const a of angs) { let d = Math.abs(a - t) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; clear = Math.min(clear, d); }
          if (clear > best) { best = clear; seamT = t; }
        }
        if (best < (2 * Math.PI) / 180) continue;
      }
    }
    const d = dirAt(seamT);
    for (const l of rings) {
      const ei = l.edges[0].edge, e = edges[ei];
      if (pinned.has(ei)) continue;
      const c = e.curve as Extract<CurveGeom, { type: 'circle' }>;
      c.ref = d;
      vertices[e.v0].p = v3.add(c.c, v3.scale(d, c.r));
      pinned.set(ei, d);
    }
    const vA = edges[rings[0].edges[0].edge].v0;
    let vB: number;
    if (rings.length === 2) vB = edges[rings[1].edges[0].edge].v0;
    else if (s.type === 'cone') vB = vertices.push({ p: v3.add(s.origin, v3.scale(s.axis, -s.radius / s.slope)) }) - 1;
    else if (s.type === 'sphere') {
      const side = v3.dot(v3.sub(cent.get(f) ?? s.center, c0.c), axis) >= 0 ? 1 : -1;
      vB = vertices.push({ p: v3.add(s.center, v3.scale(axis, side * s.radius)) }) - 1;
    } else continue;
    const pA = vertices[vA].p, pB = vertices[vB].p;
    let curve: CurveGeom;
    if (s.type === 'sphere') {
      const ax = v3.cross(v3.sub(pA, s.center), v3.sub(pB, s.center));
      if (v3.len(ax) < 1e-12) continue;
      curve = { type: 'circle', c: s.center, axis: v3.norm(ax), ref: v3.norm(v3.sub(pA, s.center)), r: s.radius };
    } else curve = { type: 'line', p: pA, d: v3.norm(v3.sub(pB, pA)) };
    const seam = edges.push({ v0: vA, v1: vB, curve }) - 1;
    const loop: BrepLoop = { edges: [rings[0].edges[0], { edge: seam, forward: true }] };
    if (rings.length === 2) loop.edges.push(rings[1].edges[0]);
    loop.edges.push({ edge: seam, forward: false });
    f.loops = [loop, ...islands];
  }
}

function loopPoints(l: BrepLoop, edges: BrepEdge[], vertices: BrepVertex[]): Vec3[] {
  const out: Vec3[] = [];
  for (const { edge, forward } of l.edges) {
    const e = edges[edge];
    const pts = sampleCurve(e.curve, vertices[e.v0].p, vertices[e.v1].p, e.v0 === e.v1);
    if (!forward) pts.reverse();
    out.push(...pts.slice(0, -1));
  }
  return out;
}

function sampleCurve(c: CurveGeom, a: Vec3, b: Vec3, closed: boolean): Vec3[] {
  if (c.type === 'line') return [a, b];
  if (c.type === 'circle') {
    const y = v3.cross(c.axis, c.ref);
    const ang = (p: Vec3) => { const q = v3.sub(p, c.c); return Math.atan2(v3.dot(q, y), v3.dot(q, c.ref)); };
    let t0 = ang(a), t1 = ang(b);
    if (closed) t1 = t0 + 2 * Math.PI;
    else while (t1 <= t0) t1 += 2 * Math.PI;
    const out: Vec3[] = [];
    for (let i = 0; i <= 32; i++) {
      const t = t0 + ((t1 - t0) * i) / 32;
      out.push(v3.add(c.c, v3.add(v3.scale(c.ref, c.r * Math.cos(t)), v3.scale(y, c.r * Math.sin(t)))));
    }
    return out;
  }
  return c.ctrl.slice();
}

// ------------------------------------------------------------------ curve fitting

function fitCurve(pts: Vec3[], closed: boolean, bothPlanar: boolean, tol: number): CurveGeom {
  const a = pts[0], b = pts[pts.length - 1];
  if (!closed && (bothPlanar || pts.length === 2 || pts.every((p) => pointLineDist(p, a, b) <= tol))) {
    return { type: 'line', p: a, d: v3.norm(v3.sub(b, a)) };
  }
  const uniq = closed ? pts.slice(0, -1) : pts;
  if (uniq.length >= 3) {
    const circ = fitCircle(uniq, tol);
    // a nearly straight edge can "fit" a circle of enormous radius; that is not a real arc
    let ext = 0;
    for (const p of uniq) ext = Math.max(ext, v3.dist(p, uniq[0]));
    if (circ && circ.r <= 1e3 * Math.max(ext, tol)) {
      let axis = circ.axis;
      const ref = v3.norm(v3.sub(a, circ.c));
      if (v3.dot(v3.cross(v3.sub(uniq[0], circ.c), v3.sub(uniq[1], circ.c)), axis) < 0) axis = v3.scale(axis, -1);
      return { type: 'circle', c: circ.c, axis, ref, r: circ.r };
    }
  }
  return interpolate(pts);
}

function pointLineDist(p: Vec3, a: Vec3, b: Vec3): number {
  const d = v3.sub(b, a), l = v3.len(d);
  if (l < 1e-15) return v3.dist(p, a);
  return v3.len(v3.cross(v3.sub(p, a), d)) / l;
}

function fitCircle(pts: Vec3[], tol: number): { c: Vec3; axis: Vec3; r: number } | null {
  const n = pts.length;
  const p0 = pts[0], p1 = pts[Math.floor(n / 3)], p2 = pts[Math.floor((2 * n) / 3)] ?? pts[n - 1];
  const A = v3.sub(p1, p0), B = v3.sub(p2, p0);
  const N = v3.cross(A, B);
  const nl = v3.len(N);
  if (nl < 1e-14) return null;
  // circumcentre of p0, p1, p2
  const c = v3.add(p0, v3.scale(v3.add(v3.scale(v3.cross(N, A), v3.dot(B, B)), v3.scale(v3.cross(B, N), v3.dot(A, A))), 1 / (2 * nl * nl)));
  const axis = v3.scale(N, 1 / nl);
  const r = v3.dist(c, p0);
  const t = Math.max(tol, 1e-9 * r);
  for (const p of pts) {
    if (Math.abs(v3.dot(v3.sub(p, c), axis)) > t) return null;
    if (Math.abs(v3.dist(p, c) - r) > t) return null;
  }
  return { c, axis, r };
}

/** Cubic B-spline through the points (chord-length parameters, averaged knots). */
function interpolate(input: Vec3[]): CurveGeom {
  let pts = input;
  const MAX = 320;
  if (pts.length > MAX) {
    const s: Vec3[] = [];
    for (let i = 0; i < MAX; i++) s.push(pts[Math.round((i * (pts.length - 1)) / (MAX - 1))]);
    pts = s;
  }
  const n = pts.length - 1;
  const p = Math.min(3, n);
  const u = [0];
  let total = 0;
  for (let i = 1; i <= n; i++) { total += v3.dist(pts[i], pts[i - 1]); u.push(total); }
  for (let i = 0; i <= n; i++) u[i] = total > 0 ? u[i] / total : i / n;
  const U: number[] = [];
  for (let i = 0; i <= p; i++) U.push(0);
  for (let j = 1; j <= n - p; j++) { let s = 0; for (let i = j; i < j + p; i++) s += u[i]; U.push(s / p); }
  for (let i = 0; i <= p; i++) U.push(1);
  const A: number[][] = [];
  for (let k = 0; k <= n; k++) A.push(basisRow(U, p, n, u[k]));
  const ctrl = solve(A, pts);
  const knots: number[] = [], mults: number[] = [];
  for (const x of U) {
    if (knots.length && Math.abs(knots[knots.length - 1] - x) < 1e-14) mults[mults.length - 1]++;
    else { knots.push(x); mults.push(1); }
  }
  return { type: 'bspline', degree: p, ctrl, knots, mults };
}

function basisRow(U: number[], p: number, n: number, u: number): number[] {
  const row = new Array(n + 1).fill(0);
  let span = p;
  if (u >= U[n + 1]) span = n;
  else while (span < n && u >= U[span + 1]) span++;
  const N = [1], left = [0], right = [0];
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const tmp = den === 0 ? 0 : N[r] / den;
      N[r] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    N[j] = saved;
  }
  for (let j = 0; j <= p; j++) row[span - p + j] = N[j];
  return row;
}

function solve(A: number[][], B: Vec3[]): Vec3[] {
  const n = A.length;
  const M = A.map((r, i) => [...r, ...B[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-300) throw new BrepError('singular spline system');
    for (let r = 0; r < n; r++) {
      if (r === c || M[r][c] === 0) continue;
      const f = M[r][c] / d;
      for (let k = c; k < n + 3; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => [r[n] / r[i], r[n + 1] / r[i], r[n + 2] / r[i]] as Vec3);
}

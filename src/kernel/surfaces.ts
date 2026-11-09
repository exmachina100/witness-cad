// Analytic surface tracking. The kernel is mesh based, so a cylinder is stored as facets. To export
// exact geometry (STEP B-rep) we remember, for every primitive the kernel creates, the true surfaces it
// was tessellated from: planes, cylinders, cones, spheres and tori. Manifold keeps an "original ID" and
// a transform for every triangle run through booleans and transforms, so at export time each triangle
// can be traced back to the exact surface it came from.
import type { ManifoldToplevel, Manifold } from 'manifold-3d';
import { v3, Vec2, Vec3 } from './math';
import { extrusionSurface, interpolateCurve, NurbsSurface, revolutionSurface } from './nurbs';

/**
 * Where the triangles of a free-form surface came from, in the surface's local frame: side walls of an
 * extrusion of a polyline along z, or a revolution of an (r, z) polyline about z. Lets the exporter
 * assign triangles to the surface without a closest-point search.
 */
export type ProfileHint = { mode: 'extrude'; poly: Vec2[]; z0: number; z1: number } | { mode: 'revolve'; poly: Vec2[] };

/** `tag`: triangles whose Manifold faceID equals the tag lie on this surface (meshes we build ourselves). */
export type SurfaceDef = (
  | { type: 'plane'; origin: Vec3; normal: Vec3; tol: number }
  | { type: 'cylinder'; origin: Vec3; axis: Vec3; radius: number; tol: number }
  /** radius at origin; slope = d(radius)/d(distance along axis) */
  | { type: 'cone'; origin: Vec3; axis: Vec3; radius: number; slope: number; tol: number }
  | { type: 'sphere'; center: Vec3; radius: number; tol: number }
  | { type: 'torus'; center: Vec3; axis: Vec3; major: number; minor: number; tol: number }
  | { type: 'nurbs'; surf: NurbsSurface; tol: number; hint?: ProfileHint }
) & { tag?: number };

/** Triangle runs of a mesh, as reported by Manifold: run i covers triangles [index[i]/3, index[i+1]/3). */
export interface MeshRuns { index: Uint32Array; ids: Uint32Array; xf: Float32Array; faceID?: Uint32Array }

const MAX_ENTRIES = 200_000;
const registry = new Map<number, SurfaceDef[]>();

export function surfacesFor(id: number): SurfaceDef[] | undefined { return registry.get(id); }

/** Surfaces for every original referenced by `runs`, keyed by original ID (serialisable). */
export function surfaceTable(runs: MeshRuns | undefined): Record<number, SurfaceDef[]> {
  const out: Record<number, SurfaceDef[]> = {};
  if (!runs) return out;
  for (const id of runs.ids) {
    const s = registry.get(id);
    if (s) out[id] = s;
  }
  return out;
}

/** Record the exact surfaces of a manifold the kernel just built (it must be an original). */
export function registerSurfaces(m: Manifold, defs: SurfaceDef[]) { register(m, defs); }

/** Record surfaces under an ID from Manifold.reserveIDs, used as the runOriginalID of a mesh we build. */
export function registerSurfacesById(id: number, defs: SurfaceDef[]) { if (defs.length) store(id, defs); }

function register(m: Manifold, defs: SurfaceDef[]) {
  if (!defs.length) return;
  let id: number;
  try { id = m.originalID(); } catch { return; }
  if (id < 0) return;
  store(id, defs);
}

function store(id: number, defs: SurfaceDef[]) {
  registry.set(id, defs);
  if (registry.size > MAX_ENTRIES) {
    const drop = registry.size - MAX_ENTRIES;
    let i = 0;
    for (const k of registry.keys()) { if (i++ >= drop) break; registry.delete(k); }
  }
}

const sag = (r: number, n: number) => r * (1 - Math.cos(Math.PI / Math.max(3, n)));

let installed = false;
/** Wrap the kernel's primitive constructors so they record their exact surfaces. Safe to call twice. */
export function installSurfaceTracking(k: ManifoldToplevel) {
  if (installed) return;
  installed = true;
  const K: any = k;
  const M: any = k.Manifold;
  const segs = (r: number, n: any) => (Number(n) > 2 ? Number(n) : (K.getCircularSegments?.(r) ?? 16));
  const safe = (fn: () => void) => { try { fn(); } catch { /* tracking is best effort */ } };

  const cube = M.cube;
  M.cube = function (...args: any[]) {
    const m = cube.apply(M, args);
    safe(() => {
      const b = m.boundingBox();
      const defs: SurfaceDef[] = [];
      for (let ax = 0; ax < 3; ax++)
        for (const [v, s] of [[b.min[ax], -1], [b.max[ax], 1]] as const) {
          const n: Vec3 = [0, 0, 0]; n[ax] = s;
          const o: Vec3 = [0, 0, 0]; o[ax] = v;
          defs.push({ type: 'plane', origin: o, normal: n, tol: 0 });
        }
      register(m, defs);
    });
    return m;
  };

  const cylinder = M.cylinder;
  M.cylinder = function (...args: any[]) {
    const m = cylinder.apply(M, args);
    safe(() => {
      const r1 = Number(args[1]);
      let r2 = args[2] == null ? -1 : Number(args[2]);
      if (r2 < 0) r2 = r1;
      const b = m.boundingBox();
      const z0 = b.min[2], z1 = b.max[2], h = z1 - z0;
      if (!(h > 0)) return;
      const n = segs(Math.max(r1, r2), args[3]);
      const tol = sag(Math.max(r1, r2), n) * 1.5;
      const defs: SurfaceDef[] = [
        { type: 'plane', origin: [0, 0, z0], normal: [0, 0, -1], tol: 0 },
        { type: 'plane', origin: [0, 0, z1], normal: [0, 0, 1], tol: 0 },
      ];
      if (Math.abs(r1 - r2) < 1e-12 * Math.max(1, r1)) defs.push({ type: 'cylinder', origin: [0, 0, z0], axis: [0, 0, 1], radius: r1, tol });
      else defs.push(coneDef(r1, z0, r2, z1, tol));
      register(m, defs);
    });
    return m;
  };

  const sphere = M.sphere;
  M.sphere = function (...args: any[]) {
    const m = sphere.apply(M, args);
    safe(() => {
      const r = Number(args[0]);
      register(m, [{ type: 'sphere', center: [0, 0, 0], radius: r, tol: sag(r, segs(r, args[1])) * 1.5 }]);
    });
    return m;
  };

  // Module.CrossSection is a factory; the methods live on the prototype of the instances it returns.
  const probe = K.CrossSection.square([1, 1]);
  const CS: any = Object.getPrototypeOf(probe);
  probe.delete?.();
  const extrude = CS.extrude;
  CS.extrude = function (height: number, nDivisions = 0, twistDegrees = 0, scaleTop: any = [1, 1], center = false) {
    const m: Manifold = extrude.call(this, height, nDivisions, twistDegrees, scaleTop, false);
    safe(() => {
      const st = typeof scaleTop === 'number' ? [scaleTop, scaleTop] : Array.isArray(scaleTop) ? scaleTop : [scaleTop?.x ?? 1, scaleTop?.y ?? 1];
      if (twistDegrees || st[0] !== 1 || st[1] !== 1 || !(height > 0)) return;
      register(m, extrudeSurfaces(this.toPolygons() as Vec2[][], height));
    });
    return center ? m.translate([0, 0, -height / 2]) : m;
  };

  const revolve = CS.revolve;
  CS.revolve = function (circularSegments = 0, revolveDegrees = 360) {
    const m: Manifold = revolve.call(this, circularSegments, revolveDegrees);
    safe(() => {
      const polys = this.toPolygons() as Vec2[][];
      let rMax = 0;
      for (const p of polys) for (const q of p) rMax = Math.max(rMax, q[0]);
      register(m, revolveSurfaces(polys, sag(rMax, segs(rMax, circularSegments)) * 1.5));
    });
    return m;
  };
}

function coneDef(r1: number, z0: number, r2: number, z1: number, tol: number): SurfaceDef {
  // Axis points the way the radius grows, so the slope (semi-angle) is positive.
  if (r2 >= r1) return { type: 'cone', origin: [0, 0, z1], axis: [0, 0, 1], radius: r2, slope: (r2 - r1) / (z1 - z0), tol };
  return { type: 'cone', origin: [0, 0, z0], axis: [0, 0, -1], radius: r1, slope: (r1 - r2) / (z1 - z0), tol };
}

// ------------------------------------------------------------------ 2D profile analysis

export type Piece = { kind: 'line'; a: Vec2; b: Vec2 } | { kind: 'arc'; c: Vec2; r: number; sag: number; pts: Vec2[] } | { kind: 'spline'; pts: Vec2[] };

const MAX_TURN = (20 * Math.PI) / 180;
const MIN_TURN = (0.2 * Math.PI) / 180;

function circle3(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-18) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) };
}

function turnAt(prev: Vec2, p: Vec2, next: Vec2): number {
  const ax = p[0] - prev[0], ay = p[1] - prev[1], bx = next[0] - p[0], by = next[1] - p[1];
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

/**
 * Split a closed polygon into straight edges and circular arcs. Polygons from the 2D kernel store
 * circles as many short edges whose vertices sit exactly on the circle; runs of at least four such
 * edges, each turning by less than 20 degrees, are recognised as arcs.
 */
export function contourPieces(poly: Vec2[]): Piece[] {
  const n = poly.length;
  if (n < 3) return [];
  let scale = 0;
  for (const p of poly) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]));
  const eps = 1e-7 * Math.max(1, scale);
  const turns = poly.map((p, i) => turnAt(poly[(i - 1 + n) % n], p, poly[(i + 1) % n]));
  // Full circle?
  // A closed run of 12 or more equal-turn vertices on one circle is a full circle (low-poly profiles included).
  if (n >= 12 && turns.every((t) => Math.abs(t) <= Math.max(MAX_TURN, (2 * Math.PI) / n + 1e-6) && Math.sign(t) === Math.sign(turns[0]) && Math.abs(t) > MIN_TURN)) {
    const c = circle3(poly[0], poly[Math.floor(n / 3)], poly[Math.floor((2 * n) / 3)]);
    if (c && poly.every((p) => Math.abs(Math.hypot(p[0] - c.c[0], p[1] - c.c[1]) - c.r) <= eps + 1e-6 * c.r)) {
      const maxT = Math.max(...turns.map(Math.abs));
      return [{ kind: 'arc', c: c.c, r: c.r, sag: c.r * (1 - Math.cos(maxT / 2)), pts: [...poly, poly[0]] }];
    }
  }
  // Start just after the longest edge (usually the end of a straight side), so arcs are not cut at the seam.
  let start = 0, longest = -1;
  for (let i = 0; i < n; i++) {
    const p = poly[(i - 1 + n) % n], q = poly[i];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l > longest) { longest = l; start = i; }
  }
  const Q: Vec2[] = [];
  const T: number[] = [];
  for (let i = 0; i <= n; i++) { Q.push(poly[(start + i) % n]); T.push(turns[(start + i) % n]); }
  const out: Piece[] = [];
  let i = 0;
  while (i < n) {
    let best = -1, bestC: { c: Vec2; r: number } | null = null;
    for (let j = i + 4; j <= n; j++) {
      let okTurn = true;
      // Kernel circles turn by the same angle at every vertex; near-collinear noise does not.
      let tMin = Infinity, tMax = 0;
      for (let q = i + 1; q < j; q++) {
        const a = Math.abs(T[q]);
        if (a > MAX_TURN || a < MIN_TURN || Math.sign(T[q]) !== Math.sign(T[i + 1])) { okTurn = false; break; }
        tMin = Math.min(tMin, a); tMax = Math.max(tMax, a);
      }
      if (!okTurn || tMax > 2.5 * tMin) break;
      // ...and have equal edge lengths, except the two end edges, which a boolean may have shortened.
      const lens: number[] = [];
      for (let q = i; q < j; q++) lens.push(Math.hypot(Q[q + 1][0] - Q[q][0], Q[q + 1][1] - Q[q][1]));
      const inner = lens.slice(1, -1);
      const lMax = Math.max(...inner), lMin = Math.min(...inner);
      if (lMax > 1.5 * lMin || lens[0] > 1.6 * lMax || lens[lens.length - 1] > 1.6 * lMax) break;
      const c = circle3(Q[i + 1], Q[Math.floor((i + j) / 2)], Q[j - 1]);
      if (!c || c.r > 1e4 * Math.max(scale, 1e-9)) break;
      const maxT = Math.max(...T.slice(i + 1, j).map(Math.abs));
      const loose = c.r * (1 - Math.cos(maxT / 2)) * 1.05 + eps;
      let fits = true;
      for (let q = i; q <= j && fits; q++) {
        const d = Math.abs(Math.hypot(Q[q][0] - c.c[0], Q[q][1] - c.c[1]) - c.r);
        if (d > (q === i || q === j ? loose : eps + 1e-6 * c.r)) fits = false;
      }
      if (!fits) break;
      best = j; bestC = c;
    }
    if (best > 0 && bestC) {
      const maxT = Math.max(...T.slice(i + 1, best).map(Math.abs));
      out.push({ kind: 'arc', c: bestC.c, r: bestC.r, sag: bestC.r * (1 - Math.cos(maxT / 2)), pts: Q.slice(i, best + 1) });
      i = best;
    } else {
      out.push({ kind: 'line', a: Q[i], b: Q[i + 1] });
      i++;
    }
  }
  return groupSplines(out);
}

const SPLINE_TURN = (25 * Math.PI) / 180;

/**
 * Free-form curves (font outlines, involutes, sampled splines) arrive as many short edges, some of
 * which happen to fit small circle arcs. A chain of pieces that join smoothly (small turn, similar
 * edge lengths) is merged into one spline piece when it is clearly not a plain arc: three or more
 * short lines, three or more arcs, or arcs mixed with two or more lines. Long straight edges and
 * isolated arcs (fillets, rounded corners, holes) stay exact lines and circles.
 */
function groupSplines(pieces: Piece[]): Piece[] {
  const n = pieces.length;
  if (n < 2) return pieces;
  const ptsOf = (p: Piece): Vec2[] => (p.kind === 'line' ? [p.a, p.b] : p.pts);
  const elen = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  // smooth[i]: piece i flows smoothly into piece i+1
  const smooth = pieces.map((p, i) => {
    const A = ptsOf(p), B = ptsOf(pieces[(i + 1) % n]);
    if (A.length < 2 || B.length < 2) return false;
    const a0 = A[A.length - 2], a1 = A[A.length - 1], b1 = B[1];
    const t = Math.abs(turnAt(a0, a1, b1));
    const r = elen(a0, a1) / Math.max(1e-300, elen(a1, b1));
    return t <= SPLINE_TURN && r < 2.5 && r > 0.4;
  });
  const worth = (chain: Piece[]) => {
    const arcs = chain.filter((p) => p.kind === 'arc').length, lines = chain.filter((p) => p.kind === 'line').length;
    return lines >= 3 || arcs >= 3 || (arcs >= 1 && lines >= 2) || chain.some((p) => p.kind === 'spline');
  };
  const merge = (chain: Piece[]): Vec2[] => {
    const pts: Vec2[] = [...ptsOf(chain[0])];
    for (const p of chain.slice(1)) pts.push(...ptsOf(p).slice(1));
    return pts;
  };
  if (smooth.every((x) => x)) {
    if (!worth(pieces)) return pieces;
    // a closed smooth loop: split in two open splines so no face wraps all the way round
    const pts = merge(pieces);
    pts.pop();
    const h = Math.floor(pts.length / 2);
    return [{ kind: 'spline', pts: pts.slice(0, h + 1) }, { kind: 'spline', pts: [...pts.slice(h), pts[0]] }];
  }
  // rotate so we start right after a break
  let s = 0;
  while (smooth[(s - 1 + n) % n]) s++;
  const out: Piece[] = [];
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n - 1 && smooth[(s + j) % n]) j++;
    const chain: Piece[] = [];
    for (let k = i; k <= j; k++) chain.push(pieces[(s + k) % n]);
    if (chain.length > 1 && worth(chain)) out.push({ kind: 'spline', pts: merge(chain) });
    else out.push(...chain);
    i = j + 1;
  }
  return out;
}

const to3 = (p: Vec2): Vec3 => [p[0], p[1], 0];

/** Sagitta-style tolerance: how far the polyline's chords stray from the spline through its points. */
function chordError(pts: Vec2[]): number {
  let e = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1], b = pts[i + 1], p = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    e = Math.max(e, Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l);
  }
  return e;
}

function extrudeSurfaces(polys: Vec2[][], h: number): SurfaceDef[] {
  const defs: SurfaceDef[] = [
    { type: 'plane', origin: [0, 0, 0], normal: [0, 0, -1], tol: 0 },
    { type: 'plane', origin: [0, 0, h], normal: [0, 0, 1], tol: 0 },
  ];
  for (const poly of polys)
    for (const p of contourPieces(poly)) {
      if (p.kind === 'line') {
        const dx = p.b[0] - p.a[0], dy = p.b[1] - p.a[1], l = Math.hypot(dx, dy);
        if (l < 1e-12) continue;
        defs.push({ type: 'plane', origin: [p.a[0], p.a[1], 0], normal: [dy / l, -dx / l, 0], tol: 0 });
      } else if (p.kind === 'arc') defs.push({ type: 'cylinder', origin: [p.c[0], p.c[1], 0], axis: [0, 0, 1], radius: p.r, tol: p.sag * 1.5 });
      else defs.push({ type: 'nurbs', surf: extrusionSurface(interpolateCurve(p.pts.map(to3)), 0, h), tol: chordError(p.pts) + 1e-9, hint: { mode: 'extrude', poly: p.pts, z0: 0, z1: h } });
    }
  return defs;
}

function revolveSurfaces(polys: Vec2[][], ringTol: number): SurfaceDef[] {
  const defs: SurfaceDef[] = [];
  for (const poly of polys) {
    let scale = 0;
    for (const p of poly) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]));
    const eps = 1e-9 * Math.max(1, scale);
    for (const p of contourPieces(poly)) {
      if (p.kind === 'line') {
        const [x1, y1] = p.a, [x2, y2] = p.b;
        if (Math.max(x1, x2) <= eps) continue; // on the axis
        if (Math.abs(y1 - y2) <= eps) defs.push({ type: 'plane', origin: [0, 0, y1], normal: [0, 0, 1], tol: 0 });
        else if (Math.abs(x1 - x2) <= eps) defs.push({ type: 'cylinder', origin: [0, 0, Math.min(y1, y2)], axis: [0, 0, 1], radius: x1, tol: ringTol });
        else {
          const [ra, za, rb, zb] = y1 < y2 ? [x1, y1, x2, y2] : [x2, y2, x1, y1];
          defs.push(coneDef(ra, za, rb, zb, ringTol));
        }
      } else if (p.kind === 'spline') {
        if (p.pts.some((q) => q[0] < -eps)) continue;
        defs.push({ type: 'nurbs', surf: revolutionSurface(interpolateCurve(p.pts.map(to3))), tol: ringTol + chordError(p.pts), hint: { mode: 'revolve', poly: p.pts } });
      } else if (Math.abs(p.c[0]) <= 1e-7 * Math.max(1, scale)) {
        defs.push({ type: 'sphere', center: [0, 0, p.c[1]], radius: p.r, tol: ringTol + p.sag * 1.5 });
      } else if (p.c[0] > 0) {
        defs.push({ type: 'torus', center: [0, 0, p.c[1]], axis: [0, 0, 1], major: p.c[0], minor: p.r, tol: ringTol + p.sag * 1.5 });
      }
    }
  }
  return defs;
}

// ------------------------------------------------------------------ Minkowski rounding

/**
 * Surfaces of `core` grown by a ball of radius r (Minkowski sum): every face moves out by r, every
 * convex edge becomes a cylinder and every corner a sphere. `seg` is the ball's segment count.
 */
export function minkowskiSurfaces(core: Manifold, r: number, seg: number): SurfaceDef[] {
  const mesh = core.getMesh();
  const P = mesh.vertProperties, np = mesh.numProp, T = mesh.triVerts;
  const vert = (i: number): Vec3 => [P[i * np], P[i * np + 1], P[i * np + 2]];
  const nt = T.length / 3;
  let scale = 1;
  for (let i = 0; i < P.length; i++) scale = Math.max(scale, Math.abs(P[i]));
  const eps = 1e-6 * scale;
  const tol = r * (1 - Math.cos((2 * Math.PI) / Math.max(6, seg))) * 1.5 + eps;
  const defs: SurfaceDef[] = [];
  const planes: { n: Vec3; d: number }[] = [];
  const triPlane: number[] = [];
  for (let t = 0; t < nt; t++) {
    const a = vert(T[t * 3]), b = vert(T[t * 3 + 1]), c = vert(T[t * 3 + 2]);
    const cr = v3.cross(v3.sub(b, a), v3.sub(c, a));
    if (v3.len(cr) < 1e-14) { triPlane.push(-1); continue; }
    const n = v3.norm(cr), d = v3.dot(n, a);
    let k = planes.findIndex((q) => v3.dot(q.n, n) > 1 - 1e-9 && Math.abs(q.d - d) < eps);
    if (k < 0) { k = planes.length; planes.push({ n, d }); defs.push({ type: 'plane', origin: v3.scale(n, d + r), normal: n, tol: 0 }); }
    triPlane.push(k);
  }
  // convex edges between different planes -> cylinders; their end points -> spheres
  const edges = new Map<string, number>();
  const corners = new Map<string, Vec3>();
  for (let t = 0; t < nt; t++)
    for (let e = 0; e < 3; e++) {
      const i = T[t * 3 + e], j = T[t * 3 + ((e + 1) % 3)];
      const key = `${Math.min(i, j)}_${Math.max(i, j)}`;
      const other = edges.get(key);
      if (other === undefined) { edges.set(key, t); continue; }
      const p1 = triPlane[t], p2 = triPlane[other];
      if (p1 < 0 || p2 < 0 || p1 === p2) continue;
      const a = vert(i), b = vert(j);
      const axis = v3.norm(v3.sub(b, a));
      const dup = defs.some((d) => d.type === 'cylinder' && Math.abs(Math.abs(v3.dot(d.axis, axis)) - 1) < 1e-9 && v3.len(v3.cross(v3.sub(a, d.origin), d.axis)) < eps);
      if (!dup) defs.push({ type: 'cylinder', origin: a, axis, radius: r, tol });
      for (const p of [a, b]) corners.set(p.map((x) => x.toFixed(6)).join(','), p);
    }
  for (const p of corners.values()) defs.push({ type: 'sphere', center: p, radius: r, tol });
  return defs;
}

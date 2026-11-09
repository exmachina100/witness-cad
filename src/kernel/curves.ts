// 3D curves, lofts and sweeps. Curves are sampled polylines with analytic evaluators where available.
import { K } from './wasm';
import { mat4, toVec3, v3, Vec2, Vec3 } from './math';
import { Shape } from './shape';
import { Sketch } from './sketch';
import { ForgeError } from './errors';

export class Curve3D {
  readonly kind = 'curve3d';
  constructor(readonly evalAt: (t: number) => Vec3, readonly closed = false, readonly defaultSamples = 64) {}
  pointAt(t: number): Vec3 { return this.evalAt(Math.max(0, Math.min(1, t))); }
  tangentAt(t: number): Vec3 {
    const h = 1e-4;
    const a = this.pointAt(Math.max(0, t - h)), b = this.pointAt(Math.min(1, t + h));
    return v3.norm(v3.sub(b, a));
  }
  sample(count = this.defaultSamples): Vec3[] {
    const out: Vec3[] = [];
    const n = Math.max(2, count);
    for (let i = 0; i < n; i++) out.push(this.pointAt(i / (n - 1)));
    if (this.closed) out.pop();
    return out;
  }
  sampleBySegment(maxLen: number): Vec3[] { return this.sample(Math.max(2, Math.ceil(this.length() / maxLen) + 1)); }
  sampleAdaptive(min = 16, max = 256): Vec3[] { return this.sample(Math.min(max, Math.max(min, Math.ceil(this.length() / 1)))); }
  length(samples = 256): number {
    let L = 0, p = this.pointAt(0);
    for (let i = 1; i <= samples; i++) { const q = this.pointAt(i / samples); L += v3.dist(p, q); p = q; }
    return L;
  }
  toPolyline(samples?: number): Vec3[] { return this.sample(samples); }
  reversed(): Curve3D { return new Curve3D((t) => this.evalAt(1 - t), this.closed, this.defaultSamples); }
  trimmed(a: number, b: number): Curve3D { return new Curve3D((t) => this.evalAt(a + (b - a) * t), false, this.defaultSamples); }
}

export function polylineCurve(points: Vec3[], closed = false): Curve3D {
  const pts = closed ? [...points, points[0]] : points;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + v3.dist(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1] || 1;
  return new Curve3D((t) => {
    const d = t * total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    return v3.lerp(pts[i - 1], pts[i], (d - cum[i - 1]) / seg);
  }, closed, Math.max(2, pts.length));
}

function nurbsEval(cps: Vec3[], weights: number[], degree: number, knots: number[]) {
  const n = cps.length;
  return (t: number): Vec3 => {
    const u = knots[degree] + (knots[n] - knots[degree]) * t;
    // find span
    let k = degree;
    while (k < n - 1 && u >= knots[k + 1]) k++;
    // de Boor in homogeneous coordinates
    const d: number[][] = [];
    for (let j = 0; j <= degree; j++) {
      const i = j + k - degree;
      const w = weights[i];
      d.push([cps[i][0] * w, cps[i][1] * w, cps[i][2] * w, w]);
    }
    for (let r = 1; r <= degree; r++)
      for (let j = degree; j >= r; j--) {
        const i = j + k - degree;
        const den = knots[i + degree - r + 1] - knots[i];
        const a = den ? (u - knots[i]) / den : 0;
        for (let c = 0; c < 4; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
      }
    const p = d[degree];
    return [p[0] / p[3], p[1] / p[3], p[2] / p[3]];
  };
}

function catmull3(points: Vec3[], closed: boolean): (t: number) => Vec3 {
  const n = points.length;
  const segs = closed ? n : n - 1;
  const get = (i: number) => (closed ? points[((i % n) + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  return (t: number) => {
    const s = Math.min(segs - 1e-9, Math.max(0, t * segs));
    const i = Math.floor(s), u = s - i;
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    // centripetal-ish uniform Catmull-Rom
    const u2 = u * u, u3 = u2 * u;
    const out: Vec3 = [0, 0, 0];
    for (let c = 0; c < 3; c++)
      out[c] = 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * u + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * u3);
    return out;
  };
}

function hermite(p0: Vec3, m0: Vec3, p1: Vec3, m1: Vec3) {
  return (t: number): Vec3 => {
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    return [0, 1, 2].map((c) => h00 * p0[c] + h10 * m0[c] + h01 * p1[c] + h11 * m1[c]) as Vec3;
  };
}

export class Route3D extends Curve3D {
  constructor(public points: Vec3[], public portsMap: Record<string, { origin: Vec3; axis: Vec3 }>) {
    super(polylineCurve(points).evalAt, false, points.length);
  }
  get segments() { return this.points.length - 1; }
  get ports() { return this.portsMap; }
  port(name: string) { return this.portsMap[name]; }
  toPolyline(o: any = {}): Vec3[] { return typeof o === 'number' ? this.sample(o) : this.points; }
}

export const Curve = {
  Line: (a: Vec3, b: Vec3) => new Curve3D((t) => v3.lerp(toVec3(a), toVec3(b), t), false, 2),
  Polyline: (pts: Vec3[], o: { closed?: boolean } = {}) => polylineCurve(pts.map((p) => toVec3(p)), o.closed),
  Arc: (o: { start: Vec3; end: Vec3; tangent?: Vec3; center?: Vec3; through?: Vec3 }) => {
    const s = toVec3(o.start), e = toVec3(o.end);
    let c: Vec3;
    if (o.center) c = toVec3(o.center);
    else if (o.through) return Curve.Fit([s, toVec3(o.through), e]);
    else {
      const tan = v3.norm(toVec3(o.tangent ?? [1, 0, 0]));
      const chord = v3.sub(e, s);
      const n = v3.norm(v3.cross(tan, chord));
      const inward = v3.cross(n, tan);
      const r = v3.dot(chord, chord) / (2 * v3.dot(chord, inward));
      c = v3.add(s, v3.scale(inward, r));
    }
    const a = v3.sub(s, c), b = v3.sub(e, c);
    const r = v3.len(a);
    const n = v3.norm(v3.cross(a, b));
    const ang = Math.atan2(v3.dot(v3.cross(a, b), n), v3.dot(a, b));
    const ua = v3.norm(a), ub = v3.cross(n, ua);
    return new Curve3D((t) => v3.add(c, v3.add(v3.scale(ua, r * Math.cos(ang * t)), v3.scale(ub, r * Math.sin(ang * t)))), false, 48);
  },
  Nurbs: (points: Vec3[], o: { degree?: number; weights?: number[]; knots?: number[]; closed?: boolean } = {}) => {
    let cps = points.map((p) => toVec3(p));
    const degree = Math.min(o.degree ?? 3, cps.length - 1);
    if (o.closed) cps = [...cps, ...cps.slice(0, degree)];
    const w = o.weights ?? cps.map(() => 1);
    const n = cps.length;
    const knots = o.knots ?? (o.closed
      ? Array.from({ length: n + degree + 1 }, (_, i) => i / (n + degree))
      : Array.from({ length: n + degree + 1 }, (_, i) => (i <= degree ? 0 : i >= n ? 1 : (i - degree) / (n - degree))));
    return new Curve3D(nurbsEval(cps, w, degree, knots), !!o.closed, 96);
  },
  Fit: (points: Vec3[], o: { closed?: boolean; degree?: number; tolerance?: number } = {}) =>
    new Curve3D(catmull3(points.map((p) => toVec3(p)), !!o.closed), !!o.closed, Math.max(32, points.length * 16)),
  Blend: (start: any, end: any) => {
    const p0 = toVec3(start.point), p1 = toVec3(end.point);
    const L = v3.dist(p0, p1);
    return new Curve3D(hermite(p0, v3.scale(v3.norm(toVec3(start.tangent)), L * (start.weight ?? 1)), p1, v3.scale(v3.norm(toVec3(end.tangent)), L * (end.weight ?? 1))), false, 48);
  },
  BlendG2: (start: any, end: any) => Curve.Blend(start, end),
  Bridge: (o: { from: { curve: Curve3D; at?: number; weight?: number }; to: { curve: Curve3D; at?: number; weight?: number }; weight?: number }) => {
    const fa = o.from.at ?? 1, ta = o.to.at ?? 0;
    const w = o.weight ?? 0.6;
    const p0 = o.from.curve.pointAt(fa), p1 = o.to.curve.pointAt(ta);
    let m0 = o.from.curve.tangentAt(fa), m1 = o.to.curve.tangentAt(ta);
    if (fa < 0.5) m0 = v3.scale(m0, -1);
    if (ta > 0.5) m1 = v3.scale(m1, -1);
    const L = v3.dist(p0, p1) * 2 * w;
    return new Curve3D(hermite(p0, v3.scale(m0, L * (o.from.weight ?? 1)), p1, v3.scale(m1, L * (o.to.weight ?? 1))), false, 48);
  },
  Trim: (c: Curve3D, a: number, b: number) => c.trimmed(a, b),
  Reverse: (c: Curve3D) => c.reversed(),
  closestParameter: (c: Curve3D, p: Vec3, o: { samples?: number } = {}) => {
    const n = o.samples ?? 256;
    let best = 0, bd = Infinity;
    for (let i = 0; i <= n; i++) { const d = v3.dist(c.pointAt(i / n), toVec3(p)); if (d < bd) { bd = d; best = i / n; } }
    return best;
  },
  placeOnXY: (path: any, z = 0) => polylineCurve(points2(path).map(([x, y]) => [x, y, z] as Vec3)),
  placeOnXZ: (path: any, y = 0) => polylineCurve(points2(path).map(([x, zz]) => [x, y, zz] as Vec3)),
  placeOnYZ: (path: any, x = 0) => polylineCurve(points2(path).map(([yy, zz]) => [x, yy, zz] as Vec3)),
  placeOnPlane: (path: any, o: { origin: Vec3; xAxis: Vec3; yAxis: Vec3 }) =>
    polylineCurve(points2(path).map(([a, b]) => v3.add(toVec3(o.origin), v3.add(v3.scale(toVec3(o.xAxis), a), v3.scale(toVec3(o.yAxis), b))))),
  Helix: {
    path: (o: { radius: number; pitch?: number; turns?: number; height?: number; startAngle?: number; clockwise?: boolean; samplesPerTurn?: number }) => {
      const pitch = o.pitch ?? (o.height != null && o.turns ? o.height / o.turns : 1);
      const turns = o.turns ?? (o.height != null ? o.height / pitch : 1);
      const dir = o.clockwise ? -1 : 1;
      const a0 = ((o.startAngle ?? 0) * Math.PI) / 180;
      return new Curve3D((t) => {
        const a = a0 + dir * t * turns * 2 * Math.PI;
        return [o.radius * Math.cos(a), o.radius * Math.sin(a), t * turns * pitch];
      }, false, Math.ceil(turns * (o.samplesPerTurn ?? 48)) + 1);
    },
    withPitchAndTurns: (o: { radius: number; pitch: number; turns: number }) => Curve.Helix.path(o),
    coil: (o: { radius: number; pitch: number; turns: number; wireRadius: number }) => sweepCircle(Curve.Helix.path(o), o.wireRadius),
  },
  Route: {
    fromPolyline: (points: Vec3[], o: { cornerRadius?: number; up?: Vec3 } = {}) => {
      const pts = points.map((p) => toVec3(p));
      const out = filletPolyline3(pts, o.cornerRadius ?? 0);
      const ports = {
        start: { origin: pts[0], axis: v3.norm(v3.sub(pts[0], pts[1])) },
        end: { origin: pts[pts.length - 1], axis: v3.norm(v3.sub(pts[pts.length - 1], pts[pts.length - 2])) },
      };
      return new Route3D(out, ports);
    },
  },
  ProjectOnSurface: () => { throw new ForgeError('CURVE.UNSUPPORTED', 'Curve.ProjectOnSurface needs the exact surface kernel (not yet available in Witness CAD)'); },
  Intersect: () => { throw new ForgeError('CURVE.UNSUPPORTED', 'Curve.Intersect needs the exact surface kernel (not yet available in Witness CAD)'); },
};

function points2(path: any): Vec2[] {
  if (Array.isArray(path)) return path.map((p: any) => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]));
  if (path?.toPolyline) return path.toPolyline().map((p: any) => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]));
  throw new ForgeError('CURVE.BAD_PATH', 'expected a 2D point list or path');
}

export function filletPolyline3(pts: Vec3[], r: number): Vec3[] {
  if (r <= 0 || pts.length < 3) return pts;
  const out: Vec3[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], a = v3.norm(v3.sub(pts[i - 1], p)), b = v3.norm(v3.sub(pts[i + 1], p));
    const ang = Math.acos(Math.max(-1, Math.min(1, v3.dot(a, b))));
    if (ang > Math.PI - 1e-3) { out.push(p); continue; }
    const t = Math.min(r / Math.tan(ang / 2), v3.dist(p, pts[i - 1]) / 2, v3.dist(p, pts[i + 1]) / 2);
    const rr = t * Math.tan(ang / 2);
    const s = v3.add(p, v3.scale(a, t)), e = v3.add(p, v3.scale(b, t));
    const bis = v3.norm(v3.add(a, b));
    const c = v3.add(p, v3.scale(bis, rr / Math.sin(ang / 2)));
    const arc = Curve.Arc({ start: s, end: e, center: c });
    out.push(...arc.sample(12));
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ---------------------------------------------------------------- mesh builders

function resampleLoop(loop: Vec2[], n: number): Vec2[] {
  const pts = [...loop, loop[0]];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const out: Vec2[] = [];
  let j = 1;
  for (let i = 0; i < n; i++) {
    const d = (i / n) * total;
    while (j < cum.length - 1 && cum[j] < d) j++;
    const s = cum[j] - cum[j - 1] || 1, u = (d - cum[j - 1]) / s;
    out.push([pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * u, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * u]);
  }
  return out;
}

/** Outer loop of a sketch, CCW, starting at the vertex nearest angle 0 from its centroid. */
function outerLoop(s: Sketch, n: number): Vec2[] {
  const polys = s.cs.toPolygons();
  let best = polys[0], ba = -Infinity;
  for (const p of polys) {
    let a = 0;
    for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
    if (a > ba) { ba = a; best = p; }
  }
  const loop = resampleLoop(best.map((p) => [p[0], p[1]] as Vec2), n);
  const cx = loop.reduce((s, p) => s + p[0], 0) / n, cy = loop.reduce((s, p) => s + p[1], 0) / n;
  let k = 0, bd = Infinity;
  loop.forEach((p, i) => { const a = Math.abs(Math.atan2(p[1] - cy, p[0] - cx)); if (a < bd) { bd = a; k = i; } });
  return [...loop.slice(k), ...loop.slice(0, k)];
}

/** Build a closed solid from rings of equal size; caps triangulated from the first and last ring. */
export function solidFromRings(rings: Vec3[][], cap2d: { first: Vec2[]; last: Vec2[] } | null, closedPath = false): Shape {
  const k = K();
  const n = rings[0].length;
  const verts: number[] = [];
  for (const r of rings) for (const p of r) verts.push(p[0], p[1], p[2]);
  const tris: number[] = [];
  const R = rings.length;
  const ringCount = closedPath ? R : R - 1;
  for (let i = 0; i < ringCount; i++) {
    const i2 = (i + 1) % R;
    for (let j = 0; j < n; j++) {
      const a = i * n + j, b = i * n + ((j + 1) % n), c = i2 * n + ((j + 1) % n), d = i2 * n + j;
      tris.push(a, b, c, a, c, d);
    }
  }
  if (!closedPath && cap2d) {
    const t0 = k.triangulate([cap2d.first] as any, 1e-6);
    for (const t of t0) tris.push(t[0], t[2], t[1]);
    const off = (R - 1) * n;
    const t1 = k.triangulate([cap2d.last] as any, 1e-6);
    for (const t of t1) tris.push(off + t[0], off + t[1], off + t[2]);
  }
  const mesh = new k.Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tris) });
  mesh.merge();
  let m = new k.Manifold(mesh);
  if (m.volume() < 0) {
    // inverted winding: flip every triangle
    for (let i = 0; i < tris.length; i += 3) [tris[i + 1], tris[i + 2]] = [tris[i + 2], tris[i + 1]];
    const mesh2 = new k.Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tris) });
    mesh2.merge();
    m = new k.Manifold(mesh2);
  }
  return new Shape(m);
}

export function loft(profiles: Sketch[], heights: any[], _opts: any = {}): Shape {
  if (profiles.length < 2 || profiles.length !== heights.length) throw new ForgeError('LOFT.ARITY', 'loft needs matching profiles and heights (at least two)');
  const hs = heights.map((h) => (typeof h === 'number' ? h : h.offset ?? h.height ?? 0));
  for (let i = 1; i < hs.length; i++) if (!(hs[i] > hs[i - 1])) throw new ForgeError('LOFT.HEIGHTS', 'loft heights must be strictly increasing');
  const N = 96;
  const loops = profiles.map((p) => outerLoop(p, N));
  // Add intermediate rings for smooth blending (Catmull-Rom across stations).
  const rings: Vec3[][] = [];
  const sub = profiles.length > 2 ? 6 : 1;
  for (let i = 0; i < loops.length - 1; i++) {
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      const ring: Vec3[] = [];
      for (let j = 0; j < N; j++) {
        const get = (k: number) => loops[Math.max(0, Math.min(loops.length - 1, k))][j];
        const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
        const cr = (c: 0 | 1) => sub === 1 ? p1[c] + (p2[c] - p1[c]) * t : 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t * t + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t * t * t);
        ring.push([cr(0), cr(1), hs[i] + (hs[i + 1] - hs[i]) * t]);
      }
      rings.push(ring);
    }
  }
  rings.push(loops[loops.length - 1].map(([x, y]) => [x, y, hs[hs.length - 1]] as Vec3));
  return solidFromRings(rings, { first: loops[0], last: loops[loops.length - 1] });
}

/** Rotation-minimising frames along a polyline. */
export function frames(pts: Vec3[], up?: Vec3, closed = false) {
  const tangents = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    if (closed) return v3.norm(v3.sub(pts[(i + 1) % pts.length], pts[(i - 1 + pts.length) % pts.length]));
    return v3.norm(v3.sub(b, a));
  });
  let n = up ? v3.norm(v3.sub(toVec3(up), v3.scale(tangents[0], v3.dot(toVec3(up), tangents[0])))) : v3.perp(tangents[0]);
  if (v3.len(n) < 1e-6) n = v3.perp(tangents[0]);
  const out: { o: Vec3; t: Vec3; n: Vec3; b: Vec3 }[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      // double reflection
      const v1 = v3.sub(pts[i], pts[i - 1]);
      const c1 = v3.dot(v1, v1) || 1;
      const rL = v3.sub(n, v3.scale(v1, (2 / c1) * v3.dot(v1, n)));
      const tL = v3.sub(tangents[i - 1], v3.scale(v1, (2 / c1) * v3.dot(v1, tangents[i - 1])));
      const v2 = v3.sub(tangents[i], tL);
      const c2 = v3.dot(v2, v2);
      n = c2 < 1e-12 ? rL : v3.sub(rL, v3.scale(v2, (2 / c2) * v3.dot(v2, rL)));
      n = v3.norm(n);
    }
    out.push({ o: pts[i], t: tangents[i], n, b: v3.cross(tangents[i], n) });
  }
  return out;
}

function pathPoints(path: any, samples = 48): { pts: Vec3[]; closed: boolean } {
  if (path instanceof Curve3D) return { pts: path instanceof Route3D ? path.points : path.sample(Math.max(samples, path.defaultSamples)), closed: path.closed };
  if (Array.isArray(path)) return { pts: path.map((p: any) => toVec3(p)), closed: false };
  if (path?.toPolyline) return { pts: path.toPolyline().map((p: any) => toVec3(p)), closed: false };
  throw new ForgeError('SWEEP.BAD_PATH', 'sweep path must be a Curve3D, Route or [x,y,z][]');
}

export function sweep(profile: Sketch, path: any, opts: { samples?: number; up?: Vec3 } = {}): Shape {
  const { pts, closed } = pathPoints(path, opts.samples ?? 48);
  const polys = profile.cs.toPolygons();
  const fr = frames(pts, opts.up, closed);
  const solids: { shape: Shape; area: number }[] = [];
  for (const poly of polys) {
    let area = 0;
    for (let i = 0; i < poly.length; i++) { const q = poly[(i + 1) % poly.length]; area += poly[i][0] * q[1] - q[0] * poly[i][1]; }
    const loop = (area < 0 ? [...poly].reverse() : poly).map((p) => [p[0], p[1]] as Vec2);
    const rings = fr.map((f) => loop.map(([x, y]) => v3.add(f.o, v3.add(v3.scale(f.n, x), v3.scale(f.b, y)))));
    solids.push({ shape: solidFromRings(rings, { first: loop, last: loop }, closed), area });
  }
  const outer = solids.filter((s) => s.area > 0).map((s) => s.shape);
  const holes = solids.filter((s) => s.area < 0).map((s) => s.shape);
  let out = outer[0];
  if (outer.length > 1) out = out.add(...outer.slice(1));
  if (holes.length) out = out.subtract(...holes);
  return out;
}

export function sweepCircle(path: Curve3D, r: number, seg = 16): Shape {
  const pts: Vec2[] = [];
  for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; pts.push([r * Math.cos(a), r * Math.sin(a)]); }
  return sweep(new Sketch(K().CrossSection.ofPolygons([pts] as any)), path);
}

export function variableSweep(spine: any, sections: { t: number; profile: Sketch }[], opts: any = {}): Shape {
  const { pts, closed } = pathPoints(spine, opts.samples ?? 64);
  const fr = frames(pts, opts.up, closed);
  const N = 64;
  const st = [...sections].sort((a, b) => a.t - b.t);
  const loops = st.map((s) => outerLoop(s.profile, N));
  const rings = fr.map((f, i) => {
    const t = i / (fr.length - 1);
    let k = 0;
    while (k < st.length - 2 && t > st[k + 1].t) k++;
    const a = st[k], b = st[Math.min(k + 1, st.length - 1)];
    const u = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
    return loops[k].map((p, j) => {
      const q = loops[Math.min(k + 1, loops.length - 1)][j];
      const x = p[0] + (q[0] - p[0]) * u, y = p[1] + (q[1] - p[1]) * u;
      return v3.add(f.o, v3.add(v3.scale(f.n, x), v3.scale(f.b, y)));
    });
  });
  return solidFromRings(rings, { first: loops[0], last: loops[loops.length - 1] }, closed);
}

export const Loft = {
  field: (profiles: Sketch[], heights: any[], opts: any = {}) => loft(profiles, heights, opts),
  withGuideRails: (stations: { profile: Sketch; position: number }[], _rails: any, opts: any = {}) =>
    loft(stations.map((s) => s.profile), stations.map((s) => s.position), opts),
  leftRail: (p: any) => ({ side: 'left', path: p }),
  rightRail: (p: any) => ({ side: 'right', path: p }),
  frontRail: (p: any) => ({ side: 'front', path: p }),
  backRail: (p: any) => ({ side: 'back', path: p }),
};

/** Tube along points with an optional bend radius (pipeRoute). */
export function tubeAlong(points: Vec3[], radius: number, bendRadius = 0, wall = 0, segments = 24): Shape {
  const route = Curve.Route.fromPolyline(points, { cornerRadius: bendRadius });
  const outer = sweep(new Sketch(K().CrossSection.circle(radius, segments)), route);
  if (!wall) return outer;
  return outer.subtract(sweep(new Sketch(K().CrossSection.circle(radius - wall, segments)), route).translate(0, 0, 0));
}

export { mat4 };

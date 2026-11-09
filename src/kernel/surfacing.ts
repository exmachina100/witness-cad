// Surface modelling: open sheets (parametric patches on [0,1]^2), sewing into bodies and solids,
// blends, continuity analysis, variable thickness, control-cage sculpting, product skins and
// carriers for surface-mounted features.
import { ForgeError } from './errors';
import { K } from './wasm';
import { mat4, Mat4, toVec3, v3, Vec2, Vec3 } from './math';
import { Shape } from './shape';
import { box, union } from './ops';
import { Sketch, polygon } from './sketch';
import { Curve3D, solidFromRings } from './curves';
import { NurbsSurface, evalSurface, interpolateSurface, domainU, domainV } from './nurbs';
import { ctx } from './context';

type F = (u: number, v: number) => Vec3;
type Edge = 'u0' | 'u1' | 'v0' | 'v1';
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- curves in
/** Resample anything curve-like (Vec3[], Vec2[], Curve3D, Sketch, {points}) to n points by arc length. */
export function curvePoints(c: any, n = 48): Vec3[] {
  let pts: Vec3[];
  let closed = false;
  if (c instanceof Curve3D) { pts = c.sample(Math.max(n * 2, 64)); closed = c.closed; if (closed) pts.push(pts[0]); }
  else if (c instanceof Sketch) { const poly = c.toPolygons()[0]; const m = c.placement; pts = poly.map((p) => (m ? mat4.apply(m, [p[0], p[1], 0]) : [p[0], p[1], 0] as Vec3)); pts.push(pts[0]); closed = true; }
  else if (c?.points) pts = c.points.map((p: any) => toVec3(p.length === 2 ? [p[0], p[1], 0] : p));
  else if (Array.isArray(c)) pts = c.map((p: any) => toVec3(p.length === 2 ? [p[0], p[1], 0] : p));
  else if (typeof c === 'function') pts = Array.from({ length: n }, (_, i) => toVec3(c(i / (n - 1))));
  else throw new ForgeError('SURFACE.BAD_CURVE', 'expected points, a Curve, or a sketch');
  return resample(pts, n);
}
function resample(pts: Vec3[], n: number): Vec3[] {
  if (pts.length < 2) throw new ForgeError('SURFACE.BAD_CURVE', 'a curve needs at least two points');
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + v3.dist(pts[i - 1], pts[i]));
  const L = cum[cum.length - 1] || 1;
  const out: Vec3[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const s = (L * i) / (n - 1);
    while (k < cum.length - 2 && cum[k + 1] < s) k++;
    const seg = cum[k + 1] - cum[k] || 1;
    out.push(v3.lerp(pts[k], pts[k + 1], (s - cum[k]) / seg));
  }
  return out;
}
const at = (pts: Vec3[], t: number): Vec3 => { const x = Math.max(0, Math.min(1, t)) * (pts.length - 1); const i = Math.min(pts.length - 2, Math.floor(x)); return v3.lerp(pts[i], pts[i + 1], x - i); };

// ---------------------------------------------------------------- sheets
export class SurfaceSheet {
  readonly kind = 'surfaceSheet';
  constructor(readonly f: F, readonly opts: { nu?: number; nv?: number; closedU?: boolean; closedV?: boolean; name?: string; nurbs?: NurbsSurface } = {}) {}
  get name() { return this.opts.name; }
  point(u: number, v: number): Vec3 { return this.f(u, v); }
  derivU(u: number, v: number): Vec3 { const h = 1e-4; return v3.scale(v3.sub(this.f(Math.min(1, u + h), v), this.f(Math.max(0, u - h), v)), 1 / (Math.min(1, u + h) - Math.max(0, u - h))); }
  derivV(u: number, v: number): Vec3 { const h = 1e-4; return v3.scale(v3.sub(this.f(u, Math.min(1, v + h)), this.f(u, Math.max(0, v - h))), 1 / (Math.min(1, v + h) - Math.max(0, v - h))); }
  normal(u: number, v: number): Vec3 {
    const n = v3.cross(this.derivU(u, v), this.derivV(u, v));
    if (v3.len(n) > 1e-12) return v3.norm(n);
    // degenerate (pole): average nearby normals
    const e = 1e-2; return v3.norm(v3.cross(this.derivU(Math.min(1 - e, Math.max(e, u)), Math.min(1 - e, Math.max(e, v))), this.derivV(Math.min(1 - e, Math.max(e, u)), Math.min(1 - e, Math.max(e, v)))));
  }
  grid(nu = this.opts.nu ?? 32, nv = this.opts.nv ?? 32): Vec3[][] {
    return Array.from({ length: nu + 1 }, (_, i) => Array.from({ length: nv + 1 }, (_, j) => this.f(i / nu, j / nv)));
  }
  edge(e: Edge, n = 32): Vec3[] {
    return Array.from({ length: n + 1 }, (_, i) => { const t = i / n; return e === 'u0' ? this.f(0, t) : e === 'u1' ? this.f(1, t) : e === 'v0' ? this.f(t, 0) : this.f(t, 1); });
  }
  edgeCurve(e: Edge) { return new Curve3D((t) => (e === 'u0' ? this.f(0, t) : e === 'u1' ? this.f(1, t) : e === 'v0' ? this.f(t, 0) : this.f(t, 1))); }
  area(n = 48) {
    const g = this.grid(n, n); let a = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const p = g[i][j], q = g[i + 1][j], r = g[i + 1][j + 1], s = g[i][j + 1]; a += v3.len(v3.cross(v3.sub(q, p), v3.sub(r, p))) / 2 + v3.len(v3.cross(v3.sub(r, p), v3.sub(s, p))) / 2; }
    return a;
  }
  boundingBox() { const pts = this.grid(16, 16).flat(); const min = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))) as Vec3, max = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k]))) as Vec3; return { min, max, size: v3.sub(max, min), center: v3.lerp(min, max, 0.5) }; }
  // transforms
  transform(m: Mat4): SurfaceSheet { return new SurfaceSheet((u, v) => mat4.apply(m, this.f(u, v)), this.opts); }
  translate(x: number | Vec3, y = 0, z = 0) { const t = Array.isArray(x) ? x : [x, y, z]; return this.transform(mat4.translation(t[0], t[1], t[2])); }
  rotate(axis: Vec3, deg: number) { return this.transform(mat4.axisAngle(axis, deg)); }
  rotateX(d: number) { return this.rotate([1, 0, 0], d); }
  rotateY(d: number) { return this.rotate([0, 1, 0], d); }
  rotateZ(d: number) { return this.rotate([0, 0, 1], d); }
  scale(s: number) { return this.transform(mat4.scaling(s, s, s)); }
  mirror(normal: Vec3) { const n = v3.norm(normal); return new SurfaceSheet((u, v) => { const p = this.f(u, v); return v3.sub(p, v3.scale(n, 2 * v3.dot(p, n))); }, this.opts).flip(); }
  flip(): SurfaceSheet { return new SurfaceSheet((u, v) => this.f(1 - u, v), { ...this.opts }); }
  swapUV(): SurfaceSheet { return new SurfaceSheet((u, v) => this.f(v, u), { ...this.opts, nu: this.opts.nv, nv: this.opts.nu, closedU: this.opts.closedV, closedV: this.opts.closedU }); }
  named(name: string) { return new SurfaceSheet(this.f, { ...this.opts, name }); }
  /** Sub-patch of the parameter rectangle. */
  trim(o: { u?: [number, number]; v?: [number, number] }) {
    const [u0, u1] = o.u ?? [0, 1], [v0, v1] = o.v ?? [0, 1];
    return new SurfaceSheet((u, v) => this.f(u0 + (u1 - u0) * u, v0 + (v1 - v0) * v), { ...this.opts, closedU: false, closedV: false });
  }
  split(dir: 'u' | 'v', t = 0.5): [SurfaceSheet, SurfaceSheet] { return dir === 'u' ? [this.trim({ u: [0, t] }), this.trim({ u: [t, 1] })] : [this.trim({ v: [0, t] }), this.trim({ v: [t, 1] })]; }
  /** Extend tangentially past an edge by `distance`. */
  extend(distance: number, edge: Edge = 'u1') {
    const L = Math.max(1e-6, curveLen(this, edge === 'u0' || edge === 'u1' ? 'u' : 'v'));
    const k = distance / L;
    const ext = (s: number) => (s < 0 || s > 1 ? s : s);
    void ext;
    return new SurfaceSheet((u, v) => {
      const U = edge === 'u0' ? -k + (1 + k) * u : edge === 'u1' ? (1 + k) * u : u;
      const V = edge === 'v0' ? -k + (1 + k) * v : edge === 'v1' ? (1 + k) * v : v;
      const cu = Math.max(0, Math.min(1, U)), cv = Math.max(0, Math.min(1, V));
      let p = this.f(cu, cv);
      if (U !== cu) p = v3.add(p, v3.scale(this.derivU(cu, cv), U - cu));
      if (V !== cv) p = v3.add(p, v3.scale(this.derivV(cu, cv), V - cv));
      return p;
    }, { ...this.opts, closedU: false, closedV: false });
  }
  offset(d: number) { return new SurfaceSheet((u, v) => v3.add(this.f(u, v), v3.scale(this.normal(u, v), d)), this.opts); }
  /** Solid shell: offset by `t` along the normal (side: 'out' | 'in' | 'both'). */
  thicken(t: number, o: { side?: 'out' | 'in' | 'both'; nu?: number; nv?: number } = {}): Shape { return thickenVar(this, () => t, o); }
  /** Thin solid for display. */
  toShape(): Shape { return this.thicken(Math.max(0.2, Math.max(...this.boundingBox().size) * 0.004)); }
  /** Big solid on the normal side, for splitting solids by this sheet. */
  toCutter(_shape?: Shape): Shape {
    const big = Math.max(...this.boundingBox().size) * 2 + 1000;
    return this.extend(big * 0.25, 'u0').extend(big * 0.25, 'u1').extend(big * 0.25, 'v0').extend(big * 0.25, 'v1').thicken(big, { side: 'out', nu: 24, nv: 24 });
  }
  toNurbs(n = 12): NurbsSurface { return this.opts.nurbs ?? interpolateSurface(this.grid(n, n)); }
}
function curveLen(s: SurfaceSheet, dir: 'u' | 'v') { let L = 0; let p = dir === 'u' ? s.f(0, 0.5) : s.f(0.5, 0); for (let i = 1; i <= 32; i++) { const q = dir === 'u' ? s.f(i / 32, 0.5) : s.f(0.5, i / 32); L += v3.dist(p, q); p = q; } return L; }

/** Build a closed manifold from a sheet and a per-sample thickness function. */
function thickenVar(s: SurfaceSheet, t: (u: number, v: number) => number, o: { side?: 'out' | 'in' | 'both'; nu?: number; nv?: number } = {}): Shape {
  const nu = o.nu ?? s.opts.nu ?? 32, nv = o.nv ?? s.opts.nv ?? 32;
  const cu = !!s.opts.closedU, cv = !!s.opts.closedV;
  const side = o.side ?? 'out';
  const [a, b] = side === 'out' ? [0, 1] : side === 'in' ? [-1, 0] : [-0.5, 0.5];
  const iu = cu ? nu : nu + 1, iv = cv ? nv : nv + 1;
  const verts: number[] = [];
  const idx = (layer: number, i: number, j: number) => layer * iu * iv + (i % iu) * iv + (j % iv);
  for (const f of [a, b]) for (let i = 0; i < iu; i++) for (let j = 0; j < iv; j++) {
    const u = i / nu, v = j / nv, p = s.f(u, v), n = s.normal(u, v), d = t(u, v) * f;
    verts.push(p[0] + n[0] * d, p[1] + n[1] * d, p[2] + n[2] * d);
  }
  const tris: number[] = [];
  const quad = (p: number, q: number, r: number, w: number) => tris.push(p, q, r, p, r, w);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    quad(idx(1, i, j), idx(1, i + 1, j), idx(1, i + 1, j + 1), idx(1, i, j + 1));
    quad(idx(0, i, j), idx(0, i, j + 1), idx(0, i + 1, j + 1), idx(0, i + 1, j));
  }
  if (!cu) for (let j = 0; j < nv; j++) { quad(idx(0, 0, j), idx(1, 0, j), idx(1, 0, j + 1), idx(0, 0, j + 1)); quad(idx(0, nu, j), idx(0, nu, j + 1), idx(1, nu, j + 1), idx(1, nu, j)); }
  if (!cv) for (let i = 0; i < nu; i++) { quad(idx(0, i, 0), idx(0, i + 1, 0), idx(1, i + 1, 0), idx(1, i, 0)); quad(idx(0, i, nv), idx(1, i, nv), idx(1, i + 1, nv), idx(0, i + 1, nv)); }
  return meshSolid(verts, tris, s.name);
}
function meshSolid(verts: number[], tris: number[], name?: string): Shape {
  const k = K();
  const build = () => { const mesh = new k.Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tris) }); mesh.merge(); return new k.Manifold(mesh); };
  let m;
  try { m = build(); } catch (e: any) { throw new ForgeError('SURFACE.NOT_CLOSED', `surface did not close into a solid (${e?.message ?? e})`); }
  if (m.volume() < 0) { for (let i = 0; i < tris.length; i += 3) [tris[i + 1], tris[i + 2]] = [tris[i + 2], tris[i + 1]]; m = build(); }
  return new Shape(m, { name });
}

// ---------------------------------------------------------------- bodies
export class SurfaceBody {
  readonly kind = 'surfaceBody';
  constructor(readonly sheets: SurfaceSheet[], readonly name?: string) {}
  add(...s: SurfaceSheet[]) { return new SurfaceBody([...this.sheets, ...s], this.name); }
  transform(m: Mat4) { return new SurfaceBody(this.sheets.map((s) => s.transform(m)), this.name); }
  translate(x: number | Vec3, y = 0, z = 0) { return new SurfaceBody(this.sheets.map((s) => s.translate(x, y, z)), this.name); }
  area() { return this.sheets.reduce((a, s) => a + s.area(), 0); }
  /** Open edges after sewing within `tolerance`. */
  openEdges(tolerance = 1e-3) {
    const edges: { sheet: number; edge: Edge; pts: Vec3[] }[] = [];
    this.sheets.forEach((s, i) => (['u0', 'u1', 'v0', 'v1'] as Edge[]).forEach((e) => { if ((e[0] === 'u' && s.opts.closedU) || (e[0] === 'v' && s.opts.closedV)) return; const pts = s.edge(e, 8); if (v3.dist(pts[0], pts[8]) < tolerance && pts.every((p) => v3.dist(p, pts[0]) < tolerance)) return; edges.push({ sheet: i, edge: e, pts }); }));
    const matched = new Set<number>();
    for (let a = 0; a < edges.length; a++) for (let b = a + 1; b < edges.length; b++) {
      if (matched.has(a) || matched.has(b)) continue;
      const A = edges[a].pts, B = edges[b].pts;
      const same = A.every((p, k) => v3.dist(p, B[k]) < tolerance), rev = A.every((p, k) => v3.dist(p, B[8 - k]) < tolerance);
      if (same || rev) { matched.add(a); matched.add(b); }
    }
    return edges.filter((_, i) => !matched.has(i)).map((e) => ({ sheet: e.sheet, edge: e.edge }));
  }
  isClosed(tolerance = 1e-3) { return this.openEdges(tolerance).length === 0; }
  /** Closed body -> solid (tessellate and weld). */
  toSolid(o: { n?: number } = {}): Shape {
    const n = o.n ?? 32;
    const verts: number[] = [], tris: number[] = [];
    for (const s of this.sheets) {
      const g = s.grid(n, n), base = verts.length / 3;
      for (const row of g) for (const p of row) verts.push(p[0], p[1], p[2]);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const a = base + i * (n + 1) + j, b = a + n + 1; tris.push(a, b, b + 1, a, b + 1, a + 1); }
    }
    // weld coincident vertices exactly so Manifold sees a closed mesh
    const key = (i: number) => `${verts[i * 3].toFixed(4)},${verts[i * 3 + 1].toFixed(4)},${verts[i * 3 + 2].toFixed(4)}`;
    const map = new Map<string, number>(), remap: number[] = [], out: number[] = [];
    for (let i = 0; i < verts.length / 3; i++) { const k = key(i); let r = map.get(k); if (r == null) { r = out.length / 3; map.set(k, r); out.push(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]); } remap.push(r); }
    const t2: number[] = [];
    for (let i = 0; i < tris.length; i += 3) { const a = remap[tris[i]], b = remap[tris[i + 1]], c = remap[tris[i + 2]]; if (a !== b && b !== c && a !== c) t2.push(a, b, c); }
    return meshSolid(out, t2, this.name);
  }
  toShape(): Shape { return this.isClosed() ? this.toSolid() : union(this.sheets.map((s) => s.toShape())); }
}

// ---------------------------------------------------------------- constructors
const sheetOf = (s: any): SurfaceSheet => { if (s instanceof SurfaceSheet) return s; throw new ForgeError('SURFACE.NOT_SHEET', 'expected a surface sheet'); };
const ringFn = (pts: Vec3[]) => (t: number) => at(pts, t);

export const Surface = {
  Plane(o: { width?: number; height?: number; origin?: Vec3; normal?: Vec3; x?: Vec3 } = {}) {
    const w = o.width ?? 100, h = o.height ?? w;
    const n = v3.norm(toVec3(o.normal ?? [0, 0, 1])), x = o.x ? v3.norm(toVec3(o.x)) : v3.perp(n), y = v3.cross(n, x), c = toVec3(o.origin ?? [0, 0, 0]);
    return new SurfaceSheet((u, v) => v3.add(c, v3.add(v3.scale(x, (u - 0.5) * w), v3.scale(y, (v - 0.5) * h))), { nu: 1, nv: 1 });
  },
  Cylinder(o: { radius: number; height: number; sweep?: number; origin?: Vec3 }) {
    const sw = ((o.sweep ?? 360) * Math.PI) / 180, c = toVec3(o.origin ?? [0, 0, 0]);
    return new SurfaceSheet((u, v) => [c[0] + o.radius * Math.cos(u * sw), c[1] + o.radius * Math.sin(u * sw), c[2] + v * o.height], { nu: 64, nv: 1, closedU: (o.sweep ?? 360) >= 360 });
  },
  Cone(o: { radius1: number; radius2?: number; height: number; sweep?: number }) {
    const sw = ((o.sweep ?? 360) * Math.PI) / 180, r2 = o.radius2 ?? 0;
    return new SurfaceSheet((u, v) => { const r = o.radius1 + (r2 - o.radius1) * v; return [r * Math.cos(u * sw), r * Math.sin(u * sw), v * o.height]; }, { nu: 64, nv: 1, closedU: (o.sweep ?? 360) >= 360 });
  },
  Sphere(o: { radius: number; center?: Vec3 }) {
    const c = toVec3(o.center ?? [0, 0, 0]);
    return new SurfaceSheet((u, v) => { const th = u * TAU, ph = -Math.PI / 2 + v * Math.PI; return [c[0] + o.radius * Math.cos(ph) * Math.cos(th), c[1] + o.radius * Math.cos(ph) * Math.sin(th), c[2] + o.radius * Math.sin(ph)]; }, { nu: 48, nv: 24, closedU: true });
  },
  Torus(o: { major: number; minor: number }) {
    return new SurfaceSheet((u, v) => { const a = u * TAU, b = v * TAU, r = o.major + o.minor * Math.cos(b); return [r * Math.cos(a), r * Math.sin(a), o.minor * Math.sin(b)]; }, { nu: 64, nv: 24, closedU: true, closedV: true });
  },
  /** Sweep an open/closed profile (in the XY plane, local to the path frame) along a path. */
  Sweep(profile: any, path: any, o: { samples?: number; up?: Vec3 } = {}) {
    const P = curvePoints(path, o.samples ?? 64), prof = curvePoints(profile, 48).map((p) => [p[0], p[1]] as Vec2);
    const frames = rmf(P, o.up);
    return new SurfaceSheet((u, v) => { const fr = frameAt(frames, P, v); const q = at(prof.map((p) => [p[0], p[1], 0] as Vec3), u); return v3.add(fr.o, v3.add(v3.scale(fr.x, q[0]), v3.scale(fr.y, q[1]))); }, { nu: 48, nv: Math.min(96, P.length) });
  },
  Tube(path: any, radius: number, o: { samples?: number } = {}) { return Surface.VariableTube(path, () => radius, o); },
  VariableTube(path: any, radius: number[] | ((t: number) => number), o: { samples?: number } = {}) {
    const P = curvePoints(path, o.samples ?? 64), frames = rmf(P);
    const rf = typeof radius === 'function' ? radius : (t: number) => at(radius.map((r) => [r, 0, 0] as Vec3), t)[0];
    return new SurfaceSheet((u, v) => { const fr = frameAt(frames, P, v), r = rf(v), a = u * TAU; return v3.add(fr.o, v3.add(v3.scale(fr.x, r * Math.cos(a)), v3.scale(fr.y, r * Math.sin(a)))); }, { nu: 32, nv: Math.min(96, P.length), closedU: true });
  },
  /** Loft through sections (curves/points/sketches). Smooth (Catmull-Rom) across sections. */
  Loft(sections: any[], o: { closed?: boolean; n?: number } = {}) {
    if (sections.length < 2) throw new ForgeError('SURFACE.LOFT', 'a loft needs at least two sections');
    const S = sections.map((s) => curvePoints(s, o.n ?? 64));
    const closed = S.every((s) => v3.dist(s[0], s[s.length - 1]) < 1e-6);
    return new SurfaceSheet((u, v) => crAt(S.map((s) => at(s, u)), v), { nu: o.n ?? 64, nv: Math.max(8, (S.length - 1) * 12), closedU: closed });
  },
  /** NURBS through a grid of points ({ points }) or from control points ({ control, degree, weights }). */
  Nurbs(o: { points?: Vec3[][]; control?: Vec3[][]; degree?: number; weights?: number[][] }) {
    let ns: NurbsSurface;
    if (o.points) ns = interpolateSurface(o.points.map((r) => r.map((p) => toVec3(p))), o.degree ?? 3, o.degree ?? 3);
    else if (o.control) {
      const nu = o.control.length, nv = o.control[0].length, du = Math.min(o.degree ?? 3, nu - 1), dv = Math.min(o.degree ?? 3, nv - 1);
      const knots = (n: number, d: number) => [...Array(d + 1).fill(0), ...Array.from({ length: n - d - 1 }, (_, i) => (i + 1) / (n - d)), ...Array(d + 1).fill(1)];
      ns = { degU: du, degV: dv, nu, nv, knotsU: knots(nu, du), knotsV: knots(nv, dv), ctrl: o.control.flat().map((p) => toVec3(p)), weights: o.weights?.flat() };
    } else throw new ForgeError('SURFACE.NURBS', 'Surface.Nurbs needs points or control');
    const [u0, u1] = domainU(ns), [v0, v1] = domainV(ns);
    return new SurfaceSheet((u, v) => evalSurface(ns, u0 + (u1 - u0) * u, v0 + (v1 - v0) * v), { nu: 32, nv: 32, nurbs: ns });
  },
  Ruled(a: any, b: any) { const A = curvePoints(a, 64), B = curvePoints(b, 64); return new SurfaceSheet((u, v) => v3.lerp(at(A, u), at(B, u), v), { nu: 64, nv: 1 }); },
  /** Coons patch from four boundary curves (bottom, right, top, left; any direction). */
  Patch(curves: any[]) {
    if (curves.length !== 4) throw new ForgeError('SURFACE.PATCH', 'Surface.Patch needs four boundary curves');
    let [c0, c1, c2, c3] = curves.map((c) => curvePoints(c, 64));
    // orient: c0 u-dir at v=0, c2 u-dir at v=1, c3 v-dir at u=0, c1 v-dir at u=1
    const near = (p: Vec3, q: Vec3) => v3.dist(p, q);
    if (near(c1[0], c0[c0.length - 1]) > near(c1[c1.length - 1], c0[c0.length - 1])) c1 = [...c1].reverse();
    if (near(c2[0], c3[c3.length - 1]) > near(c2[c2.length - 1], c3[c3.length - 1]) && near(c2[0], c1[c1.length - 1]) < near(c2[c2.length - 1], c1[c1.length - 1])) c2 = [...c2].reverse();
    if (near(c2[c2.length - 1], c1[c1.length - 1]) > near(c2[0], c1[c1.length - 1])) c2 = [...c2].reverse();
    if (near(c3[0], c0[0]) > near(c3[c3.length - 1], c0[0])) c3 = [...c3].reverse();
    const P00 = c0[0], P10 = c0[c0.length - 1], P01 = c2[0], P11 = c2[c2.length - 1];
    return new SurfaceSheet((u, v) => {
      const Lc = v3.add(v3.scale(at(c0, u), 1 - v), v3.scale(at(c2, u), v));
      const Ld = v3.add(v3.scale(at(c3, v), 1 - u), v3.scale(at(c1, v), u));
      const B = v3.add(v3.add(v3.scale(P00, (1 - u) * (1 - v)), v3.scale(P10, u * (1 - v))), v3.add(v3.scale(P01, (1 - u) * v), v3.scale(P11, u * v)));
      return v3.sub(v3.add(Lc, Ld), B);
    }, { nu: 32, nv: 32 });
  },
  Boundary(curves: any[]) { return Surface.Patch(curves); },
  /** Fill a closed boundary curve (split into four sides) with a Coons patch, optionally domed. */
  Fill(boundary: any, o: { dome?: number } = {}) {
    const B = curvePoints(boundary, 129);
    const q = (a: number, b: number) => B.slice(Math.round(a * 128), Math.round(b * 128) + 1);
    const patch = Surface.Patch([q(0, 0.25), q(0.25, 0.5), q(0.5, 0.75).reverse(), q(0.75, 1).reverse()]);
    if (!o.dome) return patch;
    return new SurfaceSheet((u, v) => v3.add(patch.f(u, v), v3.scale(patch.normal(0.5, 0.5), o.dome! * 16 * u * (1 - u) * v * (1 - v))), { nu: 32, nv: 32 });
  },
  /** Surface through a network: u-curves skinned and blended with the v-curves (Gordon-style). */
  Net(uCurves: any[], vCurves: any[] = []) {
    const loft = Surface.Loft(uCurves);
    if (vCurves.length < 2) return loft;
    const loftV = Surface.Loft(vCurves).swapUV();
    return new SurfaceSheet((u, v) => v3.lerp(loft.f(u, v), loftV.f(u, v), 0.5), { nu: 48, nv: 48 });
  },
  BoundaryNet(curves: any[]) { return Surface.Patch(curves); },
  Sew(sheets: any[], o: { name?: string } = {}) { return new SurfaceBody(sheets.flat().flatMap((s: any) => (s instanceof SurfaceBody ? s.sheets : [sheetOf(s)])), o.name); },
  Solid(body: any) { const b = body instanceof SurfaceBody ? body : Surface.Sew(Array.isArray(body) ? body : [body]); if (!b.isClosed(1e-2)) throw new ForgeError('SURFACE.OPEN', `surface body has ${b.openEdges(1e-2).length} open edge(s); close it before making a solid`); return b.toSolid(); },
  Extend: (s: SurfaceSheet, distance: number, edge: Edge = 'u1') => sheetOf(s).extend(distance, edge),
  Trim: (s: SurfaceSheet, o: { u?: [number, number]; v?: [number, number] }) => sheetOf(s).trim(o),
  Split: (s: SurfaceSheet, dir: 'u' | 'v' = 'u', t = 0.5) => sheetOf(s).split(dir, t),
  /** Move edge `eb` of `b` onto edge `ea` of `a` (G0) and, with continuity 'G1', align the first row's tangent. */
  Match(a: SurfaceSheet, ea: Edge, b: SurfaceSheet, eb: Edge, o: { continuity?: 'G0' | 'G1'; reach?: number } = {}) {
    const g1 = (o.continuity ?? 'G1') === 'G1', reach = o.reach ?? 0.3;
    const B = eb[0] === 'u' ? b : b.swapUV(), flipB = eb.endsWith('1');
    const Bn = flipB ? B.flip() : B; // now the matched edge is u0
    const A = ea[0] === 'u' ? a : a.swapUV();
    const target = (t: number) => (ea.endsWith('1') ? A.f(1, t) : A.f(0, t));
    const tanA = (t: number) => { const d = A.derivU(ea.endsWith('1') ? 1 : 0, t); return ea.endsWith('1') ? d : v3.scale(d, -1); };
    const out = new SurfaceSheet((u, v) => {
      const p = Bn.f(u, v), w = Math.max(0, 1 - u / reach), w2 = w * w * (3 - 2 * w);
      const d0 = v3.sub(target(v), Bn.f(0, v));
      let q = v3.add(p, v3.scale(d0, w2));
      if (g1 && u < reach) {
        const tb = Bn.derivU(0, v), ta = v3.scale(v3.norm(tanA(v)), v3.len(tb));
        q = v3.add(q, v3.scale(v3.sub(ta, tb), u * w * w));
      }
      return q;
    }, B.opts);
    const back = flipB ? out.flip() : out;
    return eb[0] === 'u' ? back : back.swapUV();
  },
  Complex: (...sheets: any[]) => Surface.Sew(sheets.flat()),
};

// rotation-minimising frames along a polyline
function rmf(P: Vec3[], up?: Vec3) {
  const T = P.map((_, i) => v3.norm(v3.sub(P[Math.min(P.length - 1, i + 1)], P[Math.max(0, i - 1)])));
  let x = up ? v3.norm(v3.sub(toVec3(up), v3.scale(T[0], v3.dot(toVec3(up), T[0])))) : v3.perp(T[0]);
  const X: Vec3[] = [x];
  for (let i = 1; i < P.length; i++) { const t = T[i]; x = v3.norm(v3.sub(x, v3.scale(t, v3.dot(x, t)))); X.push(x); }
  return { T, X };
}
function frameAt(fr: { T: Vec3[]; X: Vec3[] }, P: Vec3[], t: number) {
  const s = Math.max(0, Math.min(1, t)) * (P.length - 1), i = Math.min(P.length - 2, Math.floor(s)), f = s - i;
  const o = v3.lerp(P[i], P[i + 1], f), z = v3.norm(v3.lerp(fr.T[i], fr.T[i + 1], f));
  const x = v3.norm(v3.sub(v3.lerp(fr.X[i], fr.X[i + 1], f), v3.scale(z, v3.dot(v3.lerp(fr.X[i], fr.X[i + 1], f), z))));
  return { o, x, y: v3.cross(z, x), z };
}
/** Catmull-Rom through points at parameter t in [0,1]. */
function crAt(pts: Vec3[], t: number): Vec3 {
  const n = pts.length; if (n === 2) return v3.lerp(pts[0], pts[1], t);
  const s = Math.max(0, Math.min(1, t)) * (n - 1), i = Math.min(n - 2, Math.floor(s)), f = s - i;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
  const f2 = f * f, f3 = f2 * f;
  return [0, 1, 2].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * f + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * f2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * f3)) as Vec3;
}

// ---------------------------------------------------------------- blends
function edgeTangent(s: SurfaceSheet, e: Edge, t: number): Vec3 {
  // outward cross-boundary tangent
  if (e === 'u1') return s.derivU(1, t); if (e === 'u0') return v3.scale(s.derivU(0, t), -1);
  if (e === 'v1') return s.derivV(t, 1); return v3.scale(s.derivV(t, 0), -1);
}
const edgePt = (s: SurfaceSheet, e: Edge, t: number) => (e === 'u0' ? s.f(0, t) : e === 'u1' ? s.f(1, t) : e === 'v0' ? s.f(t, 0) : s.f(t, 1));
function nearestEdges(a: SurfaceSheet, b: SurfaceSheet): [Edge, Edge, boolean] {
  let best: [Edge, Edge, boolean] = ['u1', 'u0', false], bd = Infinity;
  for (const ea of ['u0', 'u1', 'v0', 'v1'] as Edge[]) for (const eb of ['u0', 'u1', 'v0', 'v1'] as Edge[]) for (const rev of [false, true]) {
    let d = 0; for (let i = 0; i <= 4; i++) d += v3.dist(edgePt(a, ea, i / 4), edgePt(b, eb, rev ? 1 - i / 4 : i / 4));
    if (d < bd) { bd = d; best = [ea, eb, rev]; }
  }
  return best;
}
export const Blend = {
  /** Cubic Hermite bridge from edge `ea` of `a` to edge `eb` of `b` (G1 to both). */
  Bridge(a: SurfaceSheet, ea: Edge | undefined, b: SurfaceSheet, eb: Edge | undefined, o: { tension?: number; reversed?: boolean } = {}) {
    let rev = !!o.reversed;
    if (!ea || !eb) { const n = nearestEdges(a, b); ea = ea ?? n[0]; eb = eb ?? n[1]; rev = n[2]; }
    const k = o.tension ?? 1;
    return new SurfaceSheet((u, v) => {
      const tb = rev ? 1 - u : u;
      const p0 = edgePt(a, ea!, u), p1 = edgePt(b, eb!, tb);
      const L = v3.dist(p0, p1);
      const m0 = v3.scale(v3.norm(edgeTangent(a, ea!, u)), L * k), m1 = v3.scale(v3.norm(edgeTangent(b, eb!, tb)), -L * k);
      const h00 = 2 * v ** 3 - 3 * v * v + 1, h10 = v ** 3 - 2 * v * v + v, h01 = -2 * v ** 3 + 3 * v * v, h11 = v ** 3 - v * v;
      return v3.add(v3.add(v3.scale(p0, h00), v3.scale(m0, h10)), v3.add(v3.scale(p1, h01), v3.scale(m1, h11)));
    }, { nu: 32, nv: 16 });
  },
  /** Blend between the nearest edges of two faces. */
  Face(a: SurfaceSheet, b: SurfaceSheet, o: { tension?: number } = {}) { return Blend.Bridge(a, undefined, b, undefined, o); },
  /** Semicircular-ish round joining two edges (e.g. the two skins of a wall). */
  FullRound(a: SurfaceSheet, b: SurfaceSheet, o: { edgeA?: Edge; edgeB?: Edge } = {}) { return Blend.Bridge(a, o.edgeA, b, o.edgeB, { tension: Math.PI / 2 }); },
};

// ---------------------------------------------------------------- analysis
function curvatureAt(pts: Vec3[], i: number) {
  const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(pts.length - 1, i + 1)];
  const ab = v3.dist(a, b), bc = v3.dist(b, c), ca = v3.dist(c, a);
  const area = v3.len(v3.cross(v3.sub(b, a), v3.sub(c, a))) / 2;
  return ab * bc * ca > 1e-12 ? (4 * area) / (ab * bc * ca) : 0;
}
export const Analysis = {
  EdgeMatch(a: SurfaceSheet, ea: Edge, b: SurfaceSheet, eb: Edge, o: { samples?: number } = {}) {
    const n = o.samples ?? 32;
    let rev = false; if (v3.dist(edgePt(a, ea, 0), edgePt(b, eb, 0)) > v3.dist(edgePt(a, ea, 0), edgePt(b, eb, 1))) rev = true;
    let maxGap = 0; for (let i = 0; i <= n; i++) maxGap = Math.max(maxGap, v3.dist(edgePt(a, ea, i / n), edgePt(b, eb, rev ? 1 - i / n : i / n)));
    return { maxGap, reversed: rev, matched: maxGap < 1e-3 };
  },
  EdgeContinuity(a: SurfaceSheet, ea: Edge, b: SurfaceSheet, eb: Edge, o: { samples?: number; tolerance?: number; angleTolerance?: number } = {}) {
    const n = o.samples ?? 16, tol = o.tolerance ?? 1e-2, atol = o.angleTolerance ?? 1;
    const m = Analysis.EdgeMatch(a, ea, b, eb, { samples: n });
    let maxAngle = 0, maxCurv = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n, tb = m.reversed ? 1 - t : t;
      const ta = v3.norm(edgeTangent(a, ea, t)), tbv = v3.scale(v3.norm(edgeTangent(b, eb, tb)), -1);
      maxAngle = Math.max(maxAngle, (Math.acos(Math.max(-1, Math.min(1, v3.dot(ta, tbv)))) * 180) / Math.PI);
      const h = 0.02;
      const ra = [edgePt(a, ea, t), v3.sub(edgePt(a, ea, t), v3.scale(edgeTangent(a, ea, t), h)), v3.sub(edgePt(a, ea, t), v3.scale(edgeTangent(a, ea, t), 2 * h))];
      const rb = [edgePt(b, eb, tb), v3.sub(edgePt(b, eb, tb), v3.scale(edgeTangent(b, eb, tb), h)), v3.sub(edgePt(b, eb, tb), v3.scale(edgeTangent(b, eb, tb), 2 * h))];
      maxCurv = Math.max(maxCurv, Math.abs(curvatureAt([ra[2], ra[1], ra[0]], 1) - curvatureAt([rb[2], rb[1], rb[0]], 1)));
    }
    const level = m.maxGap > tol ? 'none' : maxAngle > atol ? 'G0' : maxCurv > 0.05 ? 'G1' : 'G2';
    return { level, maxGap: m.maxGap, maxAngleDeg: maxAngle, maxCurvatureJump: maxCurv };
  },
  /** Curvature along a curve (or a sheet edge): values plus comb lines scaled for display. */
  CurvatureComb(curve: any, o: { samples?: number; scale?: number; edge?: Edge } = {}) {
    const pts = curve instanceof SurfaceSheet ? curve.edge(o.edge ?? 'v0', o.samples ?? 64) : curvePoints(curve, o.samples ?? 64);
    const k = pts.map((_, i) => curvatureAt(pts, i));
    const maxK = Math.max(...k, 1e-9), sc = o.scale ?? (0.2 * resampleLen(pts)) / maxK;
    const comb = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)];
      const nrm = v3.sub(v3.lerp(a, c, 0.5), p);
      const dir = v3.len(nrm) > 1e-12 ? v3.norm(nrm) : [0, 0, 0] as Vec3;
      return [p, v3.add(p, v3.scale(dir, -k[i] * sc))] as [Vec3, Vec3];
    });
    return { points: pts, curvature: k, maxCurvature: Math.max(...k), minRadius: 1 / Math.max(...k, 1e-12), comb };
  },
  SurfaceHealth(s: SurfaceSheet, o: { n?: number } = {}) {
    const n = o.n ?? 24, g = s.grid(n, n);
    let minEdge = Infinity, degenerate = 0, flipped = 0;
    const n0 = s.normal(0.5, 0.5);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const a = g[i][j], b = g[i + 1][j], c = g[i][j + 1];
      minEdge = Math.min(minEdge, v3.dist(a, b), v3.dist(a, c));
      const cr = v3.cross(v3.sub(b, a), v3.sub(c, a));
      if (v3.len(cr) < 1e-10) degenerate++;
      else if (v3.dot(v3.norm(cr), n0) < -0.5 && !s.opts.closedU && !s.opts.closedV) flipped++;
    }
    return { ok: flipped === 0, area: s.area(), minEdge, degenerateCells: degenerate, foldedCells: flipped, closedU: !!s.opts.closedU, closedV: !!s.opts.closedV };
  },
  BRepValidity(shape: Shape) {
    const st = shape.m.status?.() ?? 0;
    const bodies = shape.m.decompose().length;
    return { valid: !shape.isEmpty() && (String(st) === '0' || String(st) === 'NoError'), status: String(st), bodies, genus: shape.genus(), volume: shape.volume(), triangles: shape.numTri(), closed: shape.volume() > 0 };
  },
};
function resampleLen(p: Vec3[]) { let L = 0; for (let i = 1; i < p.length; i++) L += v3.dist(p[i - 1], p[i]); return L; }

// ---------------------------------------------------------------- variable thickness
export const Thickness = {
  alongU: (s: SurfaceSheet, t: number[] | ((u: number) => number), o: { side?: 'out' | 'in' | 'both' } = {}) => thickenVar(s, (u) => (typeof t === 'function' ? t(u) : at(t.map((x) => [x, 0, 0] as Vec3), u)[0]), o),
  alongV: (s: SurfaceSheet, t: number[] | ((v: number) => number), o: { side?: 'out' | 'in' | 'both' } = {}) => thickenVar(s, (_u, v) => (typeof t === 'function' ? t(v) : at(t.map((x) => [x, 0, 0] as Vec3), v)[0]), o),
  grid: (s: SurfaceSheet, t: number[][] | ((u: number, v: number) => number), o: { side?: 'out' | 'in' | 'both' } = {}) => thickenVar(s, (u, v) => {
    if (typeof t === 'function') return t(u, v);
    const row = at(t.map((r) => [0, 0, 0] as Vec3).map((_, i) => [i, 0, 0] as Vec3), u)[0];
    const i = Math.min(t.length - 2, Math.floor(row)), fi = row - i;
    const val = (r: number[]) => at(r.map((x) => [x, 0, 0] as Vec3), v)[0];
    return t.length === 1 ? val(t[0]) : val(t[i]) * (1 - fi) + val(t[i + 1]) * fi;
  }, o),
};

// ---------------------------------------------------------------- sculpting
export class ControlCage {
  readonly kind = 'controlCage';
  constructor(readonly divisions: [number, number, number], readonly min: Vec3, readonly max: Vec3, readonly points: Vec3[]) {}
  index(i: number, j: number, k: number) { const [, ny, nz] = this.divisions; return (i * (ny + 1) + j) * (nz + 1) + k; }
  point(i: number, j: number, k: number) { return this.points[this.index(i, j, k)]; }
  /** Move one control point (or a set selected by a predicate) by `delta`. */
  move(sel: [number, number, number] | ((i: number, j: number, k: number, p: Vec3) => boolean), delta: Vec3) {
    const pts = this.points.slice(); const [nx, ny, nz] = this.divisions;
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) {
      const hit = Array.isArray(sel) ? sel[0] === i && sel[1] === j && sel[2] === k : sel(i, j, k, pts[this.index(i, j, k)]);
      if (hit) pts[this.index(i, j, k)] = v3.add(pts[this.index(i, j, k)], toVec3(delta));
    }
    return new ControlCage(this.divisions, this.min, this.max, pts);
  }
  scaleLayer(axis: 'x' | 'y' | 'z', layer: number, s: number | [number, number]) {
    const c = v3.lerp(this.min, this.max, 0.5), [sx, sy] = typeof s === 'number' ? [s, s] : s;
    const ax = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    return this.move((i, j, k) => [i, j, k][ax] === layer, [0, 0, 0]).mapLayer(ax, layer, (p) => { const q = p.slice() as Vec3; const o = [0, 1, 2].filter((x) => x !== ax); q[o[0]] = c[o[0]] + (p[o[0]] - c[o[0]]) * sx; q[o[1]] = c[o[1]] + (p[o[1]] - c[o[1]]) * sy; return q; });
  }
  private mapLayer(ax: number, layer: number, fn: (p: Vec3) => Vec3) {
    const pts = this.points.slice(); const [nx, ny, nz] = this.divisions;
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) if ([i, j, k][ax] === layer) pts[this.index(i, j, k)] = fn(pts[this.index(i, j, k)]);
    return new ControlCage(this.divisions, this.min, this.max, pts);
  }
  /** Bernstein free-form deformation of a point given in the cage's rest box. */
  deform(p: Vec3): Vec3 {
    const [nx, ny, nz] = this.divisions;
    const s = (p[0] - this.min[0]) / (this.max[0] - this.min[0] || 1), t = (p[1] - this.min[1]) / (this.max[1] - this.min[1] || 1), w = (p[2] - this.min[2]) / (this.max[2] - this.min[2] || 1);
    const B = (n: number, i: number, x: number) => binom(n, i) * x ** i * (1 - x) ** (n - i);
    const out: Vec3 = [0, 0, 0];
    for (let i = 0; i <= nx; i++) { const bi = B(nx, i, s); for (let j = 0; j <= ny; j++) { const bj = bi * B(ny, j, t); for (let k = 0; k <= nz; k++) { const b = bj * B(nz, k, w), q = this.points[this.index(i, j, k)]; out[0] += b * q[0]; out[1] += b * q[1]; out[2] += b * q[2]; } } }
    return out;
  }
  /** Apply the cage to any solid inside its rest box. */
  apply(shape: Shape, o: { refine?: number } = {}) { return shape.refine(o.refine ?? 4).warp((v: number[]) => { const q = this.deform([v[0], v[1], v[2]]); v[0] = q[0]; v[1] = q[1]; v[2] = q[2]; }); }
}
function binom(n: number, k: number) { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; }

export const Sculpt = {
  ControlCage,
  /** A cage of (nx, ny, nz) divisions around a box of `size`, centred in XY and sitting on z = 0. */
  controlBox(o: { size: Vec3 | number; divisions?: Vec3 | number }) {
    const sz = typeof o.size === 'number' ? [o.size, o.size, o.size] : toVec3(o.size);
    const d = typeof o.divisions === 'number' ? [o.divisions, o.divisions, o.divisions] : (o.divisions ?? [3, 3, 3]);
    const min: Vec3 = [-sz[0] / 2, -sz[1] / 2, 0], max: Vec3 = [sz[0] / 2, sz[1] / 2, sz[2]];
    const pts: Vec3[] = [];
    for (let i = 0; i <= d[0]; i++) for (let j = 0; j <= d[1]; j++) for (let k = 0; k <= d[2]; k++) pts.push([min[0] + (sz[0] * i) / d[0], min[1] + (sz[1] * j) / d[1], min[2] + (sz[2] * k) / d[2]]);
    return new ControlCage([d[0], d[1], d[2]] as [number, number, number], min, max, pts);
  },
  /** Smooth solid from a cage: a rounded block filling the rest box, deformed by the cage. */
  surfaceFromControlCage(cage: ControlCage, o: { roundness?: number; refine?: number } = {}) {
    const sz = v3.sub(cage.max, cage.min), r = (o.roundness ?? 0.25) * Math.min(...sz) / 2;
    let base = box(sz[0], sz[1], sz[2]).translate(...(v3.lerp(cage.min, cage.max, 0.5).map((v, i) => (i === 2 ? cage.min[2] : v)) as Vec3));
    if (r > 0) base = base.refine(2).smoothOut(30).refine(1);
    return cage.apply(base, { refine: o.refine ?? 3 });
  },
};

// ---------------------------------------------------------------- product skins
interface Station { z: number; width: number; depth: number; roundness: number; offset: Vec2; points: Vec2[] }
function superEllipse(w: number, d: number, n: number, k = 96): Vec2[] {
  return Array.from({ length: k }, (_, i) => { const a = (i / k) * TAU, c = Math.cos(a), s = Math.sin(a); return [(w / 2) * Math.sign(c) * Math.abs(c) ** (2 / n), (d / 2) * Math.sign(s) * Math.abs(s) ** (2 / n)] as Vec2; });
}
class ProductSkin {
  readonly kind = 'productSkin';
  constructor(readonly stations: Station[], readonly name?: string) {}
  rings(k = 96): Vec3[][] { return this.stations.map((s) => s.points.map((p) => [p[0] + s.offset[0], p[1] + s.offset[1], s.z] as Vec3)).map((r) => resampleLoop(r, k)); }
  surface(): SurfaceSheet { const R = this.rings(); return new SurfaceSheet((u, v) => crAt(R.map((r) => atLoop(r, u)), v), { nu: 96, nv: Math.max(8, (R.length - 1) * 12), closedU: true }); }
  toShape(o: { smooth?: number } = {}): Shape {
    // Interpolate extra rings between stations for a smooth skin, then cap the ends.
    const R = this.rings(), steps = o.smooth ?? 8, rings: Vec3[][] = [];
    for (let i = 0; i < (R.length - 1) * steps + 1; i++) { const v = i / ((R.length - 1) * steps); rings.push(R[0].map((_, j) => crAt(R.map((r) => r[j]), v))); }
    const cap = (r: Vec3[]) => r.map((p) => [p[0], p[1]] as Vec2);
    return solidFromRings(rings, { first: cap(rings[0]), last: cap(rings[rings.length - 1]) }).withMeta({ productSkin: { stations: this.stations.length } });
  }
  /** Station frame at height z (interpolated). */
  at(z: number) { const S = this.stations; const i = Math.max(0, S.findIndex((s, k) => k < S.length - 1 && z <= S[k + 1].z)); const a = S[i], b = S[Math.min(S.length - 1, i + 1)], t = b.z === a.z ? 0 : (z - a.z) / (b.z - a.z); return { width: a.width + (b.width - a.width) * t, depth: a.depth + (b.depth - a.depth) * t }; }
}
function resampleLoop(r: Vec3[], k: number) { return resample([...r, r[0]], k + 1).slice(0, k); }
function atLoop(r: Vec3[], u: number) { const x = (((u % 1) + 1) % 1) * r.length, i = Math.floor(x) % r.length; return v3.lerp(r[i], r[(i + 1) % r.length], x - Math.floor(x)); }

const MATERIALS: Record<string, { color: string; metalness: number; roughness: number }> = {
  anodizedAluminum: { color: '#b9bec4', metalness: 0.85, roughness: 0.35 }, satinPlastic: { color: '#e8e8e6', metalness: 0, roughness: 0.55 },
  glossPlastic: { color: '#202124', metalness: 0, roughness: 0.15 }, rubber: { color: '#2b2b2b', metalness: 0, roughness: 0.9 },
  glass: { color: '#cfe3ee', metalness: 0, roughness: 0.05 }, brushedSteel: { color: '#a7abb0', metalness: 0.9, roughness: 0.45 }, wood: { color: '#b58a5b', metalness: 0, roughness: 0.7 },
};

export const Product = {
  /** A cross-section at height z: { z, width, depth, roundness (2 = ellipse, large = boxy), offset }. */
  station(z: number, o: { width: number; depth?: number; roundness?: number; offset?: Vec2; profile?: Sketch | Vec2[] }) {
    const d = o.depth ?? o.width, n = o.roundness ?? 2.5;
    const pts = o.profile ? (o.profile instanceof Sketch ? o.profile.toPolygons()[0] : o.profile) : superEllipse(o.width, d, n);
    return { z, width: o.width, depth: d, roundness: n, offset: o.offset ?? [0, 0], points: pts } as Station;
  },
  /** A guide rail through points (a smooth curve). */
  rail(points: Vec3[]) { const P = points.map((p) => toVec3(p)); return new Curve3D((t) => crAt(P, t)); },
  /** Stations sampled from width/depth rails along z: profiles({ z: [..], width: rail|fn, depth: rail|fn }). */
  profiles(o: { z: number[]; width: number[] | ((z: number) => number); depth?: number[] | ((z: number) => number); roundness?: number }) {
    const val = (r: any, i: number, z: number) => (typeof r === 'function' ? r(z) : r[i]);
    return o.z.map((z, i) => Product.station(z, { width: val(o.width, i, z), depth: o.depth ? val(o.depth, i, z) : undefined, roundness: o.roundness }));
  },
  scaleProfileTo(profile: Sketch | Vec2[], width: number, depth: number): Vec2[] {
    const pts = profile instanceof Sketch ? profile.toPolygons()[0] : profile;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2, sx = width / (Math.max(...xs) - Math.min(...xs) || 1), sy = depth / (Math.max(...ys) - Math.min(...ys) || 1);
    return pts.map((p) => [(p[0] - cx) * sx, (p[1] - cy) * sy]);
  },
  /** Skin through stations: returns a ProductSkin (toShape(), surface(), at(z)). */
  skin(stations: Station[], o: { name?: string } = {}) {
    if (stations.length < 2) throw new ForgeError('PRODUCT.SKIN', 'a skin needs at least two stations');
    return new ProductSkin([...stations].sort((a, b) => a.z - b.z), o.name);
  },
  /** A named reference point (kept on the context for dimensions and placement). */
  ref(name: string, point: Vec3) { const p = toVec3(point); const c = ctx() as any; (c.productRefs ??= {})[name] = p; return { name, point: p }; },
  surface: (skin: ProductSkin) => skin.surface(),
  /** A panel cut from the skin between u and v ranges, thickened inward. */
  panel(skin: ProductSkin, o: { u: [number, number]; v: [number, number]; thickness?: number; inset?: number }) {
    const s = skin.surface().trim({ u: o.u, v: o.v });
    return (o.inset ? s.offset(-o.inset) : s).thicken(o.thickness ?? 1.5, { side: 'in' });
  },
  /** A band around the skin at height fraction v. */
  ribbon(skin: ProductSkin, o: { v: number; width: number; thickness?: number }) {
    const H = skin.stations[skin.stations.length - 1].z - skin.stations[0].z || 1, dv = o.width / H / 2;
    return skin.surface().trim({ v: [Math.max(0, o.v - dv), Math.min(1, o.v + dv)] }).thicken(o.thickness ?? 1, { side: 'out' });
  },
  materials: MATERIALS,
};

// ---------------------------------------------------------------- carriers and surface members
class Carrier {
  readonly kind = 'carrier';
  constructor(readonly sheet: SurfaceSheet) {}
  frameAt(u: number, v: number) {
    const o = this.sheet.f(u, v), n = this.sheet.normal(u, v), x = v3.norm(this.sheet.derivU(u, v));
    return { origin: o, normal: n, x, y: v3.cross(n, x), matrix: mat4.fromFrame(x, v3.cross(n, x), n, o) };
  }
  /** Place a shape (built at the origin, Z up) on the surface at (u, v). */
  place(shape: Shape, u: number, v: number, o: { offset?: number } = {}) { const f = this.frameAt(u, v); return shape.translate(0, 0, o.offset ?? 0).transform(f.matrix); }
}
export const CarrierNS = {
  cylinder: (o: { radius: number; height: number }) => new Carrier(Surface.Cylinder(o)),
  plane: (o: { width?: number; height?: number; origin?: Vec3; normal?: Vec3 } = {}) => new Carrier(Surface.Plane(o)),
  productSkin: (skin: ProductSkin) => new Carrier(skin.surface()),
  fromSurface: (s: SurfaceSheet) => new Carrier(s),
};
export const SurfaceMembers = {
  /** Cutter for a rounded slot normal to the carrier at (u, v). Subtract it from the part. */
  roundedSlot(c: Carrier, o: { u: number; v: number; length: number; width: number; depth: number; angle?: number }) {
    const w = o.width, L = Math.max(o.length, w);
    const pts: Vec2[] = [];
    for (let i = 0; i <= 16; i++) { const a = -Math.PI / 2 + (Math.PI * i) / 16; pts.push([(L - w) / 2 + (w / 2) * Math.cos(a), (w / 2) * Math.sin(a)]); }
    for (let i = 0; i <= 16; i++) { const a = Math.PI / 2 + (Math.PI * i) / 16; pts.push([-(L - w) / 2 + (w / 2) * Math.cos(a), (w / 2) * Math.sin(a)]); }
    const cut = polygon(pts).rotate(o.angle ?? 0).extrude(o.depth + 2).translate(0, 0, -o.depth);
    return c.place(cut, o.u, o.v, { offset: 0 });
  },
  /** Cutter for a counterbored hole normal to the carrier at (u, v). */
  counterbore(c: Carrier, o: { u: number; v: number; diameter: number; depth: number; cbDiameter: number; cbDepth: number }) {
    const k = K();
    const hole = new Shape(k.Manifold.cylinder(o.depth + 2, o.diameter / 2, o.diameter / 2, 48)).translate(0, 0, -o.depth);
    const cb = new Shape(k.Manifold.cylinder(o.cbDepth + 2, o.cbDiameter / 2, o.cbDiameter / 2, 48)).translate(0, 0, -o.cbDepth);
    return c.place(hole.add(cb), o.u, o.v);
  },
  /** Ribs standing on the inside of the carrier, spaced along u at a fixed v range. */
  ribs(c: Carrier, o: { count: number; height: number; thickness: number; v?: [number, number]; u?: [number, number] }) {
    const [v0, v1] = o.v ?? [0.1, 0.9], [u0, u1] = o.u ?? [0, 1];
    const ribs: Shape[] = [];
    for (let i = 0; i < o.count; i++) {
      const u = u0 + ((u1 - u0) * (i + 0.5)) / o.count;
      const strip = c.sheet.trim({ u: [u - 0.0001, u + 0.0001], v: [v0, v1] });
      const path = strip.edge('u0', 24);
      const n = c.sheet.normal(u, (v0 + v1) / 2), x = v3.norm(c.sheet.derivU(u, (v0 + v1) / 2));
      const rings = path.map((p) => [v3.sub(p, v3.scale(x, o.thickness / 2)), v3.add(p, v3.scale(x, o.thickness / 2)), v3.add(v3.add(p, v3.scale(x, o.thickness / 2)), v3.scale(n, -o.height)), v3.add(v3.sub(p, v3.scale(x, o.thickness / 2)), v3.scale(n, -o.height))]);
      const verts: number[] = [], tris: number[] = [];
      rings.forEach((r) => r.forEach((p) => verts.push(...p)));
      for (let a = 0; a < rings.length - 1; a++) for (let j = 0; j < 4; j++) { const p = a * 4 + j, q = a * 4 + ((j + 1) % 4), r2 = (a + 1) * 4 + ((j + 1) % 4), s = (a + 1) * 4 + j; tris.push(p, q, r2, p, r2, s); }
      const last = (rings.length - 1) * 4; tris.push(0, 2, 1, 0, 3, 2, last, last + 1, last + 2, last, last + 2, last + 3);
      ribs.push(meshSolid(verts, tris));
    }
    return union(ribs);
  },
};

export { ProductSkin, Carrier };

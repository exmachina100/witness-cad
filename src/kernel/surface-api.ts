// ForgeCAD-shaped surface API on top of the sheet kernel in surfacing.ts:
// Sheet edges/frames/paths, NurbsSurface views, curve-net and surface-complex builders,
// edge matching, product skins built from stations, carriers with surface coordinates,
// and SurfaceBody members (bands and plates with joins, features and diagnostics).
import { ForgeError } from './errors';
import { K } from './wasm';
import { mat4, Mat4, toVec3, v3, Vec2, Vec3 } from './math';
import { Shape } from './shape';
import { group, union, cylinder } from './ops';
import { Sketch, polygon, roundedRect as rr2d, circle2d } from './sketch';
import { Curve3D, polylineCurve, solidFromRings, loft } from './curves';
import { evalSurface, domainU, domainV, NurbsSurface as NS } from './nurbs';
import {
  SurfaceSheet, SurfaceBody as SheetBody, Surface as BaseSurface, Blend as BaseBlend, Analysis as BaseAnalysis, Thickness as BaseThickness,
  Product as BaseProduct, CarrierNS as BaseCarrier, SurfaceMembers as BaseMembers, Sculpt as BaseSculpt, ControlCage, ProductSkin as OldSkin,
  Edge, curvePoints, at, crAt, rmf, frameAt as rmfFrameAt, edgePt, edgeTangent, thickenVar, resampleLoop, atLoop,
} from './surfacing';

const TAU = Math.PI * 2;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// ================================================================ sheet edges
export interface SheetEdge { kind: 'sheetEdge'; fixed: 'u' | 'v'; value: 0 | 1; sheet: SurfaceSheet; name: string }
const EDGE_NAMES: Record<string, Edge> = { front: 'v0', rear: 'v1', back: 'v1', left: 'u0', right: 'u1', bottom: 'v0', top: 'v1', u0: 'u0', u1: 'u1', v0: 'v0', v1: 'v1' };
const edgeName = (e: Edge) => ({ v0: 'front', v1: 'rear', u0: 'left', u1: 'right' })[e];
export function sheetEdge(sheet: SurfaceSheet, e: Edge): SheetEdge { return { kind: 'sheetEdge', fixed: e[0] as 'u' | 'v', value: (e[1] === '1' ? 1 : 0) as 0 | 1, sheet, name: edgeName(e) }; }
export const isSheetEdge = (x: any): x is SheetEdge => x?.kind === 'sheetEdge';
function edgeCode(e: SheetEdge | string): Edge {
  if (typeof e === 'string') { const k = EDGE_NAMES[e]; if (!k) throw new ForgeError('SURFACE.EDGE', `unknown sheet edge "${e}" (front, rear, left, right)`); return k; }
  return `${e.fixed}${e.value}` as Edge;
}
const SH = SurfaceSheet.prototype as any;
const edgeCurve = (s: SurfaceSheet, e: Edge) => new Curve3D((t) => edgePt(s, e, t), false, 64);
for (const [prop, e] of [['frontEdge', 'v0'], ['rearEdge', 'v1'], ['leftEdge', 'u0'], ['rightEdge', 'u1']] as const) Object.defineProperty(SH, prop, { configurable: true, get(this: SurfaceSheet) { return sheetEdge(this, e); } });
for (const [prop, e] of [['frontCurve', 'v0'], ['rearCurve', 'v1'], ['leftCurve', 'u0'], ['rightCurve', 'u1']] as const) Object.defineProperty(SH, prop, { configurable: true, get(this: SurfaceSheet) { return edgeCurve(this, e); } });
Object.defineProperty(SH, 'surface', { configurable: true, get(this: SurfaceSheet) { return new NurbsSurfaceView(this.toNurbs(16)); } });

export interface SurfaceFrameOut { point: Vec3; origin: Vec3; normal: Vec3; tangentU: Vec3; tangentV: Vec3; xAxis: Vec3; yAxis: Vec3; matrix: Mat4 }
function frameOf(s: SurfaceSheet, u: number, v: number, o: { normalOffset?: number } = {}): SurfaceFrameOut {
  const n = s.normal(u, v), tu = v3.norm(s.derivU(u, v)), tv = v3.norm(v3.cross(n, tu));
  const p = v3.add(s.f(u, v), v3.scale(n, o.normalOffset ?? 0));
  return { point: p, origin: p, normal: n, tangentU: tu, tangentV: tv, xAxis: tu, yAxis: tv, matrix: mat4.fromFrame(tu, tv, n, p) };
}
function pathPoints(s: SurfaceSheet, f: (t: number) => [number, number], o: { samples?: number; start?: number; end?: number; reverse?: boolean; normalOffset?: number } = {}): Vec3[] {
  const n = o.samples ?? 48, a = o.start ?? 0, b = o.end ?? 1, pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) { const t = a + ((b - a) * i) / n, [u, v] = f(t); pts.push(v3.add(s.f(u, v), v3.scale(s.normal(u, v), o.normalOffset ?? 0))); }
  return o.reverse ? pts.reverse() : pts;
}
const edgeUV = (e: Edge) => (t: number): [number, number] => (e === 'u0' ? [0, t] : e === 'u1' ? [1, t] : e === 'v0' ? [t, 0] : [t, 1]);
function curvature(s: SurfaceSheet, u: number, v: number) {
  const h = 1e-3, P = (a: number, b: number) => s.f(clamp01(a), clamp01(b));
  const Su = v3.scale(v3.sub(P(u + h, v), P(u - h, v)), 1 / (2 * h)), Sv = v3.scale(v3.sub(P(u, v + h), P(u, v - h)), 1 / (2 * h));
  const Suu = v3.scale(v3.add(v3.sub(P(u + h, v), v3.scale(P(u, v), 2)), P(u - h, v)), 1 / (h * h));
  const Svv = v3.scale(v3.add(v3.sub(P(u, v + h), v3.scale(P(u, v), 2)), P(u, v - h)), 1 / (h * h));
  const Suv = v3.scale(v3.add(v3.sub(v3.sub(P(u + h, v + h), P(u + h, v - h)), P(u - h, v + h)), P(u - h, v - h)), 1 / (4 * h * h));
  const N = v3.norm(v3.cross(Su, Sv));
  const E = v3.dot(Su, Su), F = v3.dot(Su, Sv), G = v3.dot(Sv, Sv), L = v3.dot(Suu, N), M = v3.dot(Suv, N), Nn = v3.dot(Svv, N);
  const den = E * G - F * F || 1e-12, K = (L * Nn - M * M) / den, H = (E * Nn - 2 * F * M + G * L) / (2 * den), d = Math.sqrt(Math.max(0, H * H - K));
  return { k1: H + d, k2: H - d, K, H };
}
/** Thickness spec from Thickness.alongU/alongV/grid (ForgeCAD form), applied by sheet.thicken(spec). */
interface ThicknessSpec { kind: 'thicknessSpec'; fn: (u: number, v: number) => number }
const lerpList = (vals: number[], t: number) => { if (vals.length === 1) return vals[0]; const x = clamp01(t) * (vals.length - 1), i = Math.min(vals.length - 2, Math.floor(x)); return vals[i] + (vals[i + 1] - vals[i]) * (x - i); };
const profileVals = (p: any): number[] => (Array.isArray(p) ? p.map((x: any) => (typeof x === 'number' ? x : x.thickness ?? x[1])) : [p]);
const origThicken = SH.thicken;
Object.assign(SH, {
  curveAlong(this: SurfaceSheet, e: SheetEdge | string) { return edgeCurve(this, edgeCode(e)); },
  curveAlongU(this: SurfaceSheet, v: number) { return new Curve3D((t) => this.f(t, clamp01(v)), !!this.opts.closedU, 64); },
  curveAlongV(this: SurfaceSheet, u: number) { return new Curve3D((t) => this.f(clamp01(u), t), !!this.opts.closedV, 64); },
  pathAlong(this: SurfaceSheet, e: SheetEdge | string, o: any = {}) { return polylineCurve(pathPoints(this, edgeUV(edgeCode(e)), o)); },
  pathAlongU(this: SurfaceSheet, v: number, o: any = {}) { return polylineCurve(pathPoints(this, (t) => [t, clamp01(v)], o)); },
  pathAlongV(this: SurfaceSheet, u: number, o: any = {}) { return polylineCurve(pathPoints(this, (t) => [clamp01(u), t], o)); },
  /** Join edge spans into one path: [{ edge, start, end, samples }]. */
  pathAlongBoundary(this: SurfaceSheet, spans: any[], o: { samplesPerEdge?: number; normalOffset?: number; tolerance?: number } = {}) {
    const pts: Vec3[] = [];
    for (const sp of spans) {
      const seg = pathPoints(this, edgeUV(edgeCode(sp.edge ?? sp)), { samples: sp.samples ?? o.samplesPerEdge ?? 24, start: sp.start, end: sp.end, normalOffset: o.normalOffset });
      if (pts.length && v3.dist(pts[pts.length - 1], seg[seg.length - 1]) < v3.dist(pts[pts.length - 1], seg[0])) seg.reverse();
      pts.push(...(pts.length && v3.dist(pts[pts.length - 1], seg[0]) < (o.tolerance ?? 1e-6) ? seg.slice(1) : seg));
    }
    return polylineCurve(pts);
  },
  pointAt(this: SurfaceSheet, u: number, v: number) { return this.f(clamp01(u), clamp01(v)); },
  normalAt(this: SurfaceSheet, u: number, v: number) { return this.normal(clamp01(u), clamp01(v)); },
  frameAt(this: SurfaceSheet, u: number, v: number, o: any = {}) { return frameOf(this, clamp01(u), clamp01(v), o); },
  /** Frame whose normal runs along u (a plane cutting across the sheet), for slices and sections. */
  framePerpendicularToU(this: SurfaceSheet, u: number, v: number, o: any = {}) { const f = frameOf(this, clamp01(u), clamp01(v), o); return { ...f, normal: f.tangentU, xAxis: f.tangentV, yAxis: f.normal, matrix: mat4.fromFrame(f.tangentV, f.normal, f.tangentU, f.point) }; },
  framePerpendicularToV(this: SurfaceSheet, u: number, v: number, o: any = {}) { const f = frameOf(this, clamp01(u), clamp01(v), o); return { ...f, normal: f.tangentV, xAxis: f.normal, yAxis: f.tangentU, matrix: mat4.fromFrame(f.normal, f.tangentU, f.tangentV, f.point) }; },
  curvatureAt(this: SurfaceSheet, u: number, v: number) { return curvature(this, clamp01(u), clamp01(v)); },
  /** thicken(wall | Thickness spec, { side: 'out' | 'in' | 'both' }). */
  thicken(this: SurfaceSheet, wall: number | ThicknessSpec, o: any = {}) { return typeof wall === 'number' ? origThicken.call(this, wall, o) : thickenVar(this, wall.fn, o); },
  thickenInsideBy(this: SurfaceSheet, t: number | ThicknessSpec, o: any = {}) { return SH.thicken.call(this, t, { ...o, side: 'in' }); },
  matchEdge(this: SurfaceSheet, e: SheetEdge | string) { return new MatchEdgeBuilder(this, edgeCode(e)); },
});

export class MatchEdgeBuilder {
  constructor(readonly sheet: SurfaceSheet, readonly edge: Edge) {}
  private to(n: SheetEdge, c: 'G0' | 'G1' | 'G2') { return BaseSurface.Match(n.sheet, edgeCode(n), this.sheet, this.edge, { continuity: c === 'G0' ? 'G0' : 'G1', reach: c === 'G2' ? 0.45 : 0.3 }); }
  toG0(n: SheetEdge) { return this.to(n, 'G0'); }
  toG1(n: SheetEdge) { return this.to(n, 'G1'); }
  toG2(n: SheetEdge) { return this.to(n, 'G2'); }
}

/** A read-only NURBS view (ForgeCAD's NurbsSurface): grids, knots, degrees and evaluation in its own domain. */
export class NurbsSurfaceView {
  constructor(readonly ns: NS) {}
  get nU() { return this.ns.nu; }
  get nV() { return this.ns.nv; }
  get degreeU() { return this.ns.degU; }
  get degreeV() { return this.ns.degV; }
  get knotsU() { return this.ns.knotsU.slice(); }
  get knotsV() { return this.ns.knotsV.slice(); }
  get degrees(): [number, number] { return [this.ns.degU, this.ns.degV]; }
  get knots() { return { u: this.knotsU, v: this.knotsV }; }
  get controlGrid(): Vec3[][] { return Array.from({ length: this.ns.nu }, (_, i) => this.ns.ctrl.slice(i * this.ns.nv, (i + 1) * this.ns.nv)); }
  get weightsGrid(): number[][] { const w = this.ns.weights ?? this.ns.ctrl.map(() => 1); return Array.from({ length: this.ns.nu }, (_, i) => w.slice(i * this.ns.nv, (i + 1) * this.ns.nv)); }
  get domain() { return { u: domainU(this.ns), v: domainV(this.ns) }; }
  pointAt(u: number, v: number) { return evalSurface(this.ns, u, v); }
  derivativesAt(u: number, v: number) {
    const [u0, u1] = domainU(this.ns), [v0, v1] = domainV(this.ns), h = 1e-4 * Math.max(u1 - u0, v1 - v0);
    const P = (a: number, b: number) => evalSurface(this.ns, Math.max(u0, Math.min(u1, a)), Math.max(v0, Math.min(v1, b)));
    return { S: P(u, v), Su: v3.scale(v3.sub(P(u + h, v), P(u - h, v)), 1 / (2 * h)), Sv: v3.scale(v3.sub(P(u, v + h), P(u, v - h)), 1 / (2 * h)) };
  }
  normalAt(u: number, v: number) { const d = this.derivativesAt(u, v); return v3.norm(v3.cross(d.Su, d.Sv)); }
}

// ================================================================ curve nets
export class CurveNetBuilder {
  private L: any[] = []; private C: any[] = []; private res = 48; private grid?: Vec3[][]; private deg: [number, number] = [3, 3];
  private cu = false; private cv = false; private matches: { at: Edge; cond: any }[] = []; private _sheet?: SurfaceSheet;
  constructor(readonly boundary = false) {}
  private dirty() { this._sheet = undefined; return this; }
  lengthwise(...c: any[]) { this.L.push(...c.flat()); return this.dirty(); }
  crosswise(...c: any[]) { this.C.push(...c.flat()); return this.dirty(); }
  alongRails(a: any, b: any) { this.C = [a, b]; return this.dirty(); }
  sections(...c: any[]) { return this.lengthwise(...c); }
  resolution(n: number) { this.res = n; return this.dirty(); }
  cage(grid: Vec3[][]) { this.grid = grid; return this.dirty(); }
  degree(u: number, v = u) { this.deg = [u, v]; return this.dirty(); }
  matchStartU(c: any) { this.matches.push({ at: 'u0', cond: c }); return this.dirty(); }
  matchEndU(c: any) { this.matches.push({ at: 'u1', cond: c }); return this.dirty(); }
  matchStartV(c: any) { this.matches.push({ at: 'v0', cond: c }); return this.dirty(); }
  matchEndV(c: any) { this.matches.push({ at: 'v1', cond: c }); return this.dirty(); }
  closedU() { this.cu = true; return this.dirty(); }
  closedV() { this.cv = true; return this.dirty(); }
  toSheet(): SurfaceSheet {
    if (this._sheet) return this._sheet;
    let s: SurfaceSheet;
    if (this.grid) s = BaseSurface.Nurbs({ control: this.grid, degree: Math.max(...this.deg) });
    else if (this.boundary || (this.L.length === 2 && this.C.length === 2)) {
      if (this.L.length !== 2 || this.C.length !== 2) throw new ForgeError('SURFACE.NET', 'a boundary net needs two lengthwise and two crosswise curves');
      s = BaseSurface.Patch([this.L[0], this.C[1], this.L[1], this.C[0]]);
    } else if (this.L.length >= 2 && this.C.length >= 2) s = gordon(this.L, this.C, this.res);
    else if (this.L.length >= 2) s = BaseSurface.Loft(this.L, { n: this.res, closed: this.cv });
    else if (this.C.length >= 2) s = BaseSurface.Loft(this.C, { n: this.res }).swapUV();
    else throw new ForgeError('SURFACE.NET', 'a curve net needs at least two lengthwise or crosswise curves (or a cage)');
    if (this.cu || this.cv) s = new SurfaceSheet(s.f, { ...s.opts, closedU: s.opts.closedU || this.cu, closedV: s.opts.closedV || this.cv });
    for (const m of this.matches) {
      const tgt = m.cond?.edge ?? m.cond; if (!isSheetEdge(tgt)) continue;
      s = BaseSurface.Match(tgt.sheet, edgeCode(tgt), s, m.at, { continuity: (m.cond.continuity ?? 'G1') === 'G0' ? 'G0' : 'G1' });
    }
    return (this._sheet = s);
  }
}
/** Gordon surface: loft of lengthwise curves + loft of crosswise curves - tensor interpolation of their crossings. */
function gordon(Lc: any[], Cc: any[], n: number): SurfaceSheet {
  const L = Lc.map((c) => curvePoints(c, n)), C = Cc.map((c) => curvePoints(c, n));
  const grid = L.map((l) => C.map((_, j) => at(l, j / (C.length - 1))));
  return new SurfaceSheet((u, v) => {
    const a = crAt(L.map((l) => at(l, u)), v), b = crAt(C.map((c) => at(c, v)), u), t = crAt(grid.map((row) => crAt(row, u)), v);
    return v3.sub(v3.add(a, b), t);
  }, { nu: n, nv: n });
}
// Sheet-like reads on a builder go through toSheet().
for (const k of ['frontEdge', 'rearEdge', 'leftEdge', 'rightEdge', 'frontCurve', 'rearCurve', 'leftCurve', 'rightCurve', 'surface'])
  Object.defineProperty(CurveNetBuilder.prototype, k, { configurable: true, get(this: CurveNetBuilder) { return (this.toSheet() as any)[k]; } });
for (const k of ['pointAt', 'normalAt', 'curvatureAt', 'frameAt', 'framePerpendicularToU', 'framePerpendicularToV', 'curveAlong', 'curveAlongU', 'curveAlongV', 'pathAlong', 'pathAlongBoundary', 'pathAlongU', 'pathAlongV', 'thicken', 'thickenInsideBy', 'matchEdge', 'toShape', 'thicken'])
  (CurveNetBuilder.prototype as any)[k] = function (this: CurveNetBuilder, ...a: any[]) { const s: any = this.toSheet(); return s[k](...a); };

const toSheet = (x: any): SurfaceSheet => (x instanceof SurfaceSheet ? x : x instanceof CurveNetBuilder ? x.toSheet() : (() => { throw new ForgeError('SURFACE.NOT_SHEET', 'expected a surface sheet'); })());

// ================================================================ surface complexes
export class SurfaceComplexBuilder {
  private patches = new Map<string, SurfaceSheet>();
  private joins: { name: string; a: SheetEdge; b: SheetEdge; continuity: string; kind: 'join' | 'bridge' }[] = [];
  constructor(readonly name = 'complex') {}
  private keyOf(e: SheetEdge) { for (const [k, s] of this.patches) if (s === e.sheet) return k; return undefined; }
  patch(name: string, sheet: any) { this.patches.set(name, toSheet(sheet)); return this; }
  /** Match edge b's sheet onto edge a (the sheet owning b is replaced by the matched one). */
  join(name: string, a: SheetEdge, b: SheetEdge, o: { continuity?: string } = {}) {
    const c = (o.continuity ?? 'G1').toUpperCase();
    const kb = this.keyOf(b);
    const matched = BaseSurface.Match(a.sheet, edgeCode(a), b.sheet, edgeCode(b), { continuity: c === 'G0' ? 'G0' : 'G1' });
    if (kb) this.patches.set(kb, matched);
    this.joins.push({ name, a, b: sheetEdge(matched, edgeCode(b)), continuity: c, kind: 'join' });
    return this;
  }
  /** A new bridging patch between two edges. */
  bridge(name: string, a: SheetEdge, b: SheetEdge, o: { continuity?: string; bulge?: number } = {}) {
    const s = BaseBlend.Bridge(a.sheet, edgeCode(a), b.sheet, edgeCode(b), { tension: o.bulge ?? 1 });
    this.patches.set(name, s);
    this.joins.push({ name, a, b, continuity: (o.continuity ?? 'G1').toUpperCase(), kind: 'bridge' });
    return this;
  }
  private colorFor(name: string, o: any) { return o.colors?.[name] ?? o.color; }
  parts(o: { wall?: number; resolution?: number; colors?: Record<string, string>; color?: string } = {}) {
    return [...this.patches].map(([name, s]) => { let sh = s.thicken(o.wall ?? 1.5, { nu: o.resolution, nv: o.resolution }).named(name); const c = this.colorFor(name, o); if (c) sh = sh.color(c); return { name, shape: sh }; });
  }
  toGroup(o: any = {}) { return group(this.parts(o)); }
  surfaceParts(o: any = {}) { return [...this.patches].map(([name, s]) => { let sh = s.toShape().named(name); const c = this.colorFor(name, o); if (c) sh = sh.color(c); return { name, shape: sh }; }); }
  toSurfaceGroup(o: any = {}) { return group(this.surfaceParts(o)); }
  toSolid(o: any = {}) { return union(this.parts(o).map((p) => p.shape)); }
  /** Sew every patch into a closed body and make it a solid (fails if the patches leave open edges). */
  toSewnSolid(o: { resolution?: number; tolerance?: number; color?: string } = {}) {
    const body = new SheetBody([...this.patches.values()], this.name);
    if (!body.isClosed(o.tolerance ?? 1e-2)) throw new ForgeError('SURFACE.OPEN', `surface complex "${this.name}" has ${body.openEdges(o.tolerance ?? 1e-2).length} open edge(s)`);
    const s = body.toSolid({ n: o.resolution ?? 32 });
    return o.color ? s.color(o.color) : s;
  }
  report(samples = 16) {
    return {
      name: this.name, patches: [...this.patches.keys()],
      joins: this.joins.map((j) => { const r = BaseAnalysis.EdgeContinuity(j.a.sheet, edgeCode(j.a), j.b.sheet, edgeCode(j.b), { samples }); return { name: j.name, kind: j.kind, requested: j.continuity, achieved: r.level, maxGap: r.maxGap, maxAngleDeg: r.maxAngleDeg, ok: r.level !== 'none' && (j.continuity === 'G0' || r.level !== 'G0') }; }),
    };
  }
}

// ================================================================ tubes (solid)
function tubeSolid(spine: any, radiusAt: (t: number) => number, o: { spineSamples?: number; radialSamples?: number; up?: Vec3 } = {}) {
  const P = curvePoints(spine, o.spineSamples ?? 64), fr = rmf(P, o.up), k = (o.radialSamples ?? 8) * 4;
  const rings: Vec3[][] = P.map((_, i) => { const t = i / (P.length - 1), f = rmfFrameAt(fr, P, t), r = radiusAt(t); return Array.from({ length: k }, (_, j) => { const a = (j / k) * TAU; return v3.add(f.o, v3.add(v3.scale(f.x, r * Math.cos(a)), v3.scale(f.y, r * Math.sin(a)))); }); });
  const cap = (r: number): Vec2[] => Array.from({ length: k }, (_, j) => { const a = (j / k) * TAU; return [r * Math.cos(a), r * Math.sin(a)]; });
  return solidFromRings(rings, { first: cap(radiusAt(0)), last: cap(radiusAt(1)) });
}
const stationRadius = (st: any): ((t: number) => number) => {
  if (typeof st === 'function') return st;
  if (Array.isArray(st) && typeof st[0] === 'number') return (t) => lerpList(st, t);
  const s = [...st].map((x: any) => (Array.isArray(x) ? { t: x[0], radius: x[1] } : x)).sort((a: any, b: any) => a.t - b.t);
  return (t) => { if (t <= s[0].t) return s[0].radius; for (let i = 1; i < s.length; i++) if (t <= s[i].t) { const f = (t - s[i - 1].t) / (s[i].t - s[i - 1].t || 1), g = f * f * (3 - 2 * f); return s[i - 1].radius + (s[i].radius - s[i - 1].radius) * g; } return s[s.length - 1].radius; };
};

// ================================================================ Surface namespace (ForgeCAD forms + older forms)
export const Surface = {
  ...BaseSurface,
  Cone: (o: any) => BaseSurface.Cone({ radius1: o.radius1 ?? o.radiusBottom ?? o.bottomRadius ?? o.radius, radius2: o.radius2 ?? o.radiusTop ?? o.topRadius ?? 0, height: o.height, sweep: o.sweep }),
  Torus: (o: any) => BaseSurface.Torus({ major: o.major ?? o.majorRadius, minor: o.minor ?? o.minorRadius }),
  /** Surface.Tube(spine, radius, { spineSamples, radialSamples, up }): a closed round solid along a 3D spine. */
  Tube: (spine: any, radius: number, o: any = {}) => tubeSolid(spine, () => radius, o),
  /** Surface.VariableTube(spine, [{ t, radius }, ...], options): a tube whose radius flares or necks along the spine. */
  VariableTube: (spine: any, stations: any, o: any = {}) => tubeSolid(spine, stationRadius(stations), o),
  /** Loft(input) → sheet; Loft(profiles, heights, options) → solid (like loft()). */
  Loft: (input: any, heights?: any, o?: any): any => {
    if (Array.isArray(heights)) return loft(input, heights, o);
    const sections = Array.isArray(input) ? input : input.sections ?? input.profiles ?? input.curves;
    return BaseSurface.Loft(sections, Array.isArray(input) ? heights ?? {} : input);
  },
  /** Patch([c0..c3]) or Patch({ bottom, right, top, left }). */
  Patch: (curves: any, _o?: any) => BaseSurface.Patch(Array.isArray(curves) ? curves : [curves.bottom ?? curves.front, curves.right, curves.top ?? curves.rear, curves.left]),
  Boundary: (input: any) => (input instanceof CurveNetBuilder ? input.toSheet() : Surface.Patch(input)),
  Fill: (input: any, o: any = {}) => BaseSurface.Fill(input?.boundary ?? input?.curve ?? input, { dome: o.dome ?? input?.dome }),
  /** Net() → builder; Net(uCurves, vCurves) → sheet (older form). */
  Net: (u?: any[], v?: any[]): any => (u ? BaseSurface.Net(u, v) : new CurveNetBuilder(false)),
  BoundaryNet: (curves?: any[]): any => (curves ? BaseSurface.BoundaryNet(curves) : new CurveNetBuilder(true)),
  Sew: (shapes: any[], o: any = {}) => BaseSurface.Sew(shapes.flat().map((s: any) => (s instanceof CurveNetBuilder ? s.toSheet() : s)), o),
  /** Extend(sheet, { edge, distance }) or Extend(sheet, distance, edge). */
  Extend: (s: any, o: any, edge?: Edge) => (typeof o === 'number' ? BaseSurface.Extend(toSheet(s), o, edge) : BaseSurface.Extend(toSheet(s), o.distance ?? o.length, o.edge ? edgeCode(o.edge) : 'u1')),
  /** Trim(shape, tool): a solid minus a tool solid, or the part of a sheet-thickened shape in front of a tool sheet; Trim(sheet, { u, v }) keeps a parameter window. */
  Trim: (s: any, tool: any): any => {
    if (s instanceof SurfaceSheet && (tool?.u || tool?.v)) return BaseSurface.Trim(s, tool);
    const shape = s instanceof Shape ? s : toSheet(s).toShape();
    return tool instanceof Shape ? shape.subtract(tool) : (shape as any).trimBySurface(tool);
  },
  /** Split(shape, tool) → [front, back]; Split(sheet, 'u' | 'v', t) splits a sheet in parameter space. */
  Split: (s: any, tool: any, t?: number): any => {
    if (s instanceof SurfaceSheet && (tool === 'u' || tool === 'v' || tool === undefined)) return BaseSurface.Split(s, tool, t);
    const shape = s instanceof Shape ? s : toSheet(s).toShape();
    if (tool instanceof Shape) { const r = shape.split(tool); return [r[0], r[1]]; }
    const r = (shape as any).splitBySurface(tool); return [r[0], r[1]];
  },
  /** Match(sheet, { edge, to, continuity }) or Match(a, ea, b, eb, o). */
  Match: (a: any, ea: any, b?: any, eb?: any, o?: any): any => {
    if (b === undefined && ea && typeof ea === 'object') {
      const own = edgeCode(ea.edge ?? 'left'), to: SheetEdge = ea.to ?? ea.target ?? ea.neighbor;
      return BaseSurface.Match(to.sheet, edgeCode(to), toSheet(a), own, { continuity: (ea.continuity ?? 'G1').toUpperCase() === 'G0' ? 'G0' : 'G1' });
    }
    return BaseSurface.Match(a, ea, b, eb, o);
  },
  /** Complex(name) → builder; Complex(...sheets) → sewn body (older form). */
  Complex: (...a: any[]): any => (a.length === 0 || typeof a[0] === 'string' ? new SurfaceComplexBuilder(a[0]) : BaseSurface.Complex(...a)),
};

// ================================================================ Blend / Analysis / Thickness (edge-object forms)
export const Blend = {
  Bridge: (a: any, ea?: any, b?: any, eb?: any, o?: any) => (isSheetEdge(a) ? BaseBlend.Bridge(a.sheet, edgeCode(a), (ea as SheetEdge).sheet, edgeCode(ea), b ?? {}) : BaseBlend.Bridge(a, ea, b, eb, o)),
  Face: (a: any, b?: any, o?: any) => (a instanceof SurfaceSheet ? BaseBlend.Face(a, b, o) : a.edgeA ? Blend.Bridge(a.edgeA, a.edgeB, { tension: a.tension }) : BaseBlend.Face(toSheet(a.a ?? a.between?.[0]), toSheet(a.b ?? a.between?.[1]), a)),
  FullRound: (a: any, b?: any, o?: any) => (a instanceof SurfaceSheet ? BaseBlend.FullRound(a, b, o) : a.edgeA ? BaseBlend.Bridge(a.edgeA.sheet, edgeCode(a.edgeA), a.edgeB.sheet, edgeCode(a.edgeB), { tension: Math.PI / 2 }) : BaseBlend.FullRound(toSheet(a.a ?? a.between?.[0]), toSheet(a.b ?? a.between?.[1]), a)),
};
export const Analysis = {
  ...BaseAnalysis,
  EdgeMatch: (a: any, ea?: any, b?: any, eb?: any, o?: any) => (isSheetEdge(a) ? BaseAnalysis.EdgeMatch(a.sheet, edgeCode(a), (ea as SheetEdge).sheet, edgeCode(ea), b ?? {}) : BaseAnalysis.EdgeMatch(a, ea, b, eb, o)),
  /** EdgeContinuity(edgeA, edgeB, o) / (a, ea, b, eb, o), or EdgeContinuity(shape, o): sharp feature edges of a solid. */
  EdgeContinuity: (a: any, ea?: any, b?: any, eb?: any, o?: any): any => {
    if (isSheetEdge(a)) return BaseAnalysis.EdgeContinuity(a.sheet, edgeCode(a), (ea as SheetEdge).sheet, edgeCode(ea), b ?? {});
    if (a instanceof Shape) {
      const opt = ea ?? {}, tol = opt.tangentToleranceDeg ?? 1;
      const edges = (a as any).sharpEdges?.(tol) ?? [];
      return { level: edges.length ? 'G0' : 'G1', sharpEdges: edges.length, ok: (opt.continuity ?? 'G1') === 'G0' || edges.length === 0 };
    }
    return BaseAnalysis.EdgeContinuity(a, ea, b, eb, o);
  },
  SurfaceHealth: (s: any, o?: any) => (s instanceof Shape ? { ok: BaseAnalysis.BRepValidity(s).valid, ...BaseAnalysis.BRepValidity(s) } : BaseAnalysis.SurfaceHealth(toSheet(s), o)),
};
export const Thickness = {
  alongU: (a: any, t?: any, o?: any): any => (a instanceof SurfaceSheet ? BaseThickness.alongU(a, t, o) : ({ kind: 'thicknessSpec', fn: (u: number) => lerpList(profileVals(a), u) } as ThicknessSpec)),
  alongV: (a: any, t?: any, o?: any): any => (a instanceof SurfaceSheet ? BaseThickness.alongV(a, t, o) : ({ kind: 'thicknessSpec', fn: (_u: number, v: number) => lerpList(profileVals(a), v) } as ThicknessSpec)),
  grid: (a: any, t?: any, o?: any): any => (a instanceof SurfaceSheet ? BaseThickness.grid(a, t, o) : ({ kind: 'thicknessSpec', fn: (u: number, v: number) => { const rows = (a as number[][]).map((r) => lerpList(r, u)); return lerpList(rows, v); } } as ThicknessSpec)),
};

// ================================================================ Sculpt control cage (ForgeCAD form)
const CC = ControlCage.prototype as any;
const cageAddr = (c: ControlCage, a: any): [number, number, number] => {
  if (Array.isArray(a)) return [a[0], a[1], a[2]];
  if (typeof a === 'string') {
    if (/^\d+,\d+,\d+$/.test(a)) return a.split(',').map(Number) as any;
    const [nx, ny, nz] = c.divisions, w = a.split('-');
    const pick = (lo: string, hi: string, n: number) => (w.includes(lo) ? 0 : w.includes(hi) ? n : Math.round(n / 2));
    return [pick('left', 'right', nx), pick('front', 'back', ny), pick('bottom', 'top', nz)];
  }
  return [a.i ?? a.x ?? 0, a.j ?? a.y ?? 0, a.k ?? a.z ?? 0];
};
Object.defineProperty(CC, 'faces', { configurable: true, get(this: ControlCage) {
  const [nx, ny, nz] = this.divisions, F: number[][] = [];
  const q = (a: number[], b: number[], c: number[], d: number[]) => F.push([a, b, c, d].map(([i, j, k]) => this.index(i, j, k)));
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) { q([i, j, 0], [i, j + 1, 0], [i + 1, j + 1, 0], [i + 1, j, 0]); q([i, j, nz], [i + 1, j, nz], [i + 1, j + 1, nz], [i, j + 1, nz]); }
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) { q([i, 0, k], [i + 1, 0, k], [i + 1, 0, k + 1], [i, 0, k + 1]); q([i, ny, k], [i, ny, k + 1], [i + 1, ny, k + 1], [i + 1, ny, k]); }
  for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) { q([0, j, k], [0, j, k + 1], [0, j + 1, k + 1], [0, j + 1, k]); q([nx, j, k], [nx, j + 1, k], [nx, j + 1, k + 1], [nx, j, k + 1]); }
  return F;
} });
Object.assign(CC, {
  movePoint(this: ControlCage, address: any, by: Vec3) { return this.move(cageAddr(this, address), toVec3(by)); },
  setPoint(this: ControlCage, address: any, to: Vec3) { const a = cageAddr(this, address); return this.move(a, v3.sub(toVec3(to), this.point(a[0], a[1], a[2]))); },
  editPoints(this: ControlCage, edits: { at: any; by?: Vec3; to?: Vec3 }[]) { return edits.reduce((c: any, e) => (e.to ? c.setPoint(e.at, e.to) : c.movePoint(e.at, e.by ?? [0, 0, 0])), this); },
  toShape(this: ControlCage, o: { subdivisions?: number; name?: string } = {}) { const s = BaseSculpt.surfaceFromControlCage(this, { refine: o.subdivisions }); return o.name ? s.named(o.name) : s; },
});
export const Sculpt = {
  ...BaseSculpt,
  /** controlBox(x, y, z, { divisions }) or controlBox({ size, divisions }). */
  controlBox: (x: any, y?: number, z?: number, o: any = {}) => (typeof x === 'number' ? BaseSculpt.controlBox({ size: [x, y ?? x, z ?? x], divisions: o.divisions ?? o.segments }) : BaseSculpt.controlBox(x)),
  surfaceFromControlCage: (input: any, o: any = {}) => BaseSculpt.surfaceFromControlCage(input, { refine: o.subdivisions ?? o.refine, roundness: o.roundness }),
};

// ================================================================ product skins (builder form)
export type SkinSide = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
const SIDE_ANGLE: Record<string, number> = { right: 0, back: 90, rear: 90, left: 180, front: 270 };
export interface ProductStationProfile { sketch: Sketch; width: number; depth: number; kind: string; radius?: number; exponent?: number }
function superEllipsePts(w: number, d: number, n: number, k = 96): Vec2[] { return Array.from({ length: k }, (_, i) => { const a = (i / k) * TAU, c = Math.cos(a), s = Math.sin(a); return [(w / 2) * Math.sign(c) * Math.abs(c) ** (2 / n), (d / 2) * Math.sign(s) * Math.abs(s) ** (2 / n)] as Vec2; }); }
export const productProfiles = {
  oval: (width: number, depth: number, o: { segments?: number } = {}): ProductStationProfile => ({ sketch: polygon(superEllipsePts(width, depth, 2, o.segments ?? 96)), width, depth, kind: 'oval' }),
  superEllipse: (width: number, depth: number, o: { exponent?: number; segments?: number } = {}): ProductStationProfile => ({ sketch: polygon(superEllipsePts(width, depth, o.exponent ?? 4, o.segments ?? 96)), width, depth, kind: 'superEllipse', exponent: o.exponent ?? 4 }),
  roundedRect: (width: number, depth: number, radius: number): ProductStationProfile => ({ sketch: rr2d(width, depth, Math.min(radius, width / 2 - 1e-3, depth / 2 - 1e-3)), width, depth, kind: 'roundedRect', radius }),
  circle: (diameter: number, o: { segments?: number } = {}): ProductStationProfile => ({ sketch: circle2d(diameter / 2, o.segments ?? 96), width: diameter, depth: diameter, kind: 'circle' }),
};
/** Outline points of a profile starting at +X and running counter-clockwise (so u = angle / 360). */
function ringFromSketch(s: Sketch, k = 96): Vec2[] {
  const poly = s.toPolygons().sort((a, b) => Math.abs(area2(b)) - Math.abs(area2(a)))[0];
  let pts = area2(poly) < 0 ? [...poly].reverse() : poly;
  const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
  return Array.from({ length: k }, (_, i) => rayHit(pts as Vec2[], c as Vec2, (i / k) * TAU));
}
function area2(p: number[][]) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }
function rayHit(poly: Vec2[], c: Vec2, ang: number): Vec2 {
  const d: Vec2 = [Math.cos(ang), Math.sin(ang)]; let best = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], e: Vec2 = [b[0] - a[0], b[1] - a[1]], den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-12) continue;
    const w: Vec2 = [a[0] - c[0], a[1] - c[1]], t = (w[0] * e[1] - w[1] * e[0]) / den, s = (w[0] * d[1] - w[1] * d[0]) / den;
    if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9 && t > best) best = t;
  }
  return [c[0] + d[0] * best, c[1] + d[1] * best];
}
export class ProductStationBuilder {
  center: Vec3 = [0, 0, 0]; profile?: ProductStationProfile; crown?: number;
  constructor(readonly name: string) {}
  at(p: Vec3) { this.center = toVec3(p); return this; }
  z(z: number) { this.center = [this.center[0], this.center[1], z]; return this; }
  oval(w: number, d: number, o?: any) { this.profile = productProfiles.oval(w, d, o); return this; }
  superEllipse(w: number, d: number, o?: any) { this.profile = productProfiles.superEllipse(w, d, o); return this; }
  roundedRect(w: number, d: number, r: number) { this.profile = productProfiles.roundedRect(w, d, r); return this; }
  circle(d: number, o?: any) { this.profile = productProfiles.circle(d, o); return this; }
  custom(sketch: Sketch, width: number, depth: number) { const b = sketch.bounds(); this.profile = { sketch: sketch.translate(-(b.minX + b.maxX) / 2, -(b.minY + b.maxY) / 2).scale([width / (b.width || 1), depth / (b.height || 1)] as any), width, depth, kind: 'custom' }; return this; }
  spec() { if (!this.profile) throw new ForgeError('PRODUCT.STATION_PROFILE', `station "${this.name}" needs a profile (oval, superEllipse, roundedRect, circle or custom)`); return { name: this.name, center: this.center, profile: this.profile, crown: this.crown }; }
}
const AXIS_FRAME = (axis: any): Mat4 => {
  const a = typeof axis === 'string' ? ({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as any)[axis.toLowerCase()] ?? [0, 0, 1] : v3.norm(toVec3(axis));
  return mat4.rotationBetween([0, 0, 1], a);
};
export interface ProductSurfaceFrame { point: Vec3; normal: Vec3; tangentU: Vec3; tangentV: Vec3; matrix: Mat4; skin: ProductSkin }
export class ProductSkin {
  readonly kind = 'productSkin';
  private rings: Vec3[][];
  private sheetCache?: SurfaceSheet;
  private shapeCache?: Shape;
  readonly refsMap: Record<string, any>;
  constructor(readonly name: string, readonly axis: any, readonly stations: ReturnType<ProductStationBuilder['spec']>[], readonly rails: any[], refs: Record<string, any>, readonly appearance: { color?: string; material?: any; edgeLength?: number }) {
    const xf = AXIS_FRAME(axis);
    this.rings = stations.map((s) => ringFromSketch(s.profile.sketch).map(([x, y]) => mat4.apply(xf, [x + s.center[0], y + s.center[1], s.center[2]])));
    this.refsMap = refs;
  }
  /** u around the skin (0 at +X, counter-clockwise), v from the first station to the last. */
  sheet(): SurfaceSheet { return (this.sheetCache ??= new SurfaceSheet((u, v) => crAt(this.rings.map((r) => atLoop(r, u)), v), { nu: 96, nv: Math.max(8, (this.rings.length - 1) * 12), closedU: true })); }
  get shape(): Shape {
    if (!this.shapeCache) {
      const R = this.rings, steps = 8, rings: Vec3[][] = [];
      for (let i = 0; i < (R.length - 1) * steps + 1; i++) { const v = i / ((R.length - 1) * steps); rings.push(R[0].map((_, j) => crAt(R.map((r) => r[j]), v))); }
      const inv = mat4.invert(AXIS_FRAME(this.axis)), cap = (r: Vec3[]) => r.map((p) => { const q = mat4.apply(inv, p); return [q[0], q[1]] as Vec2; });
      let s = solidFromRings(rings, { first: cap(rings[0]), last: cap(rings[rings.length - 1]) }).named(this.name).withMeta({ productSkin: { name: this.name, stations: this.stations.length } });
      if (this.appearance.color) s = s.color(this.appearance.color);
      if (this.appearance.material) s = s.material(typeof this.appearance.material === 'string' ? (BaseProduct.materials as any)[this.appearance.material] ?? {} : this.appearance.material);
      this.shapeCache = s;
    }
    return this.shapeCache;
  }
  toShape() { return this.shape; }
  /** Parameters on the skin sheet for a side coordinate. */
  sideUV(side: string, u = 0.5, v = 0.5): [number, number] | null {
    const a = SIDE_ANGLE[side];
    if (a == null) return null;
    return [(((a - 45 + 90 * u) / 360) % 1 + 1) % 1, v];
  }
  /** Frame on the skin: side and (u across the side, v along the axis); top/bottom are the end caps. */
  frame(q: { side: string; u?: number; v?: number; offset?: number }): ProductSurfaceFrame {
    const side = q.side ?? 'front', off = q.offset ?? 0;
    const uv = this.sideUV(side, q.u ?? 0.5, q.v ?? 0.5);
    if (uv) {
      const f = frameOf(this.sheet(), uv[0], uv[1]);
      // the sheet normal follows u x v; make sure it points out of the skin
      const c = this.axisPoint(uv[1]); const out = v3.dot(v3.sub(f.point, c), f.normal) >= 0 ? 1 : -1;
      const n = v3.scale(f.normal, out), tu = f.tangentU, tv = v3.cross(n, tu), p = v3.add(f.point, v3.scale(n, off));
      return { point: p, normal: n, tangentU: tu, tangentV: tv, matrix: mat4.fromFrame(tu, tv, n, p), skin: this };
    }
    if (side !== 'top' && side !== 'bottom') throw new ForgeError('PRODUCT.SIDE', `unknown skin side "${side}" (front, back, left, right, top, bottom)`);
    const ring = side === 'top' ? this.rings[this.rings.length - 1] : this.rings[0], st = side === 'top' ? this.stations[this.stations.length - 1] : this.stations[0];
    const xf = AXIS_FRAME(this.axis), n = v3.scale(mat4.applyDir(xf, [0, 0, 1]), side === 'top' ? 1 : -1), tu = mat4.applyDir(xf, [1, 0, 0]), tv = v3.cross(n, tu);
    const c = ring.reduce((a, p) => v3.add(a, v3.scale(p, 1 / ring.length)), [0, 0, 0] as Vec3);
    const p = v3.add(v3.add(v3.add(c, v3.scale(tu, ((q.u ?? 0.5) - 0.5) * st.profile.width)), v3.scale(tv, ((q.v ?? 0.5) - 0.5) * st.profile.depth)), v3.scale(n, off));
    return { point: p, normal: n, tangentU: tu, tangentV: tv, matrix: mat4.fromFrame(tu, tv, n, p), skin: this };
  }
  axisPoint(v: number): Vec3 { const r = this.rings.map((ring) => ring.reduce((a, p) => v3.add(a, v3.scale(p, 1 / ring.length)), [0, 0, 0] as Vec3)); return crAt(r, v); }
  uv(side: string, u = 0.5, v = 0.5) { return new ProductSurfaceRef(this, `${side}(${u},${v})`, { side, u, v }); }
  ref(name: string) { const q = this.refsMap[name]; if (!q) throw new ForgeError('PRODUCT.REF', `skin "${this.name}" has no ref "${name}" (have: ${Object.keys(this.refsMap).join(', ') || 'none'})`); return new ProductSurfaceRef(this, name, q); }
  surface(side: string) { return new ProductSurfaceBuilder(this, side); }
  /** The skin plus children as one group (children keep their names). */
  with(...children: any[]) { return group([{ name: this.name, shape: this.shape }, ...children.flat().map((c: any, i: number) => (c?.shape && c?.name ? c : { name: c?.name ?? `detail ${i + 1}`, shape: c?.build ? c.build() : c }))]); }
  /** Fuse details into the skin solid. */
  integrate(...details: any[]) { return this.shape.add(...details.flat().map((d: any) => (d?.build ? d.build() : d?.shape ?? d))); }
}
export class ProductSurfaceRef {
  constructor(readonly skin: ProductSkin, readonly name: string, readonly query: { side: string; u?: number; v?: number; offset?: number }) {}
  frame(over: any = {}) { return this.skin.frame({ ...this.query, ...over }); }
  with(over: any) { return new ProductSurfaceRef(this.skin, this.name, { ...this.query, ...over }); }
  /** Place a detail (built at the origin, Z out of the surface) on this point; inset sinks it into the skin. */
  attach(detail: any, o: { offset?: number; inset?: number } = {}) {
    const f = this.frame({ offset: (this.query.offset ?? 0) + (o.offset ?? 0) - (o.inset ?? 0) });
    const d = detail?.build ? detail.build() : detail;
    return d.transform(f.matrix);
  }
}
export class ProductSurfaceBuilder {
  constructor(readonly skin: ProductSkin, readonly side: string) {}
  ref(u = 0.5, v = 0.5, offset = 0) { return new ProductSurfaceRef(this.skin, `${this.side}(${u},${v})`, { side: this.side, u, v, offset }); }
  uv(u = 0.5, v = 0.5, offset = 0) { return this.ref(u, v, offset); }
}
export class ProductSkinBuilder {
  private ax: any = 'z'; private st: any[] = []; private refList: Record<string, any> = {}; private app: any = {};
  constructor(readonly name: string) {}
  axis(a: any) { this.ax = a; return this; }
  stations(s: any[]) { this.st = s.flat(); return this; }
  ref(name: string, q: any) { this.refList[name] = q; return this; }
  refs(r: Record<string, any>) { Object.assign(this.refList, r); return this; }
  uv(side: string, u = 0.5, v = 0.5) { return { side, u, v }; }
  material(m: any) { this.app.material = m; return this; }
  color(c: string) { this.app.color = c; return this; }
  edgeLength(e: number) { this.app.edgeLength = e; return this; }
  build() {
    const specs = this.st.map((s: any, i: number) => (s instanceof ProductStationBuilder ? s.spec() : s.profile ? { name: s.name ?? `s${i}`, center: toVec3(s.center ?? [0, 0, s.z ?? 0]), profile: s.profile, crown: s.crown } : (() => { throw new ForgeError('PRODUCT.STATION', 'stations must be Product.station(name) builders'); })()));
    if (specs.length < 2) throw new ForgeError('PRODUCT.SKIN', 'a skin needs at least two stations');
    specs.sort((a: any, b: any) => a.center[2] - b.center[2]);
    return new ProductSkin(this.name, this.ax, specs, [], this.refList, this.app);
  }
}
export class ProductPanelBuilder {
  private prof?: Sketch; private app: any = {}; private th = 1.2;
  constructor(readonly name: string) {}
  rounded(w: number, h: number, r = Math.min(w, h) * 0.15) { this.prof = rr2d(w, h, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3)); return this; }
  oval(w: number, h: number) { this.prof = polygon(superEllipsePts(w, h, 2)); return this; }
  profile(p: Sketch) { this.prof = p; return this; }
  material(m: any) { this.app.material = m; return this; }
  color(c: string) { this.app.color = c; return this; }
  thickness(t: number) { this.th = t; return this; }
  build() {
    if (!this.prof) throw new ForgeError('PRODUCT.PANEL', `panel "${this.name}" needs a profile (rounded, oval or profile)`);
    let s = this.prof.extrude(this.th).named(this.name);
    if (this.app.color) s = s.color(this.app.color);
    if (this.app.material) s = s.material(typeof this.app.material === 'string' ? (BaseProduct.materials as any)[this.app.material] ?? {} : this.app.material);
    return s;
  }
  transform(m: Mat4) { return this.build().transform(m); }
}
export class ProductRibbonBuilder {
  private skin?: ProductSkin; private pts: any[] = []; private o: any = { width: 6, thickness: 1.2, offset: 0, samples: 64, widthSamples: 2 };
  constructor(readonly name: string) {}
  on(skin: ProductSkin, points: any[], o: any = {}) { this.skin = skin; this.pts = points; Object.assign(this.o, o); return this; }
  fromRefs(points: ProductSurfaceRef[], o: any = {}) { this.skin = points[0]?.skin; this.pts = points; Object.assign(this.o, o); return this; }
  width(w: number) { this.o.width = w; return this; }
  thickness(t: number) { this.o.thickness = t; return this; }
  offset(d: number) { this.o.offset = d; return this; }
  samples(n: number) { this.o.samples = n; return this; }
  widthSamples(n: number) { this.o.widthSamples = n; return this; }
  resolution(n: number) { this.o.samples = n; return this; }
  material(m: any) { this.o.material = m; return this; }
  color(c: string) { this.o.color = c; return this; }
  /** A conformal strip on one side of the skin through the given points (refs or { side, u, v }). */
  build(over: any = {}) {
    const o = { ...this.o, ...over };
    if (!this.skin || this.pts.length < 2) throw new ForgeError('PRODUCT.RIBBON', `ribbon "${this.name}" needs a skin and at least two points`);
    const q = this.pts.map((p: any) => (p instanceof ProductSurfaceRef ? p.query : Array.isArray(p) ? { side: p[0], u: p[1], v: p[2] } : p));
    const sides = new Set(q.map((x: any) => x.side));
    if (sides.size > 1) throw new ForgeError('PRODUCT.RIBBON_SIDES', 'a ribbon stays on one side; make one ribbon per side and join them');
    const n = o.samples, uv = Array.from({ length: n + 1 }, (_, i) => { const t = i / n, s = t * (q.length - 1), k = Math.min(q.length - 2, Math.floor(s)), f = s - k; return { side: q[0].side, u: (q[k].u ?? 0.5) + ((q[k + 1].u ?? 0.5) - (q[k].u ?? 0.5)) * f, v: (q[k].v ?? 0.5) + ((q[k + 1].v ?? 0.5) - (q[k].v ?? 0.5)) * f }; });
    const frames = uv.map((c) => this.skin!.frame({ ...c, offset: o.offset }));
    const rings: Vec3[][] = frames.map((f, i) => {
      const a = frames[Math.max(0, i - 1)].point, b = frames[Math.min(frames.length - 1, i + 1)].point;
      const T = v3.norm(v3.sub(b, a)), side = v3.norm(v3.cross(f.normal, T)), w = o.width / 2, inner = v3.sub(f.point, v3.scale(f.normal, 0.05));
      return [v3.sub(inner, v3.scale(side, w)), v3.add(inner, v3.scale(side, w)), v3.add(v3.add(f.point, v3.scale(side, w)), v3.scale(f.normal, o.thickness)), v3.add(v3.sub(f.point, v3.scale(side, w)), v3.scale(f.normal, o.thickness))];
    });
    const cap: Vec2[] = [[-o.width / 2, 0], [o.width / 2, 0], [o.width / 2, o.thickness], [-o.width / 2, o.thickness]];
    let s = solidFromRings(rings, { first: cap, last: cap }).named(this.name);
    if (o.color) s = s.color(o.color);
    return s;
  }
}
export const Product = {
  ...BaseProduct,
  /** skin(name) → builder; skin(stations[]) → older skin. */
  skin: (a: any, o?: any): any => (typeof a === 'string' ? new ProductSkinBuilder(a) : BaseProduct.skin(a, o)),
  /** station(name) → builder; station(z, { width, depth, roundness }) → older station record. */
  station: (a: any, o?: any): any => (typeof a === 'string' ? new ProductStationBuilder(a) : BaseProduct.station(a, o)),
  profiles: Object.assign((o: any) => BaseProduct.profiles(o), productProfiles),
  /** ref(skin, query) → surface ref; ref(name, point) → named point (older form). */
  ref: (a: any, q: any): any => (a instanceof ProductSkin ? (typeof q === 'string' ? a.ref(q) : new ProductSurfaceRef(a, q.name ?? `${q.side}(${q.u},${q.v})`, q)) : BaseProduct.ref(a, q)),
  surface: (skin: any, side?: string): any => (skin instanceof ProductSkin ? (side ? skin.surface(side) : skin.sheet()) : BaseProduct.surface(skin)),
  panel: (a: any, o?: any): any => (typeof a === 'string' ? new ProductPanelBuilder(a) : BaseProduct.panel(a, o)),
  ribbon: (a: any, o?: any): any => (typeof a === 'string' ? new ProductRibbonBuilder(a) : BaseProduct.ribbon(a, o)),
};

// ================================================================ carriers with surface coordinates
export interface SurfaceAnchor { kind: 'surfaceAnchor'; carrier: AnyCarrier; coordinate: any; name?: string }
export interface CarrierFrame { point: Vec3; normal: Vec3; tangentAlong: Vec3; tangentAcross: Vec3; matrix: Mat4; carrier: AnyCarrier; representation: string; coordinate: any }
abstract class CarrierBase {
  abstract readonly kind: string;
  abstract pointAt(c: any): Vec3;
  abstract normalAt(c: any): Vec3;
  abstract bounds(): any;
  abstract mirrorCoordinate(c: any): any;
  /** Shift a coordinate by mm along the first and second surface directions. */
  abstract shift(c: any, along: number, across: number): any;
  abstract lerp(a: any, b: any, t: number): any;
  abstract norm(c: any): any;
  abstract inBounds(c: any): boolean;
  constructor(readonly name: string) {}
  tangentAt(c: any, hint?: Vec3): Vec3 {
    const n = this.normalAt(c), p = this.pointAt(c), q = this.pointAt(this.shift(c, 0.5, 0));
    let t = v3.norm(v3.sub(q, p));
    if (hint) { const h = toVec3(hint); const proj = v3.sub(h, v3.scale(n, v3.dot(h, n))); if (v3.len(proj) > 1e-9) t = v3.norm(proj); }
    return t;
  }
  frameAt(c: any, hint?: Vec3): CarrierFrame {
    const cc = this.norm(c), n = this.normalAt(cc), t = this.tangentAt(cc, hint), a = v3.cross(n, t), p = this.pointAt(cc);
    return { point: p, normal: n, tangentAlong: t, tangentAcross: a, matrix: mat4.fromFrame(t, a, n, p), carrier: this as any, representation: this.kind, coordinate: cc };
  }
  mirrorPoint(p: Vec3) { const q = toVec3(p); return [-q[0], q[1], q[2]] as Vec3; }
  path() { return new SurfacePathBuilder(this as any); }
  place(shape: Shape, c: any) { return shape.transform(this.frameAt(c).matrix); }
}
export class CylinderCarrier extends CarrierBase {
  readonly kind = 'cylinder';
  d = 74; h = 120; cl = 0; c: Vec3 = [0, 0, 0];
  diameter(v: number) { this.d = v; return this; }
  height(v: number) { this.h = v; return this; }
  clearance(v: number) { this.cl = v; return this; }
  center(p: Vec3) { this.c = toVec3(p); return this; }
  get radius() { return this.d / 2 + this.cl; }
  norm(c: any) { if (c?.coordinate) c = c.coordinate; if (Array.isArray(c)) return { kind: 'cylinder', angle: c[0], z: c[1], offset: c[2] ?? 0 }; return { kind: 'cylinder', angle: c.angle ?? 90, z: c.z ?? this.h / 2, offset: c.offset ?? 0 }; }
  pointAt(c: any) { const k = this.norm(c), a = (k.angle * Math.PI) / 180, r = this.radius + k.offset; return [this.c[0] + r * Math.cos(a), this.c[1] + r * Math.sin(a), this.c[2] + k.z] as Vec3; }
  normalAt(c: any) { const a = (this.norm(c).angle * Math.PI) / 180; return [Math.cos(a), Math.sin(a), 0] as Vec3; }
  tangentAt(c: any, hint?: Vec3) { if (hint) return super.tangentAt(c, hint); return [0, 0, 1] as Vec3; }
  anchor(angle: number, z = this.h / 2, o: { offset?: number; name?: string } = {}): SurfaceAnchor { return { kind: 'surfaceAnchor', carrier: this, coordinate: this.norm({ angle, z, offset: o.offset }), name: o.name }; }
  back(o: { z?: number; offset?: number } = {}) { return this.anchor(90, o.z ?? this.h / 2, o); }
  top(o: { angle?: number; offset?: number } = {}) { return this.anchor(o.angle ?? 90, this.h, o); }
  bottom(o: { angle?: number; offset?: number } = {}) { return this.anchor(o.angle ?? 90, 0, o); }
  mirrorCoordinate(c: any) { const k = this.norm(c); return { ...k, angle: 180 - k.angle }; }
  shift(c: any, along: number, across: number) { const k = this.norm(c); return { ...k, z: k.z + along, angle: k.angle + (across / this.radius) * (180 / Math.PI) }; }
  lerp(a: any, b: any, t: number) { const A = this.norm(a), B = this.norm(b); let d = B.angle - A.angle; d = ((d + 540) % 360) - 180; return { kind: 'cylinder', angle: A.angle + d * t, z: A.z + (B.z - A.z) * t, offset: A.offset + (B.offset - A.offset) * t }; }
  bounds() { return { angle: [0, 360] as [number, number], z: [0, this.h] as [number, number] }; }
  inBounds(c: any) { const k = this.norm(c); return k.z >= -1e-6 && k.z <= this.h + 1e-6; }
  offset(d: number) { const c = new CylinderCarrier(this.name).diameter(this.d).height(this.h).clearance(this.cl + d).center(this.c); return c; }
}
export class PlaneCarrier extends CarrierBase {
  readonly kind = 'plane';
  w = 100; hh = 100; o: Vec3 = [0, 0, 0]; n: Vec3 = [0, 0, 1];
  size(w: number, h: number) { this.w = w; this.hh = h; return this; }
  origin(p: Vec3) { this.o = toVec3(p); return this; }
  normal(n: Vec3) { this.n = v3.norm(toVec3(n)); return this; }
  private axes() { const x = Math.abs(this.n[2]) > 0.9 ? v3.norm(v3.cross([0, 1, 0], this.n)) : v3.norm(v3.cross(this.n, [0, 0, 1])); const xx = Math.abs(this.n[2]) > 0.9 ? [1, 0, 0] as Vec3 : x; return { x: xx, y: v3.cross(this.n, xx) }; }
  norm(c: any) { if (c?.coordinate) c = c.coordinate; if (Array.isArray(c)) return { kind: 'plane', x: c[0], y: c[1], offset: c[2] ?? 0 }; return { kind: 'plane', x: c.x ?? 0, y: c.y ?? 0, offset: c.offset ?? 0 }; }
  pointAt(c: any) { const k = this.norm(c), { x, y } = this.axes(); return v3.add(v3.add(v3.add(this.o, v3.scale(x, k.x)), v3.scale(y, k.y)), v3.scale(this.n, k.offset)); }
  normalAt(_c?: any) { return this.n; }
  tangentAt(c: any, hint?: Vec3) { return hint ? super.tangentAt(c, hint) : this.axes().y; }
  anchor(x = 0, y = 0, o: { offset?: number; name?: string } = {}): SurfaceAnchor { return { kind: 'surfaceAnchor', carrier: this, coordinate: this.norm({ x, y, offset: o.offset }), name: o.name }; }
  right(o: { y?: number; offset?: number } = {}) { return this.anchor(this.w / 2, o.y ?? 0, o); }
  top(o: { x?: number; offset?: number } = {}) { return this.anchor(o.x ?? 0, this.hh / 2, o); }
  bottom(o: { x?: number; offset?: number } = {}) { return this.anchor(o.x ?? 0, -this.hh / 2, o); }
  mirrorCoordinate(c: any) { const k = this.norm(c); return { ...k, x: -k.x }; }
  mirrorPoint(p: Vec3) { const q = toVec3(p), { x } = this.axes(), d = v3.dot(v3.sub(q, this.o), x); return v3.sub(q, v3.scale(x, 2 * d)); }
  shift(c: any, along: number, across: number) { const k = this.norm(c); return { ...k, y: k.y + along, x: k.x + across }; }
  lerp(a: any, b: any, t: number) { const A = this.norm(a), B = this.norm(b); return { kind: 'plane', x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, offset: A.offset + (B.offset - A.offset) * t }; }
  bounds() { return { x: [-this.w / 2, this.w / 2] as [number, number], y: [-this.hh / 2, this.hh / 2] as [number, number] }; }
  inBounds(c: any) { const k = this.norm(c); return Math.abs(k.x) <= this.w / 2 + 1e-6 && Math.abs(k.y) <= this.hh / 2 + 1e-6; }
  offset(d: number) { return new PlaneCarrier(this.name).size(this.w, this.hh).origin(v3.add(this.o, v3.scale(this.n, d))).normal(this.n); }
}
export class ProductSkinCarrier extends CarrierBase {
  readonly kind = 'productSkin';
  constructor(readonly skin: ProductSkin, name?: string, readonly extra = 0) { super(name ?? skin.name); }
  norm(c: any) { if (c?.coordinate) c = c.coordinate; if (c instanceof ProductSurfaceRef) c = c.query; if (Array.isArray(c)) return { kind: 'productSkin', side: c[0], u: c[1], v: c[2], offset: c[3] ?? 0 }; return { kind: 'productSkin', side: c.side ?? 'front', u: c.u ?? 0.5, v: c.v ?? 0.5, offset: c.offset ?? 0 }; }
  pointAt(c: any) { const k = this.norm(c); return this.skin.frame({ ...k, offset: k.offset + this.extra }).point; }
  normalAt(c: any) { return this.skin.frame(this.norm(c)).normal; }
  tangentAt(c: any, hint?: Vec3) { return hint ? super.tangentAt(c, hint) : this.skin.frame(this.norm(c)).tangentV; }
  private sideSize(side: string) { const st = this.skin.stations, w = Math.max(...st.map((s) => s.profile.width)), d = Math.max(...st.map((s) => s.profile.depth)), L = st[st.length - 1].center[2] - st[0].center[2]; return { across: (Math.PI * ((side === 'left' || side === 'right' ? d : w))) / 4, along: side === 'top' || side === 'bottom' ? d : L }; }
  shift(c: any, along: number, across: number) { const k = this.norm(c), s = this.sideSize(k.side); return { ...k, v: k.v + along / (s.along || 1), u: k.u + across / (s.across || 1) }; }
  lerp(a: any, b: any, t: number) { const A = this.norm(a), B = this.norm(b); if (A.side !== B.side) throw new ForgeError('CARRIER.SIDES', 'a product-skin path stays on one side; join sides with sideTransition'); return { ...A, u: A.u + (B.u - A.u) * t, v: A.v + (B.v - A.v) * t, offset: A.offset + (B.offset - A.offset) * t }; }
  mirrorCoordinate(c: any) { const k = this.norm(c), sw: Record<string, string> = { left: 'right', right: 'left' }; return { ...k, side: sw[k.side] ?? k.side, u: 1 - k.u }; }
  bounds() { return { u: [0, 1] as [number, number], v: [0, 1] as [number, number] }; }
  inBounds(c: any) { const k = this.norm(c); return k.u >= -1e-6 && k.u <= 1 + 1e-6 && k.v >= -1e-6 && k.v <= 1 + 1e-6; }
  /** Anchors on the shared boundary of two neighbouring sides at height v. */
  sideTransition(from: string, to: string, input: { name?: string; v?: number; offset?: number } = {}) {
    const order = ['right', 'back', 'left', 'front'], i = order.indexOf(from), j = order.indexOf(to);
    if (i < 0 || j < 0 || (Math.abs(i - j) !== 1 && Math.abs(i - j) !== 3)) throw new ForgeError('CARRIER.TRANSITION', `sides "${from}" and "${to}" do not share an edge`);
    const fromU = (i + 1) % 4 === j ? 1 : 0;
    const name = input.name ?? `${from}-${to}`, v = input.v ?? 0.5, offset = input.offset ?? 0;
    return { name, from: { kind: 'surfaceAnchor', carrier: this, coordinate: this.norm({ side: from, u: fromU, v, offset }), name } as SurfaceAnchor, to: { kind: 'surfaceAnchor', carrier: this, coordinate: this.norm({ side: to, u: 1 - fromU, v, offset }), name } as SurfaceAnchor };
  }
  sideTransitionChain(sides: string[], input: any = {}) { return sides.slice(0, -1).map((s, i) => this.sideTransition(s, sides[i + 1], { ...input, name: input.name ? `${input.name}${i + 1}` : undefined })); }
  anchor(side: string, u = 0.5, v = 0.5, o: { offset?: number; name?: string } = {}): SurfaceAnchor { return { kind: 'surfaceAnchor', carrier: this, coordinate: this.norm({ side, u, v, offset: o.offset }), name: o.name }; }
  offset(d: number) { return new ProductSkinCarrier(this.skin, this.name, this.extra + d); }
}
type AnyCarrier = CylinderCarrier | PlaneCarrier | ProductSkinCarrier;

export class SurfacePath {
  readonly kind = 'surfacePath';
  constructor(readonly carrier: AnyCarrier, readonly points: any[], readonly closedValue = false) {}
  closed() { return new SurfacePath(this.carrier, this.points, true); }
  mirror() { return new SurfacePath(this.carrier, this.points.map((p) => this.carrier.mirrorCoordinate(p)), this.closedValue); }
  /** Coordinate at t in [0, 1], linearly between the path's points (cylinder angles take the short way round the seam). */
  coordinateAt(t: number) {
    const P = this.closedValue ? [...this.points, this.points[0]] : this.points;
    const s = clamp01(t) * (P.length - 1), i = Math.min(P.length - 2, Math.floor(s));
    return this.carrier.lerp(P[i], P[i + 1], s - i);
  }
  sample(count = 48) { return Array.from({ length: count }, (_, i) => { const t = count === 1 ? 0 : i / (count - 1), c = this.coordinateAt(t); return { t, coordinate: c, point: this.carrier.pointAt(c), frame: this.carrier.frameAt(c) }; }); }
  length(samples = 64) { const s = this.sample(samples); let L = 0; for (let i = 1; i < s.length; i++) L += v3.dist(s[i - 1].point, s[i].point); return L; }
}
export class SurfacePathBuilder {
  private pts: any[] = []; private cl = false; private mir = false;
  constructor(readonly carrier: AnyCarrier) {}
  private c(x: any) { return this.carrier.norm(x?.coordinate ?? x); }
  from(x: any) { this.pts = [this.c(x)]; return this; }
  through(x: any) { this.pts.push(this.c(x)); return this; }
  to(x: any) { this.pts.push(this.c(x)); return this; }
  /** Arc around a cylinder: { from: angleDeg, to: angleDeg, z, steps }. */
  around(input: { from?: number; to?: number; sweep?: number; z?: number; steps?: number; offset?: number }) {
    const a0 = input.from ?? (this.pts.length ? (this.pts[this.pts.length - 1] as any).angle : 0), a1 = input.to ?? a0 + (input.sweep ?? 360), n = input.steps ?? 12;
    const z = input.z ?? (this.pts.length ? (this.pts[this.pts.length - 1] as any).z : 0);
    for (let i = this.pts.length ? 1 : 0; i <= n; i++) this.pts.push(this.carrier.norm({ angle: a0 + ((a1 - a0) * i) / n, z, offset: input.offset }));
    return this;
  }
  closed() { this.cl = true; return this; }
  mirror() { this.mir = true; return this; }
  build() { const p = new SurfacePath(this.carrier, this.pts, this.cl); return this.mir ? p.mirror() : p; }
}

export const Carrier = {
  ...BaseCarrier,
  /** cylinder(name) → CylinderCarrier builder; cylinder({ radius, height }) → older carrier. */
  cylinder: (a?: any): any => (a == null || typeof a === 'string' ? new CylinderCarrier(a ?? 'cylinder') : BaseCarrier.cylinder(a)),
  plane: (a?: any): any => (a == null || typeof a === 'string' ? new PlaneCarrier(a ?? 'plane') : BaseCarrier.plane(a)),
  productSkin: (skin: any, name?: string): any => (skin instanceof ProductSkin ? new ProductSkinCarrier(skin, name) : BaseCarrier.productSkin(skin)),
};

// ================================================================ surface bodies: members, joins, features
export interface MemberFeature { type: string; name?: string; length?: number; width?: number; diameter?: number; counterboreDiameter?: number; clearanceDiameter?: number; height?: number; depth?: number; count?: number; along?: number; across?: number; verticalTravel?: number }
export class CounterboreBuilder {
  private pos: { along?: number; across?: number } = {};
  constructor(readonly o: { diameter?: number; clearanceDiameter?: number; counterboreDiameter?: number; depth?: number } = {}) {}
  at(input: any) { this.pos = Array.isArray(input) ? { along: input[0], across: input[1] } : input; return this; }
  toFeature(name?: string): MemberFeature { return { type: 'counterbore', name, clearanceDiameter: this.o.clearanceDiameter ?? this.o.diameter ?? 4.5, counterboreDiameter: this.o.counterboreDiameter ?? 8, depth: this.o.depth ?? 2, along: this.pos.along ?? 0, across: this.pos.across ?? 0 }; }
}
export class RoundedSlotBuilder {
  private pos: { along?: number; across?: number } = {}; private travel = 0;
  constructor(readonly o: { length?: number; width?: number } = {}) {}
  verticalTravel(v: number) { this.travel = v; return this; }
  at(input: any) { this.pos = Array.isArray(input) ? { along: input[0], across: input[1] } : input; return this; }
  toFeature(name?: string): MemberFeature { return { type: 'roundedSlot', name, length: this.o.length ?? 0, width: this.o.width ?? 5, verticalTravel: this.travel, along: this.pos.along ?? 0, across: this.pos.across ?? 0 }; }
}
export interface MemberSection { width?: number; thickness: number; edgeRadius?: number; direction?: 'outward' | 'inward'; material?: any; stations?: { t: number; width?: number; thickness?: number }[] }
export class SurfaceMemberBuilder {
  kindValue: 'band' | 'plate' = 'band'; anchorAtPos?: any; sizeWH: [number, number] = [20, 20]; pathValue?: SurfacePath; sectionValue: MemberSection = { width: 8, thickness: 3 };
  capStyle: 'round' | 'flat' = 'round'; features: MemberFeature[] = []; anchors: Record<string, any> = {}; mirrorSource?: string; profiles: Record<string, any> = {};
  constructor(readonly body: SurfaceBodyBuilder, readonly name: string) {}
  plate() { this.kindValue = 'plate'; return this; }
  band() { this.kindValue = 'band'; return this; }
  at(a: any) { this.anchorAtPos = a; return this; }
  size(w: number, h: number) { this.sizeWH = [w, h]; return this; }
  path(p: any) { this.pathValue = p instanceof SurfacePathBuilder ? p.build() : p; return this; }
  section(s: MemberSection) { this.sectionValue = { ...this.sectionValue, ...s }; return this; }
  cap(style: 'round' | 'flat') { this.capStyle = style; return this; }
  slot(name: string, f: any) { this.features.push({ ...(f?.toFeature ? f.toFeature(name) : f), name, type: f?.type ?? 'roundedSlot' }); return this; }
  cutout(name: string, f: any) { this.features.push({ ...(f?.toFeature ? f.toFeature(name) : f), name }); return this; }
  anchorAt(name: string, c: any) { this.anchors[name] = c?.coordinate ?? c; return this; }
  featuresList(fs: MemberFeature[]) { this.features.push(...fs); return this; }
  profile(name: string, o: any = {}) { this.profiles[name] = o; if (o.section) this.section(o.section); return this; }
  mirrorOf(member: string) { this.mirrorSource = member; return this; }
  member(name: string) { return this.body.member(name); }
  join(a: string, b: string) { return this.body.join(a, b); }
  autoJoinAtSharedAnchors() { this.body.autoJoinAtSharedAnchors(); return this; }
  build() { return this.body.build(); }
}
export class SurfaceJoinBuilder {
  anchorsValue?: [string, string]; blendValue?: any;
  constructor(readonly body: SurfaceBodyBuilder, readonly from: string, readonly to: string) {}
  betweenAnchors(a: string, b: string) { this.anchorsValue = [a, b]; return this; }
  blend(input: any = {}) { this.blendValue = input; return this; }
  member(name: string) { return this.body.member(name); }
  join(a: string, b: string) { return this.body.join(a, b); }
  build() { return this.body.build(); }
}
interface Diagnostic { code: string; severity: 'error' | 'warning' | 'info'; message: string; member?: string; join?: string }
export class SurfaceBodyBuilder {
  carrierValue?: AnyCarrier; members = new Map<string, SurfaceMemberBuilder>(); joins: SurfaceJoinBuilder[] = []; private auto = false;
  constructor(readonly name: string) {}
  carrier(c: AnyCarrier) { this.carrierValue = c; return this; }
  member(name: string) { let m = this.members.get(name); if (!m) { m = new SurfaceMemberBuilder(this, name); this.members.set(name, m); } return m; }
  join(a: string, b: string) { const j = new SurfaceJoinBuilder(this, a, b); this.joins.push(j); return j; }
  autoJoinAtSharedAnchors() { this.auto = true; return this; }
  build(): Shape { return this.buildWithDiagnostics().shape; }
  buildWithDiagnostics() {
    const C = this.carrierValue;
    if (!C) throw new ForgeError('SURFACE_BODY.NO_CARRIER', `surface body "${this.name}" needs .carrier(...)`);
    const diags: Diagnostic[] = [], parts: { name: string; shape: Shape }[] = [], ends = new Map<string, { a: any; b: any; width: number }>();
    for (const m of this.members.values()) {
      try {
        const src = m.mirrorSource ? this.members.get(m.mirrorSource) : undefined;
        if (m.mirrorSource && !src) { diags.push({ code: 'member.mirrorSourceMissing', severity: 'error', message: `member "${m.name}" mirrors "${m.mirrorSource}", which does not exist`, member: m.name }); continue; }
        const mm = src ? mirrored(src, m) : m;
        const built = buildMember(C, mm, diags);
        if (built) { parts.push({ name: m.name, shape: built.shape }); ends.set(m.name, { a: built.start, b: built.end, width: mm.sectionValue.width ?? 8 }); }
      } catch (e: any) { diags.push({ code: e?.code ?? 'member.buildFailed', severity: 'error', message: e?.message ?? String(e), member: m.name }); }
    }
    const joinList = [...this.joins];
    if (this.auto) {
      const names = [...this.members.keys()];
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        const A = this.members.get(names[i])!, B = this.members.get(names[j])!;
        const shared = Object.keys(A.anchors).filter((k) => k in B.anchors);
        for (const k of shared) if (!joinList.some((x) => (x.from === names[i] && x.to === names[j]) || (x.from === names[j] && x.to === names[i]))) joinList.push(new SurfaceJoinBuilder(this, names[i], names[j]).betweenAnchors(k, k));
        if (!shared.length) { const ea = ends.get(names[i]), eb = ends.get(names[j]); if (ea && eb && closestEnds(C, ea, eb).d < 1e-3) joinList.push(new SurfaceJoinBuilder(this, names[i], names[j])); }
      }
    }
    const joinGeoms: { name: string; shape: Shape }[] = [];
    for (const j of joinList) {
      const jn = `${j.from}~${j.to}`, A = this.members.get(j.from), B = this.members.get(j.to);
      if (!A || !B) { diags.push({ code: 'join.memberMissing', severity: 'error', message: `join ${jn} names a member that does not exist`, join: jn }); continue; }
      let pa: any, pb: any;
      if (j.anchorsValue) {
        pa = A.anchors[j.anchorsValue[0]]; pb = B.anchors[j.anchorsValue[1]];
        if (pa == null || pb == null) { diags.push({ code: 'join.missingAnchor', severity: 'error', message: `join ${jn}: anchor "${pa == null ? j.anchorsValue[0] : j.anchorsValue[1]}" is not defined on its member`, join: jn }); continue; }
      } else {
        const ea = ends.get(j.from), eb = ends.get(j.to);
        if (!ea || !eb) { diags.push({ code: 'join.memberNotBuilt', severity: 'error', message: `join ${jn}: a member failed to build`, join: jn }); continue; }
        const best = closestEnds(C, ea, eb), w = Math.min(ea.width, eb.width);
        if (best.d > 6 * w) { diags.push({ code: 'join.tooFar', severity: 'error', message: `join ${jn}: closest endpoints are ${best.d.toFixed(1)} mm apart (limit ${(6 * w).toFixed(1)} mm)`, join: jn }); continue; }
        pa = best.a; pb = best.b;
      }
      const sec = { width: Math.min(A.sectionValue.width ?? 8, B.sectionValue.width ?? 8), thickness: Math.min(A.sectionValue.thickness, B.sectionValue.thickness) };
      const radius = j.blendValue?.radius ?? sec.width / 2;
      try {
        const path = new SurfacePath(C, [C.norm(pa), C.norm(pb)]);
        const d = v3.dist(C.pointAt(pa), C.pointAt(pb));
        const shape = d < 1e-6 ? padAt(C, pa, sec, radius) : bandSolid(C, path, sec, 'round', Math.max(8, Math.ceil(d / 2)));
        joinGeoms.push({ name: jn, shape });
      } catch (e: any) { diags.push({ code: 'join.buildFailed', severity: 'error', message: e?.message ?? String(e), join: jn }); }
    }
    const all = [...parts, ...joinGeoms].map((p) => p.shape);
    const shape = (all.length ? union(all) : cylinder(0.01, 0.01)).named(this.name).withMeta({ surfaceBody: { name: this.name, members: parts.map((p) => p.name), joins: joinGeoms.map((j) => j.name) } });
    return { shape, diagnostics: diags, ok: !diags.some((d) => d.severity === 'error'), graph: { carrier: C.kind, members: [...this.members.values()].map((m) => ({ name: m.name, kind: m.kindValue, anchors: Object.keys(m.anchors), features: m.features.map((f) => f.name ?? f.type) })), joins: joinGeoms.map((j) => j.name) }, parts: [...parts, ...joinGeoms] };
  }
  /** The body plus markers: anchors (spheres), member centrelines (thin tubes) and frame axes. */
  buildDebug() {
    const r = this.buildWithDiagnostics(), C = this.carrierValue!, markers: { name: string; shape: Shape }[] = [];
    for (const m of this.members.values()) {
      for (const [k, c] of Object.entries(m.anchors)) markers.push({ name: `anchor ${m.name}.${k}`, shape: cylinder(2, 1.2).translate(...C.pointAt(c)).color('#ff3b30') });
      if (m.pathValue) { const pts = m.pathValue.sample(24).map((s) => v3.add(s.point, v3.scale(s.frame.normal, 0.2))); markers.push({ name: `centreline ${m.name}`, shape: tubeSolid(pts, () => 0.3, { radialSamples: 2 }).color('#0a84ff') }); }
      const c0 = m.pathValue ? m.pathValue.coordinateAt(0) : m.anchorAtPos;
      if (c0) { const f = C.frameAt(c0); for (const [ax, col] of [[f.tangentAlong, '#ff3b30'], [f.tangentAcross, '#34c759'], [f.normal, '#0a84ff']] as const) markers.push({ name: `frame ${m.name}`, shape: tubeSolid([f.point, v3.add(f.point, v3.scale(ax, 6))], () => 0.25, { radialSamples: 2 }).color(col) }); }
    }
    return { ...r, debug: group([{ name: this.name, shape: r.shape }, ...markers]) };
  }
}
function mirrored(src: SurfaceMemberBuilder, dst: SurfaceMemberBuilder): SurfaceMemberBuilder {
  const C = src.body.carrierValue!;
  const m = new SurfaceMemberBuilder(dst.body, dst.name);
  Object.assign(m, { kindValue: src.kindValue, sizeWH: src.sizeWH, sectionValue: src.sectionValue, capStyle: src.capStyle, features: [...src.features, ...dst.features], profiles: src.profiles });
  m.anchorAtPos = src.anchorAtPos != null ? C.mirrorCoordinate(src.anchorAtPos?.coordinate ?? src.anchorAtPos) : undefined;
  m.pathValue = src.pathValue?.mirror();
  m.anchors = Object.fromEntries(Object.entries(src.anchors).map(([k, c]) => [k, C.mirrorCoordinate(c)]));
  Object.assign(m.anchors, dst.anchors);
  return m;
}
function closestEnds(C: AnyCarrier, a: { a: any; b: any }, b: { a: any; b: any }) {
  let best = { d: Infinity, a: null as any, b: null as any };
  for (const x of [a.a, a.b]) for (const y of [b.a, b.b]) { const d = v3.dist(C.pointAt(x), C.pointAt(y)); if (d < best.d) best = { d, a: x, b: y }; }
  return best;
}
function sectionAt(sec: MemberSection, t: number) {
  let w = sec.width ?? 8, th = sec.thickness;
  if (sec.stations?.length) { const st = [...sec.stations].sort((a, b) => a.t - b.t); const ws = st.filter((s) => s.width != null), ts = st.filter((s) => s.thickness != null); if (ws.length) w = interpStations(ws.map((s) => [s.t, s.width!]), t); if (ts.length) th = interpStations(ts.map((s) => [s.t, s.thickness!]), t); }
  return { w, th };
}
function interpStations(s: [number, number][], t: number) { if (t <= s[0][0]) return s[0][1]; for (let i = 1; i < s.length; i++) if (t <= s[i][0]) return s[i - 1][1] + ((s[i][1] - s[i - 1][1]) * (t - s[i - 1][0])) / (s[i][0] - s[i - 1][0] || 1); return s[s.length - 1][1]; }
/** Rounded-rectangle section corners in (across, normal) coordinates. */
function sectionLoop(w: number, th: number, r: number, k = 3): Vec2[] {
  const rr = Math.max(0, Math.min(r, w / 2 - 1e-3, th / 2 - 1e-3));
  if (rr <= 0) return [[-w / 2, 0], [w / 2, 0], [w / 2, th], [-w / 2, th]];
  const out: Vec2[] = [], corners: [number, number, number][] = [[w / 2 - rr, rr, -90], [w / 2 - rr, th - rr, 0], [-w / 2 + rr, th - rr, 90], [-w / 2 + rr, rr, 180]];
  for (const [cx, cy, a0] of corners) for (let i = 0; i <= k; i++) { const a = ((a0 + (90 * i) / k) * Math.PI) / 180; out.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
  return out;
}
function bandSolid(C: AnyCarrier, path: SurfacePath, sec: MemberSection, cap: 'round' | 'flat', samples = 48): Shape {
  const S = path.sample(Math.max(3, samples));
  const dir = sec.direction === 'inward' ? -1 : 1;
  const loops = S.map((s) => { const { w, th } = sectionAt(sec, s.t); return sectionLoop(w, th, sec.edgeRadius ?? 0); });
  const nLoop = Math.max(...loops.map((l) => l.length));
  const loopsN = loops.map((l) => (l.length === nLoop ? l : sectionLoop(sectionAt(sec, 0).w, sectionAt(sec, 0).th, 0)));
  const rings: Vec3[][] = S.map((s, i) => {
    const a = S[Math.max(0, i - 1)].point, b = S[Math.min(S.length - 1, i + 1)].point;
    const n = s.frame.normal, T = v3.norm(v3.sub(b, a)), side = v3.norm(v3.cross(n, T));
    const base = v3.sub(s.point, v3.scale(n, dir * 0.05));
    return loopsN[i].map(([x, y]) => v3.add(v3.add(base, v3.scale(side, x)), v3.scale(n, dir * y)));
  });
  let shape = solidFromRings(rings, { first: loopsN[0], last: loopsN[loopsN.length - 1] }, path.closedValue && false);
  if (cap === 'round' && !path.closedValue) for (const s of [S[0], S[S.length - 1]]) shape = shape.add(padAt(C, s.coordinate, { width: sectionAt(sec, s.t).w, thickness: sectionAt(sec, s.t).th, direction: sec.direction }, sectionAt(sec, s.t).w / 2));
  return shape;
}
function padAt(C: AnyCarrier, c: any, sec: MemberSection, radius: number): Shape {
  const f = C.frameAt(c), dir = sec.direction === 'inward' ? -1 : 1;
  const disc = cylinder(sec.thickness + 0.05, radius, undefined, 32).translate(0, 0, dir > 0 ? -0.05 : -sec.thickness);
  return disc.transform(f.matrix);
}
function plateSolid(C: AnyCarrier, m: SurfaceMemberBuilder, n = 16): Shape {
  const [w, h] = m.sizeWH, center = C.norm(m.anchorAtPos?.coordinate ?? m.anchorAtPos), th = m.sectionValue.thickness, dir = m.sectionValue.direction === 'inward' ? -1 : 1;
  const inner: Vec3[][] = [], outer: Vec3[][] = [];
  for (let i = 0; i <= n; i++) { const ri: Vec3[] = [], ro: Vec3[] = []; for (let j = 0; j <= n; j++) { const c = C.shift(center, (j / n - 0.5) * h, (i / n - 0.5) * w); const p = C.pointAt(c), nn = C.normalAt(c); ri.push(v3.sub(p, v3.scale(nn, dir * 0.05))); ro.push(v3.add(p, v3.scale(nn, dir * th))); } inner.push(ri); outer.push(ro); }
  return gridSolid(inner, outer);
}
function gridSolid(A: Vec3[][], B: Vec3[][]): Shape {
  const n = A.length - 1, m = A[0].length - 1, verts: number[] = [], tris: number[] = [];
  const id = (layer: number, i: number, j: number) => layer * (n + 1) * (m + 1) + i * (m + 1) + j;
  for (const G of [A, B]) for (const row of G) for (const p of row) verts.push(p[0], p[1], p[2]);
  const q = (a: number, b: number, c: number, d: number) => tris.push(a, b, c, a, c, d);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { q(id(1, i, j), id(1, i + 1, j), id(1, i + 1, j + 1), id(1, i, j + 1)); q(id(0, i, j), id(0, i, j + 1), id(0, i + 1, j + 1), id(0, i + 1, j)); }
  for (let j = 0; j < m; j++) { q(id(0, 0, j), id(1, 0, j), id(1, 0, j + 1), id(0, 0, j + 1)); q(id(0, n, j), id(0, n, j + 1), id(1, n, j + 1), id(1, n, j)); }
  for (let i = 0; i < n; i++) { q(id(0, i, 0), id(0, i + 1, 0), id(1, i + 1, 0), id(1, i, 0)); q(id(0, i, m), id(1, i, m), id(1, i + 1, m), id(0, i + 1, m)); }
  return meshToShape(verts, tris);
}
function meshToShape(verts: number[], tris: number[]): Shape { return meshSolidLocal(verts, tris); }
function meshSolidLocal(verts: number[], tris: number[]): Shape {
  const k = K();
  const build = () => { const mesh = new k.Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tris) }); mesh.merge(); return new k.Manifold(mesh); };
  let m = build();
  if (m.volume() < 0) { for (let i = 0; i < tris.length; i += 3) [tris[i + 1], tris[i + 2]] = [tris[i + 2], tris[i + 1]]; m = build(); }
  return new Shape(m);
}
function featureCutter(C: AnyCarrier, base: any, f: MemberFeature, thickness: number, dir: number): Shape {
  const c = C.shift(base, f.along ?? 0, f.across ?? 0), fr = C.frameAt(c), deep = thickness + 4;
  let cut: Shape;
  if (f.type === 'counterbore') {
    const hole = cylinder(deep * 2, (f.clearanceDiameter ?? 4.5) / 2, undefined, 32).translate(0, 0, -deep);
    const cb = cylinder((f.depth ?? 2) + 2, (f.counterboreDiameter ?? 8) / 2, undefined, 32).translate(0, 0, dir > 0 ? thickness - (f.depth ?? 2) : -thickness - 2 + (f.depth ?? 2));
    cut = hole.add(cb);
  } else {
    const w = f.width ?? 5, L = Math.max(w, (f.length ?? w) + (f.verticalTravel ?? 0));
    const pts: Vec2[] = [];
    for (let i = 0; i <= 12; i++) { const a = -Math.PI / 2 + (Math.PI * i) / 12; pts.push([(w / 2) * Math.cos(a), (L - w) / 2 + (w / 2) * Math.sin(a) + w / 2 - w / 2]); }
    for (let i = 0; i <= 12; i++) { const a = Math.PI / 2 + (Math.PI * i) / 12; pts.push([(w / 2) * Math.cos(a), -(L - w) / 2 + (w / 2) * Math.sin(a)]); }
    const stadium = polygon(pts.map(([x, y]) => [y, x] as Vec2)); // long axis along the member (local X = tangentAlong)
    cut = stadium.extrude(deep * 2).translate(0, 0, -deep);
  }
  return cut.transform(fr.matrix);
}
function buildMember(C: AnyCarrier, m: SurfaceMemberBuilder, diags: Diagnostic[]) {
  const dir = m.sectionValue.direction === 'inward' ? -1 : 1;
  let shape: Shape, start: any, end: any, base: any;
  if (m.kindValue === 'plate') {
    if (m.anchorAtPos == null) { diags.push({ code: 'region.noCenter', severity: 'error', message: `plate "${m.name}" needs .at(anchor)`, member: m.name }); return null; }
    base = C.norm(m.anchorAtPos?.coordinate ?? m.anchorAtPos);
    if (!C.inBounds(base)) diags.push({ code: 'region.centerOutOfBounds', severity: 'warning', message: `plate "${m.name}" is centred outside the carrier bounds`, member: m.name });
    shape = plateSolid(C, m); start = end = base;
  } else {
    if (!m.pathValue) { diags.push({ code: 'member.noPath', severity: 'error', message: `band "${m.name}" needs .path(...)`, member: m.name }); return null; }
    if (m.pathValue.points.length < 2) { diags.push({ code: 'member.shortPath', severity: 'error', message: `band "${m.name}" path needs at least two points`, member: m.name }); return null; }
    for (const p of m.pathValue.points) if (!C.inBounds(p)) { diags.push({ code: 'path.outOfBounds', severity: 'warning', message: `band "${m.name}" leaves the carrier bounds`, member: m.name }); break; }
    shape = bandSolid(C, m.pathValue, m.sectionValue, m.capStyle, Math.max(16, Math.ceil(m.pathValue.length() / 2)));
    start = m.pathValue.coordinateAt(0); end = m.pathValue.coordinateAt(1); base = start;
  }
  if (m.features.length) {
    const featureBase = m.kindValue === 'plate' ? base : m.pathValue!.coordinateAt(0);
    const cutters = m.features.map((f) => featureCutter(C, featureBase, f, m.sectionValue.thickness, dir));
    shape = shape.subtract(...cutters);
  }
  if (m.sectionValue.material) shape = shape.material(typeof m.sectionValue.material === 'string' ? (BaseProduct.materials as any)[m.sectionValue.material] ?? {} : m.sectionValue.material);
  return { shape: shape.named(m.name), start, end };
}
/** SurfaceBody(name) starts a member body on a carrier. */
export function SurfaceBodyFn(name: any, ...rest: any[]): any {
  if (typeof name === 'string' || name == null) return new SurfaceBodyBuilder(name ?? 'body');
  return new SheetBody(name, ...rest);
}
export const SurfaceMembers = {
  ...BaseMembers,
  /** roundedSlot({ length, width }) → builder; roundedSlot(carrier, { u, v, ... }) → older cutter. */
  roundedSlot: (a?: any, o?: any): any => (a?.sheet ? BaseMembers.roundedSlot(a, o) : new RoundedSlotBuilder(a)),
  counterbore: (a?: any, o?: any): any => (a?.sheet ? BaseMembers.counterbore(a, o) : new CounterboreBuilder(a)),
  ribs: (a: any, o?: any): any => (a?.sheet ? BaseMembers.ribs(a, o) : { type: 'ribs', count: a?.count ?? 3, height: a?.height ?? 3, width: a?.width ?? a?.thickness ?? 1.5 }),
};
export { SheetBody, OldSkin };

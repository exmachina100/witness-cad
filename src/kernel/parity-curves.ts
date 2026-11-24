// ForgeCAD-shaped curve objects and slice constructions layered on curves.ts:
// Fit/Nurbs/Helix curves expose their defining data, Curve.Bridge returns a
// continuity builder, and Shape.slicePerpendicularTo*/sliceThrough/sliceOnFrame
// accept (position, profile) to build slice stations for Shape.fromSlices.
import { mat4, Mat4, toVec3, v3, Vec2, Vec3 } from './math';
import { Shape } from './shape';
import { Sketch } from './sketch';
import { Curve, Curve3D, hermite, outerLoop, solidFromRings } from './curves';
import { ForgeError } from './errors';

export class BridgeCurve extends Curve3D {
  constructor(readonly start: { point: Vec3; tangent: Vec3; curvature?: number }, readonly end: { point: Vec3; tangent: Vec3; curvature?: number },
    readonly bulgeValue = 1, readonly continuity: 'G0' | 'G1' | 'G2' = 'G1') {
    super(BridgeCurve.evaluator(start, end, bulgeValue, continuity), false, 48);
  }
  static evaluator(s: { point: Vec3; tangent: Vec3 }, e: { point: Vec3; tangent: Vec3 }, bulge: number, c: string) {
    const p0 = s.point, p1 = e.point, L = v3.dist(p0, p1);
    if (c === 'G0') return (t: number) => v3.lerp(p0, p1, t);
    const m0 = v3.scale(v3.norm(s.tangent), L * bulge), m1 = v3.scale(v3.norm(e.tangent), L * bulge);
    if (c === 'G1') return hermite(p0, m0, p1, m1);
    // G2: quintic Hermite with zero second derivative at the ends (curvature-continuous to straight / tangent arcs).
    return (t: number): Vec3 => {
      const t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
      const h0 = 1 - 10 * t3 + 15 * t4 - 6 * t5, h1 = t - 6 * t3 + 8 * t4 - 3 * t5, h4 = -4 * t3 + 7 * t4 - 3 * t5, h5 = 10 * t3 - 15 * t4 + 6 * t5;
      return [0, 1, 2].map((k) => h0 * p0[k] + h1 * m0[k] + h4 * m1[k] + h5 * p1[k]) as Vec3;
    };
  }
  bulge(k: number) { return new BridgeCurve(this.start, this.end, k, this.continuity); }
  g0() { return new BridgeCurve(this.start, this.end, this.bulgeValue, 'G0'); }
  g1() { return new BridgeCurve(this.start, this.end, this.bulgeValue, 'G1'); }
  g2() { return new BridgeCurve(this.start, this.end, this.bulgeValue, 'G2'); }
}

function bridgeEnd(x: any, atDefault: number, outgoing: boolean): { point: Vec3; tangent: Vec3 } {
  if (x instanceof Curve3D) x = { curve: x };
  if (x?.curve) {
    const at = x.at ?? (x.end === 'start' ? 0 : x.end === 'end' ? 1 : atDefault);
    let tan = x.curve.tangentAt(at);
    if (outgoing ? at < 0.5 : at > 0.5) tan = v3.scale(tan, -1);
    return { point: x.curve.pointAt(at), tangent: tan };
  }
  if (Array.isArray(x)) return { point: toVec3(x), tangent: [0, 0, 0] };
  if (x?.point) return { point: toVec3(x.point), tangent: toVec3(x.tangent ?? x.direction ?? [0, 0, 0]) };
  throw new ForgeError('CURVE.BRIDGE', 'Curve.Bridge ends need { point, tangent } or { curve, at }');
}

const withProps = <T extends object>(c: T, props: Record<string, any>): T => {
  for (const [k, v] of Object.entries(props)) Object.defineProperty(c, k, { value: v, enumerable: true, configurable: true });
  return c;
};

// Slice stations for Shape.fromSlices.
export interface SliceStation { kind: 'slice'; on: 'x' | 'y' | 'z' | 'plane' | 'frame'; at?: number; profile: Sketch; frame: Mat4 }
const axisFrame = (axis: 'x' | 'y' | 'z', at: number): Mat4 =>
  axis === 'x' ? mat4.fromFrame([0, 1, 0], [0, 0, 1], [1, 0, 0], [at, 0, 0])
    : axis === 'y' ? mat4.fromFrame([0, 0, 1], [1, 0, 0], [0, 1, 0], [0, at, 0])
      : mat4.fromFrame([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, at]);
function planeFrame(center: Vec3, normal: Vec3, xHint?: Vec3): Mat4 {
  const z = v3.norm(normal);
  let x = xHint ? toVec3(xHint) : Math.abs(z[2]) < 0.9 ? v3.norm(v3.cross([0, 0, 1], z)) : [1, 0, 0] as Vec3;
  x = v3.norm(v3.sub(x, v3.scale(z, v3.dot(x, z))));
  return mat4.fromFrame(x, v3.cross(z, x), z, center);
}
function anyFrame(f: any): Mat4 {
  if (Array.isArray(f) && f.length === 16) return f as Mat4;
  if (f?.matrix) return f.matrix;
  const o = toVec3(f.origin ?? f.point ?? [0, 0, 0]);
  const z = toVec3(f.z ?? f.normal ?? f.zAxis ?? [0, 0, 1]);
  return planeFrame(o, z, f.x ?? f.xAxis ?? f.tangentAlong);
}
const asSketch = (p: any): Sketch => (p instanceof Sketch ? p : p?.toSketch ? p.toSketch() : p?.sketch ?? p);

export function stationsToSolid(list: SliceStation[], o: { samples?: number; smooth?: boolean } = {}): Shape {
  if (list.length < 2) throw new ForgeError('SLICES.ARITY', 'Shape.fromSlices needs at least two slices');
  const N = o.samples ?? 96;
  const loops = list.map((s) => outerLoop(s.profile, N));
  const place = (i: number, p: Vec2) => mat4.apply(list[i].frame, [p[0], p[1], 0]);
  const rings: Vec3[][] = [];
  const sub = o.smooth === false || list.length < 3 ? 1 : 6;
  for (let i = 0; i < list.length - 1; i++) for (let s = 0; s < sub; s++) {
    const t = s / sub;
    const ring: Vec3[] = [];
    for (let j = 0; j < N; j++) {
      const g = (k: number) => { const kk = Math.max(0, Math.min(list.length - 1, k)); return place(kk, loops[kk][j]); };
      const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
      ring.push(sub === 1 ? v3.lerp(p1, p2, t) : [0, 1, 2].map((c) => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t * t + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t * t * t)) as Vec3);
    }
    rings.push(ring);
  }
  const last = list.length - 1;
  rings.push(loops[last].map((p) => place(last, p)));
  // Caps triangulate in each profile's own 2D frame; ring points keep the same order.
  return solidFromRings(rings, { first: loops[0], last: loops[last] });
}

export function installCurveParity() {
  const C = Curve as any;
  const fit = C.Fit, nurbs = C.Nurbs, helixPath = C.Helix.path, bridge = C.Bridge;
  C.Fit = (points: Vec3[], o: any = {}) => withProps(fit(points, o), { points: points.map((p) => toVec3(p)), tension: o.tension ?? 0.5, closedCurve: !!o.closed });
  C.Nurbs = (points: Vec3[], o: any = {}) => {
    const cps = points.map((p) => toVec3(p));
    const degree = Math.min(o.degree ?? 3, cps.length - 1), n = cps.length + (o.closed ? degree : 0);
    const knots = o.knots ?? (o.closed ? Array.from({ length: n + degree + 1 }, (_, i) => i / (n + degree))
      : Array.from({ length: n + degree + 1 }, (_, i) => (i <= degree ? 0 : i >= n ? 1 : (i - degree) / (n - degree))));
    return withProps(nurbs(points, o), { controlPoints: cps, weights: o.weights ?? cps.map(() => 1), knots, degree });
  };
  C.Helix.path = (o: any) => {
    const pitch = o.pitch ?? (o.height != null && o.turns ? o.height / o.turns : 1);
    const turns = o.turns ?? (o.height != null ? o.height / pitch : 1);
    const c = helixPath(o);
    return withProps(c, {
      radius: o.radius, pitch, turns, height: pitch * turns, startAngle: o.startAngle ?? 0, clockwise: !!o.clockwise,
      ports: { start: { origin: c.pointAt(0), axis: v3.scale(c.tangentAt(0), -1) }, end: { origin: c.pointAt(1), axis: c.tangentAt(1) } },
    });
  };
  C.Helix.withPitchAndTurns = (o: any) => C.Helix.path(o);
  C.Helix.withHeightAndTurns = (o: any) => C.Helix.path({ ...o, pitch: o.height / o.turns });
  C.Helix.withPitchAndHeight = (o: any) => C.Helix.path({ ...o, turns: o.height / o.pitch });
  C.Bridge = (a: any, b?: any, o: any = {}) => {
    if (b === undefined && a?.from && a?.to) { o = a; b = a.to; a = a.from; }
    const s = bridgeEnd(a, 1, true), e = bridgeEnd(b, 0, false);
    if (v3.len(s.tangent) < 1e-9) s.tangent = v3.sub(e.point, s.point);
    if (v3.len(e.tangent) < 1e-9) e.tangent = v3.sub(e.point, s.point);
    const bulge = o.bulge ?? (o.weight != null ? o.weight * 2 : 1);
    const cont = String(o.continuity ?? 'G1').toUpperCase() as any;
    return new BridgeCurve(s, e, bulge, cont === 'G0' || cont === 'G2' ? cont : 'G1');
  };
  C.Bridge.legacy = bridge;

  const S = Shape as any;
  const old = { x: S.slicePerpendicularToX, y: S.slicePerpendicularToY, z: S.slicePerpendicularToZ, through: S.sliceThrough, frame: S.sliceOnFrame, from: S.fromSlices };
  const station = (on: SliceStation['on'], frame: Mat4, profile: any, at?: number): SliceStation => ({ kind: 'slice', on, at, profile: asSketch(profile), frame });
  for (const ax of ['x', 'y', 'z'] as const) {
    const key = `slicePerpendicularTo${ax.toUpperCase()}`;
    S[key] = (a: any, b?: any, _o?: any) => (a instanceof Shape ? (old as any)[ax](a, b) : station(ax, axisFrame(ax, a ?? 0), b, a ?? 0));
  }
  S.sliceThrough = (a: any, b?: any, c?: any, d?: any) => {
    if (a instanceof Shape) return old.through(a, b);
    // sliceThrough(center, normal, profile, { x? }) or sliceThrough({ center|origin, normal }, profile)
    if (!Array.isArray(a) && (a?.normal || a?.origin || a?.center)) return station('plane', planeFrame(toVec3(a.center ?? a.origin ?? [0, 0, 0]), toVec3(a.normal ?? [0, 0, 1]), a.x), b);
    return station('plane', planeFrame(toVec3(a), toVec3(b), d?.x), c);
  };
  S.sliceOnFrame = (a: any, b?: any) => (a instanceof Shape ? old.frame(a, b) : station('frame', anyFrame(a), b));
  S.fromSlices = (slices: any[], heights?: any, o?: any) => {
    if (Array.isArray(slices) && slices.length && slices.every((s) => s?.kind === 'slice' || (s?.profile && (s.on || s.frame)))) {
      const list = slices.map((s: any): SliceStation => s.kind === 'slice' ? s
        : s.frame ? station('frame', anyFrame(s.frame), s.profile)
          : s.on === 'plane' ? station('plane', planeFrame(toVec3(s.center ?? s.origin), toVec3(s.normal), s.x), s.profile)
            : station(s.on, axisFrame(s.on, s.at ?? 0), s.profile, s.at));
      return stationsToSolid(list, (heights && !Array.isArray(heights) ? heights : o) ?? {});
    }
    return old.from(slices, heights);
  };
}

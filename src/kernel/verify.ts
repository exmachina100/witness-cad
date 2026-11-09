// verify.*: executable requirements recorded beside the model.
import { ctx } from './context';
import { Shape, flatShapes } from './shape';
import { v3, toVec3, Vec3 } from './math';
import { featureEdges, triArea } from './mesh';

function rec(kind: string, label: string, pass: boolean, message?: string, actual?: any, expected?: any) {
  ctx().checks.push({ kind, label, pass: !!pass, message, actual, expected });
  return !!pass;
}
const asShape = (s: any): Shape => (s instanceof Shape ? s : flatShapes([s])[0] ?? s);
const num = (n: any) => (typeof n === 'number' ? Number(n.toFixed(4)) : n);

export const verify = {
  that: (label: string, check: boolean | (() => boolean), message?: string) => rec('that', label, typeof check === 'function' ? check() : check, message),
  equal: (label: string, actual: any, expected: any, tol = 1e-6, message?: string) =>
    rec('equal', label, typeof actual === 'number' ? Math.abs(actual - expected) <= tol : JSON.stringify(actual) === JSON.stringify(expected), message ?? `got ${num(actual)}, expected ${num(expected)}`, actual, expected),
  notEqual: (label: string, actual: any, expected: any, tol = 1e-6, message?: string) =>
    rec('notEqual', label, typeof actual === 'number' ? Math.abs(actual - expected) > tol : JSON.stringify(actual) !== JSON.stringify(expected), message ?? `got ${num(actual)}`, actual, expected),
  greaterThan: (label: string, actual: number, min: number, message?: string) => rec('greaterThan', label, actual > min, message ?? `${num(actual)} > ${min}`, actual, min),
  lessThan: (label: string, actual: number, max: number, message?: string) => rec('lessThan', label, actual < max, message ?? `${num(actual)} < ${max}`, actual, max),
  inRange: (label: string, actual: number, min: number, max: number, message?: string) => rec('inRange', label, actual >= min && actual <= max, message ?? `${num(actual)} in [${min}, ${max}]`, actual, [min, max]),
  centersCoincide: (label: string, a: any, b: any, tol = 1e-3) => {
    const ca = asShape(a).center(), cb = asShape(b).center();
    const d = v3.dist(ca, cb);
    return rec('centersCoincide', label, d <= tol, `centres ${num(d)} mm apart`, d, 0);
  },
  connectorDistance: (label: string, target: any, a: string, b: string, expected = 0, tol = 1e-3) => {
    const d = target.connectorDistance ? target.connectorDistance(a, b) : v3.dist(target.connector(a).origin, target.connector(b).origin);
    return rec('connectorDistance', label, Math.abs(d - expected) <= tol, `distance ${num(d)} mm (expected ${expected})`, d, expected);
  },
  notColliding: (label: string, a: any, b: any, _searchLength = 0) => {
    const v = asShape(a).intersect(asShape(b)).volume();
    return rec('notColliding', label, v < 1e-6, v < 1e-6 ? 'no overlap' : `overlap volume ${num(v)} mm³`, v, 0);
  },
  minClearance: (label: string, a: any, b: any, minGap: number, searchLength?: number) => {
    const g = asShape(a).minGap(asShape(b), searchLength ?? minGap * 4 + 1);
    return rec('minClearance', label, g >= minGap, `gap ${num(g)} mm (min ${minGap})`, g, minGap);
  },
  clearanceBetween: (label: string, a: any, b: any, minGap: number, maxGap: number, searchLength?: number) => {
    const g = asShape(a).minGap(asShape(b), searchLength ?? maxGap * 2 + 1);
    return rec('clearanceBetween', label, g >= minGap && g <= maxGap, `gap ${num(g)} mm (want ${minGap}..${maxGap})`, g, [minGap, maxGap]);
  },
  parallel: (label: string, fa: any, fb: any, tolDeg = 0.5) => {
    const ang = angleBetween(fa.normal, fb.normal);
    const dev = Math.min(ang, 180 - ang);
    return rec('parallel', label, dev <= tolDeg, `${num(dev)}° off parallel`, dev, 0);
  },
  perpendicular: (label: string, fa: any, fb: any, tolDeg = 0.5) => {
    const dev = Math.abs(90 - angleBetween(fa.normal, fb.normal));
    return rec('perpendicular', label, dev <= tolDeg, `${num(dev)}° off perpendicular`, dev, 0);
  },
  sameDirection: (label: string, a: any, b: any, tolDeg = 0.5) => {
    const dev = angleBetween(toVec3(a.normal ?? a), toVec3(b.normal ?? b));
    return rec('sameDirection', label, dev <= tolDeg, `${num(dev)}° apart`, dev, 0);
  },
  coplanar: (label: string, fa: any, fb: any, tolDeg = 0.5, tolMm = 0.01) => {
    const ang = angleBetween(fa.normal, fb.normal);
    const off = Math.abs(v3.dot(v3.sub(fb.center, fa.center), fa.normal));
    return rec('coplanar', label, Math.min(ang, 180 - ang) <= tolDeg && off <= tolMm, `offset ${num(off)} mm, angle ${num(ang)}°`, off, 0);
  },
  faceAt: (label: string, face: any, pos: Vec3, tolMm = 0.01) => {
    const off = Math.abs(v3.dot(v3.sub(face.center, toVec3(pos)), face.normal));
    return rec('faceAt', label, off <= tolMm, `face is ${num(off)} mm from target`, off, 0);
  },
  isEmpty: (label: string, s: any) => rec('isEmpty', label, asShape(s).isEmpty(), undefined),
  notEmpty: (label: string, s: any) => rec('notEmpty', label, !asShape(s).isEmpty(), undefined),
  volumeApprox: (label: string, s: any, expected: number, tol = 0.01) => {
    const v = asShape(s).volume();
    const rel = Math.abs(v - expected) / Math.max(1e-9, Math.abs(expected));
    return rec('volumeApprox', label, rel <= tol, `volume ${num(v)} mm³ (expected ${expected})`, v, expected);
  },
  areaApprox: (label: string, s: any, expected: number, tol = 0.01) => {
    const a = asShape(s).surfaceArea();
    const rel = Math.abs(a - expected) / Math.max(1e-9, Math.abs(expected));
    return rec('areaApprox', label, rel <= tol, `area ${num(a)} mm² (expected ${expected})`, a, expected);
  },
  boundingBoxSize: (label: string, s: any, expected: Vec3, tol = 0.01) => {
    const sz = asShape(s).boundingBox().size;
    const ok = sz.every((v, i) => Math.abs(v - expected[i]) <= tol);
    return rec('boundingBoxSize', label, ok, `size ${sz.map(num).join(' x ')}`, sz, expected);
  },
  edgeContinuity: (label: string, s: any, o: { maxAngleDeg?: number } = {}) => {
    const sharp = featureEdges(asShape(s).mesh, o.maxAngleDeg ?? 30).length;
    return rec('edgeContinuity', label, sharp === 0, `${sharp} sharp edges`, sharp, 0);
  },
  noTinyEdges: (label: string, s: any, minLength = 0.01) => {
    const tiny = featureEdges(asShape(s).mesh).filter((e) => v3.dist(e.a, e.b) < minLength).length;
    return rec('noTinyEdges', label, tiny === 0, `${tiny} edges shorter than ${minLength} mm`, tiny, 0);
  },
  noSliverFaces: (label: string, s: any, minArea = 1e-4) => {
    const me = asShape(s).mesh;
    let n = 0;
    for (let t = 0; t < me.indices.length / 3; t++) if (triArea(me, t) < minArea) n++;
    return rec('noSliverFaces', label, n === 0, `${n} sliver triangles`, n, 0);
  },
  noSelfIntersection: (label: string, s: any) => {
    const st = asShape(s).m.status();
    return rec('noSelfIntersection', label, String(st) === 'NoError' || (st as any) === 0, `kernel status ${String(st)}`);
  },
  simReady: (label: string, asset: any, _target = 'mujoco') => {
    const issues: string[] = [];
    const parts = asset?.parts ?? [];
    for (const p of parts) if (!p.shape || p.shape.isEmpty()) issues.push(`${p.name} is empty`);
    if (asset?.joints) for (const j of asset.joints) if (j.type !== 'fixed' && (j.min == null || j.max == null)) issues.push(`joint ${j.name} has no limits`);
    return rec('simReady', label, issues.length === 0, issues.join('; ') || 'ready');
  },
  genus: (label: string, s: any, expected: number) => {
    const g = asShape(s).genus();
    return rec('genus', label, g === expected, `genus ${g}`, g, expected);
  },
};

function angleBetween(a: Vec3, b: Vec3) {
  return (Math.acos(Math.max(-1, Math.min(1, v3.dot(v3.norm(a), v3.norm(b))))) * 180) / Math.PI;
}

/** spec(name, fn): reusable checks that run against shapes on demand. */
export function spec(name: string, check: (...shapes: any[]) => void) {
  return {
    name,
    check: (...shapes: any[]) => {
      const c = ctx();
      const before = c.checks.length;
      try { check(...shapes); } catch (e: any) { c.checks.push({ kind: 'spec', label: name, pass: false, message: e.message }); }
      const results = c.checks.slice(before);
      return { name, pass: results.every((r) => r.pass), results };
    },
  };
}

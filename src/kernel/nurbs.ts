// Small NURBS toolkit: curve and surface interpolation, surfaces of extrusion and revolution, exact
// rational forms of cylinders, cones, spheres and tori, evaluation and closest-point projection.
// Used to record exact free-form surfaces (text, lofts, sweeps, stretched solids) for STEP export.
import { mat4, Mat4, v3, Vec2, Vec3 } from './math';

/** Control points are stored u-major: ctrl[i * nv + j]. Knot vectors are full (with repeated ends). */
export interface NurbsSurface {
  degU: number; degV: number;
  knotsU: number[]; knotsV: number[];
  nu: number; nv: number;
  ctrl: Vec3[];
  weights?: number[];
}
export interface NurbsCurve { deg: number; knots: number[]; ctrl: Vec3[]; weights?: number[] }

// ------------------------------------------------------------------ basis functions

export function findSpan(n: number, p: number, u: number, U: number[]): number {
  // n = number of control points - 1
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let lo = p, hi = n + 1, mid = (lo + hi) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) hi = mid; else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

export function basisFuns(span: number, u: number, p: number, U: number[]): number[] {
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
  return N;
}

// ------------------------------------------------------------------ evaluation

export function evalCurve(c: NurbsCurve, u: number): Vec3 {
  const n = c.ctrl.length - 1;
  const span = findSpan(n, c.deg, u, c.knots);
  const N = basisFuns(span, u, c.deg, c.knots);
  let x = 0, y = 0, z = 0, w = 0;
  for (let k = 0; k <= c.deg; k++) {
    const i = span - c.deg + k;
    const wi = (c.weights?.[i] ?? 1) * N[k];
    const P = c.ctrl[i];
    x += P[0] * wi; y += P[1] * wi; z += P[2] * wi; w += wi;
  }
  return [x / w, y / w, z / w];
}

export function evalSurface(s: NurbsSurface, u: number, v: number): Vec3 {
  const su = findSpan(s.nu - 1, s.degU, u, s.knotsU), sv = findSpan(s.nv - 1, s.degV, v, s.knotsV);
  const Nu = basisFuns(su, u, s.degU, s.knotsU), Nv = basisFuns(sv, v, s.degV, s.knotsV);
  let x = 0, y = 0, z = 0, w = 0;
  for (let a = 0; a <= s.degU; a++) {
    const i = su - s.degU + a;
    for (let b = 0; b <= s.degV; b++) {
      const j = sv - s.degV + b;
      const idx = i * s.nv + j;
      const wi = (s.weights?.[idx] ?? 1) * Nu[a] * Nv[b];
      const P = s.ctrl[idx];
      x += P[0] * wi; y += P[1] * wi; z += P[2] * wi; w += wi;
    }
  }
  return [x / w, y / w, z / w];
}

export const domainU = (s: NurbsSurface): [number, number] => [s.knotsU[s.degU], s.knotsU[s.nu]];
export const domainV = (s: NurbsSurface): [number, number] => [s.knotsV[s.degV], s.knotsV[s.nv]];

function partials(s: NurbsSurface, u: number, v: number): { p: Vec3; du: Vec3; dv: Vec3 } {
  const [u0, u1] = domainU(s), [v0, v1] = domainV(s);
  const hu = (u1 - u0) * 1e-6, hv = (v1 - v0) * 1e-6;
  const ua = Math.max(u0, u - hu), ub = Math.min(u1, u + hu);
  const va = Math.max(v0, v - hv), vb = Math.min(v1, v + hv);
  const p = evalSurface(s, u, v);
  const du = v3.scale(v3.sub(evalSurface(s, ub, v), evalSurface(s, ua, v)), 1 / (ub - ua));
  const dv = v3.scale(v3.sub(evalSurface(s, u, vb), evalSurface(s, u, va)), 1 / (vb - va));
  return { p, du, dv };
}

const samples = new WeakMap<NurbsSurface, { uv: Vec2[]; pts: Vec3[] }>();
function sampleGrid(s: NurbsSurface) {
  let g = samples.get(s);
  if (g) return g;
  const [u0, u1] = domainU(s), [v0, v1] = domainV(s);
  const nU = Math.min(64, Math.max(8, (s.nu - s.degU) * 4 + 4)), nV = Math.min(64, Math.max(8, (s.nv - s.degV) * 4 + 4));
  g = { uv: [], pts: [] };
  for (let i = 0; i <= nU; i++)
    for (let j = 0; j <= nV; j++) {
      const u = u0 + ((u1 - u0) * i) / nU, v = v0 + ((v1 - v0) * j) / nV;
      g.uv.push([u, v]);
      g.pts.push(evalSurface(s, u, v));
    }
  samples.set(s, g);
  return g;
}

/** Closest point on the surface (Gauss-Newton from the nearest sample). */
export function closestOnSurface(s: NurbsSurface, p: Vec3): { p: Vec3; u: number; v: number } {
  const g = sampleGrid(s);
  let best = 0, bd = Infinity;
  for (let i = 0; i < g.pts.length; i++) {
    const q = g.pts[i];
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  let [u, v] = g.uv[best];
  const [u0, u1] = domainU(s), [v0, v1] = domainV(s);
  let cur = evalSurface(s, u, v);
  for (let it = 0; it < 30; it++) {
    const { p: q, du, dv } = partials(s, u, v);
    cur = q;
    const r = v3.sub(p, q);
    const a = v3.dot(du, du), b = v3.dot(du, dv), c = v3.dot(dv, dv);
    const e = v3.dot(r, du), f = v3.dot(r, dv);
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-30) break;
    let dU = (e * c - f * b) / det, dV = (a * f - b * e) / det;
    // damp huge steps
    const lim = 0.25;
    if (Math.abs(dU) > lim * (u1 - u0)) dU = Math.sign(dU) * lim * (u1 - u0);
    if (Math.abs(dV) > lim * (v1 - v0)) dV = Math.sign(dV) * lim * (v1 - v0);
    const nu = Math.min(u1, Math.max(u0, u + dU)), nv = Math.min(v1, Math.max(v0, v + dV));
    if (Math.abs(nu - u) < 1e-14 * (u1 - u0) && Math.abs(nv - v) < 1e-14 * (v1 - v0)) break;
    u = nu; v = nv;
  }
  return { p: evalSurface(s, u, v) ?? cur, u, v };
}

export function surfaceNormal(s: NurbsSurface, u: number, v: number): Vec3 {
  let { du, dv } = partials(s, u, v);
  let n = v3.cross(du, dv);
  if (v3.len(n) < 1e-14) {
    // degenerate point (a pole): step slightly into the domain
    const [u0, u1] = domainU(s), [v0, v1] = domainV(s);
    const uu = u + (u < (u0 + u1) / 2 ? 1 : -1) * (u1 - u0) * 1e-4, vv = v + (v < (v0 + v1) / 2 ? 1 : -1) * (v1 - v0) * 1e-4;
    ({ du, dv } = partials(s, uu, vv));
    n = v3.cross(du, dv);
  }
  return v3.norm(n);
}

export function surfaceBounds(s: NurbsSurface): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of s.ctrl) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  return { min, max };
}

export function transformSurfaceNurbs(s: NurbsSurface, m: Mat4): NurbsSurface {
  return { ...s, ctrl: s.ctrl.map((p) => mat4.apply(m, p)) };
}

// ------------------------------------------------------------------ interpolation

function chordParams(pts: Vec3[]): number[] {
  const u = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) { total += Math.sqrt(v3.dist(pts[i], pts[i - 1])); u.push(total); }
  return u.map((x, i) => (total > 0 ? x / total : i / (pts.length - 1)));
}

function averagedKnots(u: number[], p: number): number[] {
  const n = u.length - 1;
  const U: number[] = [];
  for (let i = 0; i <= p; i++) U.push(0);
  for (let j = 1; j <= n - p; j++) { let s = 0; for (let i = j; i < j + p; i++) s += u[i]; U.push(s / p); }
  for (let i = 0; i <= p; i++) U.push(1);
  return U;
}

function solveDense(A: number[][], B: number[][]): number[][] {
  const n = A.length, m = B[0].length;
  const M = A.map((r, i) => [...r, ...B[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-300) throw new Error('singular interpolation system');
    for (let r = 0; r < n; r++) {
      if (r === c || M[r][c] === 0) continue;
      const f = M[r][c] / d;
      for (let k = c; k < n + m; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r.slice(n).map((x) => x / r[i]));
}

function interpWithParams(pts: Vec3[], u: number[], p: number): { knots: number[]; ctrl: Vec3[] } {
  const n = pts.length - 1;
  const U = averagedKnots(u, p);
  const A: number[][] = [];
  for (let k = 0; k <= n; k++) {
    const row = new Array(n + 1).fill(0);
    const span = findSpan(n, p, u[k], U);
    const N = basisFuns(span, u[k], p, U);
    for (let j = 0; j <= p; j++) row[span - p + j] = N[j];
    A.push(row);
  }
  const X = solveDense(A, pts.map((q) => [q[0], q[1], q[2]]));
  return { knots: U, ctrl: X.map((r) => [r[0], r[1], r[2]] as Vec3) };
}

/** Interpolating B-spline curve (degree up to 3) through the points. */
export function interpolateCurve(pts: Vec3[], maxDeg = 3): NurbsCurve {
  const p = Math.min(maxDeg, pts.length - 1);
  const { knots, ctrl } = interpWithParams(pts, chordParams(pts), p);
  return { deg: p, knots, ctrl };
}

function interpMatrix(u: number[], p: number): { U: number[]; A: number[][] } {
  const n = u.length - 1;
  const U = averagedKnots(u, p);
  const A: number[][] = [];
  for (let k = 0; k <= n; k++) {
    const row = new Array(n + 1).fill(0);
    const span = findSpan(n, p, u[k], U);
    const N = basisFuns(span, u[k], p, U);
    for (let j = 0; j <= p; j++) row[span - p + j] = N[j];
    A.push(row);
  }
  return { U, A };
}

/** Interpolating surface through grid[i][j] (i along u, j along v). */
export function interpolateSurface(grid: Vec3[][], maxDegU = 3, maxDegV = 3): NurbsSurface {
  const nu = grid.length, nv = grid[0].length;
  const pU = Math.min(maxDegU, nu - 1), pV = Math.min(maxDegV, nv - 1);
  // averaged chord parameters
  const uk = new Array(nu).fill(0), vl = new Array(nv).fill(0);
  for (let j = 0; j < nv; j++) { const c = chordParams(grid.map((r) => r[j])); for (let i = 0; i < nu; i++) uk[i] += c[i] / nv; }
  for (let i = 0; i < nu; i++) { const c = chordParams(grid[i]); for (let j = 0; j < nv; j++) vl[j] += c[j] / nu; }
  uk[0] = 0; uk[nu - 1] = 1; vl[0] = 0; vl[nv - 1] = 1;
  // along u: one solve with every column as a right-hand side
  const mu = interpMatrix(uk, pU);
  const Ru = solveDense(mu.A, grid.map((row) => row.flatMap((q) => [q[0], q[1], q[2]])));
  // along v: one solve with every row of the intermediate net as a right-hand side
  const mv = interpMatrix(vl, pV);
  const B: number[][] = [];
  for (let j = 0; j < nv; j++) { const r: number[] = []; for (let i = 0; i < nu; i++) r.push(Ru[i][j * 3], Ru[i][j * 3 + 1], Ru[i][j * 3 + 2]); B.push(r); }
  const X = solveDense(mv.A, B); // X[j][i*3+k]
  const ctrl: Vec3[] = new Array(nu * nv);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) ctrl[i * nv + j] = [X[j][i * 3], X[j][i * 3 + 1], X[j][i * 3 + 2]];
  return { degU: pU, degV: pV, knotsU: mu.U, knotsV: mv.U, nu, nv, ctrl };
}

/** Straight extrusion of a planar curve (given in the XY plane) from z0 to z1: u along the curve, v along z. */
export function extrusionSurface(c: NurbsCurve, z0: number, z1: number): NurbsSurface {
  const ctrl: Vec3[] = [], weights: number[] = [];
  for (let i = 0; i < c.ctrl.length; i++) {
    for (const z of [z0, z1]) { ctrl.push([c.ctrl[i][0], c.ctrl[i][1], z]); weights.push(c.weights?.[i] ?? 1); }
  }
  return { degU: c.deg, degV: 1, knotsU: c.knots, knotsV: [0, 0, 1, 1], nu: c.ctrl.length, nv: 2, ctrl, weights: c.weights ? weights : undefined };
}

const H = Math.SQRT1_2;
const CIRCLE_PTS: Vec2[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0]];
const CIRCLE_W = [1, H, 1, H, 1, H, 1, H, 1];
const CIRCLE_KNOTS = [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1];

/** Full revolution about Z of a profile curve whose points are (radius, z) in x and y: u around, v along the profile. */
export function revolutionSurface(profile: NurbsCurve): NurbsSurface {
  const nv = profile.ctrl.length;
  const ctrl: Vec3[] = [], weights: number[] = [];
  for (let i = 0; i < 9; i++)
    for (let j = 0; j < nv; j++) {
      const [r, z] = profile.ctrl[j];
      ctrl.push([r * CIRCLE_PTS[i][0], r * CIRCLE_PTS[i][1], z]);
      weights.push(CIRCLE_W[i] * (profile.weights?.[j] ?? 1));
    }
  return { degU: 2, degV: profile.deg, knotsU: CIRCLE_KNOTS, knotsV: profile.knots, nu: 9, nv, ctrl, weights };
}

/** Rational circle arc profile (in x, y) as a NURBS curve: full circle or a half circle from -90 to +90 deg. */
function circleCurve(c: Vec2, r: number, half = false): NurbsCurve {
  if (half) {
    const pts: Vec2[] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1]];
    return { deg: 2, knots: [0, 0, 0, 0.5, 0.5, 1, 1, 1], ctrl: pts.map(([x, y]) => [c[0] + r * x, c[1] + r * y, 0] as Vec3), weights: [1, H, 1, H, 1] };
  }
  return { deg: 2, knots: CIRCLE_KNOTS, ctrl: CIRCLE_PTS.map(([x, y]) => [c[0] + r * x, c[1] + r * y, 0] as Vec3), weights: CIRCLE_W };
}

const lineCurve = (a: Vec2, b: Vec2): NurbsCurve => ({ deg: 1, knots: [0, 0, 1, 1], ctrl: [[a[0], a[1], 0], [b[0], b[1], 0]] });

/** Local frame matrix: z along axis, x along a perpendicular, origin at o. */
export function axisFrame(o: Vec3, axis: Vec3): Mat4 {
  const z = v3.norm(axis), x = v3.perp(z), y = v3.cross(z, x);
  return mat4.fromFrame(x, y, z, o);
}

export const nurbsCylinder = (o: Vec3, axis: Vec3, r: number, h0: number, h1: number) =>
  transformSurfaceNurbs(revolutionSurface(lineCurve([r, h0], [r, h1])), axisFrame(o, axis));
export const nurbsCone = (o: Vec3, axis: Vec3, r: number, slope: number, h0: number, h1: number) =>
  transformSurfaceNurbs(revolutionSurface(lineCurve([Math.max(0, r + slope * h0), h0], [Math.max(0, r + slope * h1), h1])), axisFrame(o, axis));
export const nurbsSphere = (c: Vec3, r: number) => transformSurfaceNurbs(revolutionSurface(circleCurve([0, 0], r, true)), mat4.translation(c[0], c[1], c[2]));
export const nurbsTorus = (c: Vec3, axis: Vec3, R: number, r: number) => transformSurfaceNurbs(revolutionSurface(circleCurve([R, 0], r)), axisFrame(c, axis));

/** Max distance between the surface and the bilinear patches through a grid it interpolates (sampled). */
export function interpolationError(s: NurbsSurface, grid: Vec3[][]): number {
  let err = 0;
  const stepI = Math.max(1, Math.floor(grid.length / 12)), stepJ = Math.max(1, Math.floor(grid[0].length / 12));
  for (let i = 0; i + 1 < grid.length; i += stepI)
    for (let j = 0; j + 1 < grid[0].length; j += stepJ) {
      const m = v3.scale(v3.add(v3.add(grid[i][j], grid[i + 1][j]), v3.add(grid[i][j + 1], grid[i + 1][j + 1])), 0.25);
      err = Math.max(err, v3.dist(m, closestOnSurface(s, m).p));
    }
  return err;
}

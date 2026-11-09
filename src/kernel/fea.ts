// Linear static finite element analysis on a voxel hexahedral mesh.
//
// The solid is sampled onto a regular grid of box elements (cell centres tested against the
// triangle mesh with scanline ray parity). Every element is the same box, so one element
// stiffness matrix serves the whole model. Elements are 8-node trilinear hexes enriched with
// nine incompatible (bubble) modes that are condensed out per element, which removes most of
// the shear locking plain linear hexes show in bending. The global system K u = f is solved
// matrix-free with Jacobi-preconditioned conjugate gradients. Stresses are recovered at element
// corners, averaged at nodes and reported as von Mises.
//
// Units: mm, N, MPa (N/mm^2), kg/m^3 for density, m/s^2 for gravity.
import type { Vec3 } from './math';
import type { TriMesh } from './mesh';

export interface FeaMaterialProps { youngsModulusMPa: number; poissonRatio: number; yieldStrengthMPa?: number; densityKgM3?: number; name?: string }

/** Where a fixture or load acts. All selections pick nodes on the outer surface of the mesh. */
export type FeaRegion =
  | { kind: 'plane'; point: Vec3; normal: Vec3; tolerance?: number; /** limit to a rectangle on the plane */ rect?: { center: Vec3; u: Vec3; v: Vec3; size: [number, number] }; area?: number; label?: string }
  | { kind: 'box'; min: Vec3; max: Vec3; label?: string }
  | { kind: 'sphere'; center: Vec3; radius: number; label?: string }
  | { kind: 'side'; side: 'xmin' | 'xmax' | 'ymin' | 'ymax' | 'zmin' | 'zmax'; label?: string }
  | { kind: 'cylinder'; center: Vec3; axis: Vec3; radius: number; tolerance?: number; label?: string };

export type FeaFixture = { region: FeaRegion; /** constrained directions, default all three */ dofs?: ('x' | 'y' | 'z')[] };

export type FeaLoad =
  | { kind: 'force'; region: FeaRegion; force: Vec3 }
  | { kind: 'pressure'; region: FeaRegion; mpa: number }
  | { kind: 'torque'; region: FeaRegion; axis: Vec3; nmm: number; origin?: Vec3 }
  | { kind: 'gravity'; acceleration?: Vec3 };

export interface FeaOptions {
  /** Approximate number of elements to aim for (default 12000). */
  targetElements?: number;
  /** Element edge length in mm; overrides targetElements. */
  elementSize?: number;
  /** Minimum element layers across the thinnest bounding-box axis (default 3). */
  minLayers?: number;
  maxIterations?: number;
  tolerance?: number;
  /** Required safety factor (yield / max von Mises). */
  targetSafetyFactor?: number;
  /** Include per-vertex result fields for display (default true). */
  fields?: boolean;
}

export interface FeaResult {
  method: 'fea';
  element: 'hex8-incompatible';
  elements: number;
  nodes: number;
  cellSize: Vec3;
  iterations: number;
  converged: boolean;
  relativeResidual: number;
  solveMs: number;
  maxVonMisesMPa: number;
  /** 99th percentile of nodal von Mises: less sensitive to stress singularities at sharp corners and fixtures. */
  p99VonMisesMPa: number;
  maxVonMisesAt: Vec3;
  maxDisplacementMm: number;
  maxDisplacementAt: Vec3;
  safetyFactor: number | null;
  yieldStrengthMPa: number | null;
  pass?: boolean;
  appliedForceN: Vec3;
  reactionForceN: Vec3;
  meshVolumeMm3: number;
  solidVolumeMm3: number;
  fixedNodes: number;
  loadedNodes: number;
  warnings: string[];
  /** Per-vertex fields on the input triangle mesh (only when options.fields !== false). */
  field?: { positions: Float32Array; indices: Uint32Array; vonMises: Float32Array; displacement: Float32Array };
}

// ---------------------------------------------------------------- element matrices

const CORNERS: [number, number, number][] = [];
for (let c = 0; c < 2; c++) for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) CORNERS.push([a ? 1 : -1, b ? 1 : -1, c ? 1 : -1]);

function elasticity(E: number, nu: number): Float64Array {
  const lam = (E * nu) / ((1 + nu) * (1 - 2 * nu)), mu = E / (2 * (1 + nu));
  const D = new Float64Array(36);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) D[i * 6 + j] = lam + (i === j ? 2 * mu : 0);
  for (let i = 3; i < 6; i++) D[i * 6 + i] = mu;
  return D;
}

/** Strain-displacement matrix (6 x 33) at a natural point: 24 nodal dofs then 9 incompatible-mode dofs. */
function bMatrix(xi: number, eta: number, zeta: number, h: Vec3): Float64Array {
  const B = new Float64Array(6 * 33);
  const sx = 2 / h[0], sy = 2 / h[1], sz = 2 / h[2];
  const put = (col: number, d: number, gx: number, gy: number, gz: number) => {
    if (d === 0) { B[0 * 33 + col] = gx; B[3 * 33 + col] = gy; B[5 * 33 + col] = gz; }
    else if (d === 1) { B[1 * 33 + col] = gy; B[3 * 33 + col] = gx; B[4 * 33 + col] = gz; }
    else { B[2 * 33 + col] = gz; B[4 * 33 + col] = gy; B[5 * 33 + col] = gx; }
  };
  for (let n = 0; n < 8; n++) {
    const [a, b, c] = CORNERS[n];
    const gx = (a * (1 + b * eta) * (1 + c * zeta)) / 8 * sx;
    const gy = (b * (1 + a * xi) * (1 + c * zeta)) / 8 * sy;
    const gz = (c * (1 + a * xi) * (1 + b * eta)) / 8 * sz;
    for (let d = 0; d < 3; d++) put(n * 3 + d, d, gx, gy, gz);
  }
  const modes: Vec3[] = [[-2 * xi * sx, 0, 0], [0, -2 * eta * sy, 0], [0, 0, -2 * zeta * sz]];
  for (let m = 0; m < 3; m++) for (let d = 0; d < 3; d++) put(24 + m * 3 + d, d, modes[m][0], modes[m][1], modes[m][2]);
  return B;
}

function invert(A: Float64Array, n: number): Float64Array {
  const M = new Float64Array(A), I = new Float64Array(n * n);
  for (let i = 0; i < n; i++) I[i * n + i] = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (p !== c) for (let k = 0; k < n; k++) { [M[c * n + k], M[p * n + k]] = [M[p * n + k], M[c * n + k]]; [I[c * n + k], I[p * n + k]] = [I[p * n + k], I[c * n + k]]; }
    const d = M[c * n + c];
    for (let k = 0; k < n; k++) { M[c * n + k] /= d; I[c * n + k] /= d; }
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = M[r * n + c];
      if (f) for (let k = 0; k < n; k++) { M[r * n + k] -= f * M[c * n + k]; I[r * n + k] -= f * I[c * n + k]; }
    }
  }
  return I;
}

/** Condensed 24x24 stiffness and the 8 corner stress-recovery matrices (6x24 each) for one box element. */
export function hexElement(h: Vec3, E: number, nu: number) {
  const D = elasticity(E, nu);
  const g = 1 / Math.sqrt(3), detJ = (h[0] * h[1] * h[2]) / 8;
  const K = new Float64Array(33 * 33);
  const DB = new Float64Array(6 * 33);
  for (const [a, b, c] of CORNERS) {
    const B = bMatrix(a * g, b * g, c * g, h);
    DB.fill(0);
    for (let i = 0; i < 6; i++) for (let k = 0; k < 6; k++) { const d = D[i * 6 + k]; if (d) for (let j = 0; j < 33; j++) DB[i * 33 + j] += d * B[k * 33 + j]; }
    for (let i = 0; i < 33; i++) for (let j = 0; j < 33; j++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += B[k * 33 + i] * DB[k * 33 + j];
      K[i * 33 + j] += s * detJ;
    }
  }
  const Kaa = new Float64Array(81);
  for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) Kaa[i * 9 + j] = K[(24 + i) * 33 + 24 + j];
  const Kinv = invert(Kaa, 9);
  // R = Kaa^-1 Kau (9 x 24); alpha = -R u
  const R = new Float64Array(9 * 24);
  for (let i = 0; i < 9; i++) for (let j = 0; j < 24; j++) { let s = 0; for (let k = 0; k < 9; k++) s += Kinv[i * 9 + k] * K[(24 + k) * 33 + j]; R[i * 24 + j] = s; }
  const Ke = new Float64Array(576);
  for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) { let s = K[i * 33 + j]; for (let k = 0; k < 9; k++) s -= K[i * 33 + 24 + k] * R[k * 24 + j]; Ke[i * 24 + j] = s; }
  for (let i = 0; i < 24; i++) for (let j = 0; j < i; j++) { const m = (Ke[i * 24 + j] + Ke[j * 24 + i]) / 2; Ke[i * 24 + j] = m; Ke[j * 24 + i] = m; }
  // corner stress: sigma = D (Bu - Ba R) u
  const S: Float64Array[] = [];
  for (const [a, b, c] of CORNERS) {
    const B = bMatrix(a, b, c, h);
    const Bc = new Float64Array(6 * 24);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 24; j++) { let s = B[i * 33 + j]; for (let k = 0; k < 9; k++) s -= B[i * 33 + 24 + k] * R[k * 24 + j]; Bc[i * 24 + j] = s; }
    const Sc = new Float64Array(6 * 24);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 24; j++) { let s = 0; for (let k = 0; k < 6; k++) s += D[i * 6 + k] * Bc[k * 24 + j]; Sc[i * 24 + j] = s; }
    S.push(Sc);
  }
  return { Ke, S };
}

// ---------------------------------------------------------------- voxelisation

interface Grid { origin: Vec3; h: Vec3; n: [number, number, number]; inside: Uint8Array }

function voxelize(mesh: TriMesh, h: Vec3, origin: Vec3, n: [number, number, number]): Grid {
  const [nx, ny, nz] = n;
  const inside = new Uint8Array(nx * ny * nz);
  const P = mesh.positions, I = mesh.indices;
  const rows: number[][] = Array.from({ length: ny * nz }, () => []);
  // jitter the ray rows off exact vertex/edge coordinates
  const jy = h[1] * 1.37e-4, jz = h[2] * 2.11e-4;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ay = P[a + 1], az = P[a + 2], by = P[b + 1], bz = P[b + 2], cy = P[c + 1], cz = P[c + 2];
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - origin[1] - jy) / h[1] - 0.5));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - origin[1] - jy) / h[1] - 0.5));
    const k0 = Math.max(0, Math.ceil((Math.min(az, bz, cz) - origin[2] - jz) / h[2] - 0.5));
    const k1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) - origin[2] - jz) / h[2] - 0.5));
    if (j0 > j1 || k0 > k1) continue;
    const det = (by - ay) * (cz - az) - (cy - ay) * (bz - az);
    if (Math.abs(det) < 1e-18) continue;
    for (let k = k0; k <= k1; k++) {
      const z = origin[2] + (k + 0.5) * h[2] + jz;
      for (let j = j0; j <= j1; j++) {
        const y = origin[1] + (j + 0.5) * h[1] + jy;
        const u = ((y - ay) * (cz - az) - (cy - ay) * (z - az)) / det;
        const v = ((by - ay) * (z - az) - (y - ay) * (bz - az)) / det;
        if (u < 0 || v < 0 || u + v > 1) continue;
        rows[k * ny + j].push(P[a] + u * (P[b] - P[a]) + v * (P[c] - P[a]));
      }
    }
  }
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const xs = rows[k * ny + j];
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((xs[s] - origin[0]) / h[0] - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((xs[s + 1] - origin[0]) / h[0] - 0.5));
      for (let i = i0; i <= i1; i++) inside[(k * ny + j) * nx + i] = 1;
    }
  }
  return { origin, h, n, inside };
}

function meshVolume(mesh: TriMesh) {
  const P = mesh.positions, I = mesh.indices;
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return Math.abs(v) / 6;
}

/** Repeatedly split triangle edges longer than maxEdge at their midpoints (shared midpoints keep the mesh watertight). */
export function refineMesh(mesh: TriMesh, maxEdge: number, maxTris: number): { positions: Float32Array; indices: Uint32Array } {
  let P: number[] = Array.from(mesh.positions);
  let T: number[] = Array.from(mesh.indices);
  const len2 = (a: number, b: number) => (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2;
  const lim = maxEdge * maxEdge;
  for (let pass = 0; pass < 12; pass++) {
    const mids = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const k = a < b ? a + ',' + b : b + ',' + a;
      let m = mids.get(k);
      if (m === undefined) { m = P.length / 3; P.push((P[a * 3] + P[b * 3]) / 2, (P[a * 3 + 1] + P[b * 3 + 1]) / 2, (P[a * 3 + 2] + P[b * 3 + 2]) / 2); mids.set(k, m); }
      return m;
    };
    // mark edges to split, then split each triangle by how many of its edges are marked
    const split = new Set<string>();
    for (let t = 0; t < T.length; t += 3) for (let e = 0; e < 3; e++) { const a = T[t + e], b = T[t + (e + 1) % 3]; if (len2(a, b) > lim) split.add(a < b ? a + ',' + b : b + ',' + a); }
    if (!split.size || T.length / 3 * 4 > maxTris) break;
    const out: number[] = [];
    const has = (a: number, b: number) => split.has(a < b ? a + ',' + b : b + ',' + a);
    for (let t = 0; t < T.length; t += 3) {
      const v = [T[t], T[t + 1], T[t + 2]];
      const s = [has(v[0], v[1]), has(v[1], v[2]), has(v[2], v[0])];
      const n = s.filter(Boolean).length;
      if (n === 0) { out.push(...v); continue; }
      if (n === 3) {
        const a = mid(v[0], v[1]), b = mid(v[1], v[2]), c = mid(v[2], v[0]);
        out.push(v[0], a, c, a, v[1], b, c, b, v[2], a, b, c);
        continue;
      }
      // rotate so the first split edge is v0-v1
      const r = s[0] ? 0 : s[1] ? 1 : 2;
      const w = [v[r], v[(r + 1) % 3], v[(r + 2) % 3]];
      const ss = [s[r], s[(r + 1) % 3], s[(r + 2) % 3]];
      const a = mid(w[0], w[1]);
      if (n === 1) { out.push(w[0], a, w[2], a, w[1], w[2]); continue; }
      if (ss[1]) { const b = mid(w[1], w[2]); out.push(w[0], a, w[2], a, w[1], b, a, b, w[2]); }
      else { const c = mid(w[2], w[0]); out.push(w[0], a, c, a, w[1], w[2], a, w[2], c); }
    }
    T = out;
  }
  return { positions: new Float32Array(P), indices: new Uint32Array(T) };
}

// ---------------------------------------------------------------- solve

const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function solveStaticStress(mesh: TriMesh, material: FeaMaterialProps, fixtures: FeaFixture[], loads: FeaLoad[], opts: FeaOptions = {}): FeaResult {
  const t0 = Date.now();
  const warnings: string[] = [];
  const E = material.youngsModulusMPa, nu = material.poissonRatio ?? 0.3;
  if (!(E > 0)) throw new Error('FEA: material needs youngsModulusMPa > 0');
  if (!(nu > -1 && nu < 0.5)) throw new Error('FEA: poissonRatio must be between -1 and 0.5');
  if (!fixtures.length) throw new Error('FEA: add at least one fixture (Fea.fix.fixed) so the part cannot move freely');
  if (!loads.length) throw new Error('FEA: add at least one load');
  const nVert = mesh.positions.length / 3;
  if (!nVert) throw new Error('FEA: empty mesh');

  // bounding box
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nVert; i++) for (let d = 0; d < 3; d++) { const x = mesh.positions[i * 3 + d]; if (x < lo[d]) lo[d] = x; if (x > hi[d]) hi[d] = x; }
  const size: Vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const solidVolume = meshVolume(mesh);
  const target = opts.targetElements ?? 12000;
  let he = opts.elementSize ?? Math.cbrt(solidVolume / Math.max(100, target));
  const minLayers = opts.minLayers ?? 3;
  he = Math.min(he, Math.max(...size) / 2, Math.min(...size.filter((s) => s > 1e-9)) / minLayers);
  const n: [number, number, number] = [0, 1, 2].map((d) => Math.max(1, Math.round(size[d] / he))) as any;
  const h: Vec3 = [size[0] / n[0], size[1] / n[1], size[2] / n[2]];
  const grid = voxelize(mesh, h, lo, n);
  const [nx, ny, nz] = n;
  const NX = nx + 1, NY = ny + 1;
  const gridNode = (i: number, j: number, k: number) => (k * NY + j) * NX + i;

  // elements and active nodes
  const cells: number[] = [];
  for (let c = 0; c < grid.inside.length; c++) if (grid.inside[c]) cells.push(c);
  if (!cells.length) throw new Error('FEA: the voxel mesh is empty; the part may be too thin for this element size (set mesh.elementSize)');
  const nodeId = new Int32Array(NX * NY * (nz + 1)).fill(-1);
  const conn = new Int32Array(cells.length * 8);
  const nodeGrid: number[] = [];
  for (let e = 0; e < cells.length; e++) {
    const c = cells[e], i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny));
    for (let m = 0; m < 8; m++) {
      const [a, b, cc] = CORNERS[m];
      const g = gridNode(i + (a > 0 ? 1 : 0), j + (b > 0 ? 1 : 0), k + (cc > 0 ? 1 : 0));
      if (nodeId[g] < 0) { nodeId[g] = nodeGrid.length; nodeGrid.push(g); }
      conn[e * 8 + m] = nodeId[g];
    }
  }
  let nn = nodeGrid.length;
  const nodePos = (id: number): Vec3 => { const g = nodeGrid[id]; return [lo[0] + (g % NX) * h[0], lo[1] + (Math.floor(g / NX) % NY) * h[1], lo[2] + Math.floor(g / (NX * NY)) * h[2]]; };

  // surface nodes: corners of element faces not shared with another element
  const surface = new Uint8Array(nn);
  const faceQuads: number[] = [], faceArea: number[] = [];
  const filled = (i: number, j: number, k: number) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && grid.inside[(k * ny + j) * nx + i] === 1;
  for (let e = 0; e < cells.length; e++) {
    const c = cells[e], i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny));
    const nb: [number, number, number, number, number][] = [[-1, 0, 0, 0, -1], [1, 0, 0, 0, 1], [0, -1, 0, 1, -1], [0, 1, 0, 1, 1], [0, 0, -1, 2, -1], [0, 0, 1, 2, 1]];
    for (const [di, dj, dk, ax, sg] of nb) {
      if (filled(i + di, j + dj, k + dk)) continue;
      const quad: number[] = [];
      for (let m = 0; m < 8; m++) if (CORNERS[m][ax] === sg) { surface[conn[e * 8 + m]] = 1; quad.push(nodeGrid[conn[e * 8 + m]]); }
      faceQuads.push(quad[0], quad[1], quad[2], quad[3]); faceArea.push(ax === 0 ? h[1] * h[2] : ax === 1 ? h[0] * h[2] : h[0] * h[1]);
    }
  }

  const hmax = Math.max(...h);
  const select = (r: FeaRegion): number[] => {
    const out: number[] = [];
    for (let id = 0; id < nn; id++) {
      if (!surface[id]) continue;
      const p = nodePos(id);
      let ok = false;
      switch (r.kind) {
        case 'plane': {
          const nrm = norm(r.normal);
          const tol = r.tolerance ?? 0.75 * hmax;
          ok = Math.abs(dot([p[0] - r.point[0], p[1] - r.point[1], p[2] - r.point[2]], nrm)) <= tol;
          if (ok && r.rect) {
            const q: Vec3 = [p[0] - r.rect.center[0], p[1] - r.rect.center[1], p[2] - r.rect.center[2]];
            ok = Math.abs(dot(q, norm(r.rect.u))) <= r.rect.size[0] / 2 + 0.51 * hmax && Math.abs(dot(q, norm(r.rect.v))) <= r.rect.size[1] / 2 + 0.51 * hmax;
          }
          break;
        }
        case 'box': ok = p[0] >= r.min[0] && p[1] >= r.min[1] && p[2] >= r.min[2] && p[0] <= r.max[0] && p[1] <= r.max[1] && p[2] <= r.max[2]; break;
        case 'sphere': ok = Math.hypot(p[0] - r.center[0], p[1] - r.center[1], p[2] - r.center[2]) <= r.radius; break;
        case 'side': {
          const ax = r.side[0] === 'x' ? 0 : r.side[0] === 'y' ? 1 : 2;
          ok = r.side.endsWith('min') ? p[ax] <= lo[ax] + 0.5 * h[ax] : p[ax] >= hi[ax] - 0.5 * h[ax];
          break;
        }
        case 'cylinder': {
          const a = norm(r.axis);
          const q: Vec3 = [p[0] - r.center[0], p[1] - r.center[1], p[2] - r.center[2]];
          const t = dot(q, a);
          const rad = Math.hypot(q[0] - a[0] * t, q[1] - a[1] * t, q[2] - a[2] * t);
          ok = Math.abs(rad - r.radius) <= (r.tolerance ?? 0.9 * hmax);
          break;
        }
      }
      if (ok) out.push(id);
    }
    return out;
  };
  const regionLabel = (r: FeaRegion) => r.label ?? r.kind;

  // fixtures
  const fixed = new Uint8Array(nn * 3);
  let fixedNodes = 0;
  for (const fx of fixtures) {
    const ids = select(fx.region);
    if (!ids.length) { warnings.push(`fixture on ${regionLabel(fx.region)} selected no mesh nodes`); continue; }
    const dofs = (fx.dofs ?? ['x', 'y', 'z']).map((d) => 'xyz'.indexOf(d));
    for (const id of ids) { if (!fixed[id * 3] && !fixed[id * 3 + 1] && !fixed[id * 3 + 2]) fixedNodes++; for (const d of dofs) fixed[id * 3 + d] = 1; }
  }
  if (!fixedNodes) throw new Error('FEA: no fixture touched the part; check the fixture faces');

  // keep only elements connected to a fixture
  {
    const parent = new Int32Array(nn).map((_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let e = 0; e < cells.length; e++) { const r0 = find(conn[e * 8]); for (let m = 1; m < 8; m++) { const r = find(conn[e * 8 + m]); if (r !== r0) parent[r] = r0; } }
    const anchored = new Set<number>();
    for (let id = 0; id < nn; id++) if (fixed[id * 3] || fixed[id * 3 + 1] || fixed[id * 3 + 2]) anchored.add(find(id));
    const keep: number[] = [];
    for (let e = 0; e < cells.length; e++) if (anchored.has(find(conn[e * 8]))) keep.push(e);
    if (keep.length < cells.length) {
      warnings.push(`${cells.length - keep.length} of ${cells.length} elements are not connected to any fixture and were left out`);
      const conn2 = new Int32Array(keep.length * 8), cells2: number[] = [];
      keep.forEach((e, i) => { conn2.set(conn.subarray(e * 8, e * 8 + 8), i * 8); cells2.push(cells[e]); });
      // renumber nodes
      const remap = new Int32Array(nn).fill(-1), grid2: number[] = [];
      for (let q = 0; q < conn2.length; q++) { const o = conn2[q]; if (remap[o] < 0) { remap[o] = grid2.length; grid2.push(nodeGrid[o]); } conn2[q] = remap[o]; }
      const fixed2 = new Uint8Array(grid2.length * 3), surf2 = new Uint8Array(grid2.length);
      for (let o = 0; o < nn; o++) if (remap[o] >= 0) { surf2[remap[o]] = surface[o]; for (let d = 0; d < 3; d++) fixed2[remap[o] * 3 + d] = fixed[o * 3 + d]; }
      nodeGrid.length = 0; nodeGrid.push(...grid2);
      nodeId.fill(-1); grid2.forEach((g, i) => (nodeId[g] = i));
      cells.length = 0; cells.push(...cells2);
      return finish(conn2, fixed2, surf2);
    }
  }
  return finish(conn, fixed, surface);

  function finish(conn: Int32Array, fixed: Uint8Array, surf: Uint8Array): FeaResult {
    nn = nodeGrid.length;
    surface.set(surf.subarray(0, Math.min(surf.length, surface.length)));
    for (let i = surf.length; i < surface.length; i++) surface[i] = 0;
    const ne = cells.length;
    const ndof = nn * 3;
    const f = new Float64Array(ndof);
    let loadedNodes = 0;
    const applied: Vec3 = [0, 0, 0];
    const addForce = (ids: number[], F: Vec3) => {
      // area-weighted: each exposed element face whose four corners are all selected shares its area among them
      const sel = new Set(ids), w = new Map<number, number>();
      let total = 0;
      for (let q = 0; q < faceArea.length; q++) {
        const a = nodeId[faceQuads[q * 4]], b = nodeId[faceQuads[q * 4 + 1]], c = nodeId[faceQuads[q * 4 + 2]], d = nodeId[faceQuads[q * 4 + 3]];
        if (!(sel.has(a) && sel.has(b) && sel.has(c) && sel.has(d))) continue;
        for (const id of [a, b, c, d]) w.set(id, (w.get(id) ?? 0) + faceArea[q] / 4);
        total += faceArea[q];
      }
      if (total > 0) { for (const [id, x] of w) for (let d = 0; d < 3; d++) f[id * 3 + d] += (F[d] * x) / total; }
      else for (const id of ids) for (let d = 0; d < 3; d++) f[id * 3 + d] += F[d] / ids.length;
      for (let d = 0; d < 3; d++) applied[d] += F[d];
      loadedNodes += ids.length;
    };
    const cellVol = h[0] * h[1] * h[2];
    for (const L of loads) {
      if (L.kind === 'gravity') {
        const g = L.acceleration ?? [0, 0, -9.81];
        const rho = (material.densityKgM3 ?? 0) * 1e-9; // kg/mm^3
        if (!rho) { warnings.push('gravity load ignored: material has no density'); continue; }
        const fe: Vec3 = [rho * cellVol * g[0], rho * cellVol * g[1], rho * cellVol * g[2]];
        for (let e = 0; e < ne; e++) for (let m = 0; m < 8; m++) for (let d = 0; d < 3; d++) f[conn[e * 8 + m] * 3 + d] += fe[d] / 8;
        for (let d = 0; d < 3; d++) applied[d] += fe[d] * ne;
        continue;
      }
      const ids = select(L.region);
      if (!ids.length) { warnings.push(`${L.kind} load on ${regionLabel(L.region)} selected no mesh nodes and was skipped`); continue; }
      if (L.kind === 'force') addForce(ids, L.force);
      else if (L.kind === 'pressure') {
        if (L.region.kind !== 'plane') throw new Error('FEA: pressure loads need a face region');
        const nrm = norm(L.region.normal);
        const area = L.region.area && L.region.area > 0 ? L.region.area : estimateFaceArea(ids.length, nrm);
        addForce(ids, [-nrm[0] * L.mpa * area, -nrm[1] * L.mpa * area, -nrm[2] * L.mpa * area]);
      } else if (L.kind === 'torque') {
        const ax = norm(L.axis);
        const o = L.origin ?? centroid(ids);
        let denom = 0;
        const arms = ids.map((id) => {
          const p = nodePos(id), q: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
          const t = dot(q, ax); const r: Vec3 = [q[0] - ax[0] * t, q[1] - ax[1] * t, q[2] - ax[2] * t];
          denom += dot(r, r);
          return r;
        });
        if (denom <= 0) { warnings.push('torque load region lies on its axis and was skipped'); continue; }
        ids.forEach((id, i) => {
          const r = arms[i];
          const c: Vec3 = [ax[1] * r[2] - ax[2] * r[1], ax[2] * r[0] - ax[0] * r[2], ax[0] * r[1] - ax[1] * r[0]];
          for (let d = 0; d < 3; d++) f[id * 3 + d] += (L.nmm * c[d]) / denom;
        });
        loadedNodes += ids.length;
      }
    }
    function estimateFaceArea(count: number, nrm: Vec3) {
      // area per surface node on a face with this normal
      const per = Math.abs(nrm[0]) * h[1] * h[2] + Math.abs(nrm[1]) * h[0] * h[2] + Math.abs(nrm[2]) * h[0] * h[1];
      return count * per;
    }
    function centroid(ids: number[]): Vec3 {
      const c: Vec3 = [0, 0, 0];
      for (const id of ids) { const p = nodePos(id); c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
      return [c[0] / ids.length, c[1] / ids.length, c[2] / ids.length];
    }
    const fFull = new Float64Array(f);
    for (let i = 0; i < ndof; i++) if (fixed[i]) f[i] = 0;

    const { Ke, S } = hexElement(h, E, nu);
    // Jacobi preconditioner
    const diag = new Float64Array(ndof);
    for (let e = 0; e < ne; e++) for (let a = 0; a < 24; a++) diag[conn[e * 8 + ((a / 3) | 0)] * 3 + (a % 3)] += Ke[a * 25];
    const Minv = new Float64Array(ndof);
    for (let i = 0; i < ndof; i++) Minv[i] = fixed[i] || diag[i] <= 0 ? 0 : 1 / diag[i];
    const dofIdx = new Int32Array(ne * 24);
    for (let e = 0; e < ne; e++) for (let a = 0; a < 24; a++) dofIdx[e * 24 + a] = conn[e * 8 + ((a / 3) | 0)] * 3 + (a % 3);
    const ue = new Float64Array(24);
    const matvec = (x: Float64Array, y: Float64Array) => {
      y.fill(0);
      for (let e = 0; e < ne; e++) {
        const base = e * 24;
        for (let a = 0; a < 24; a++) ue[a] = x[dofIdx[base + a]];
        for (let a = 0; a < 24; a++) {
          let s = 0; const row = a * 24;
          for (let b = 0; b < 24; b++) s += Ke[row + b] * ue[b];
          y[dofIdx[base + a]] += s;
        }
      }
      for (let i = 0; i < ndof; i++) if (fixed[i]) y[i] = 0;
    };

    const u = new Float64Array(ndof), r = new Float64Array(f), z = new Float64Array(ndof), p = new Float64Array(ndof), q = new Float64Array(ndof);
    const fn = Math.sqrt(f.reduce((s, x) => s + x * x, 0));
    const tol = opts.tolerance ?? 1e-7;
    const maxIt = opts.maxIterations ?? Math.max(2000, Math.round(20 * Math.cbrt(ndof) * 10));
    let it = 0, rel = fn > 0 ? 1 : 0;
    if (fn > 0) {
      for (let i = 0; i < ndof; i++) { z[i] = Minv[i] * r[i]; p[i] = z[i]; }
      let rz = 0; for (let i = 0; i < ndof; i++) rz += r[i] * z[i];
      for (it = 1; it <= maxIt; it++) {
        matvec(p, q);
        let pq = 0; for (let i = 0; i < ndof; i++) pq += p[i] * q[i];
        if (pq <= 0) { warnings.push('stiffness matrix is not positive definite: the part may not be fully held by its fixtures'); break; }
        const alpha = rz / pq;
        let rr = 0;
        for (let i = 0; i < ndof; i++) { u[i] += alpha * p[i]; r[i] -= alpha * q[i]; rr += r[i] * r[i]; }
        rel = Math.sqrt(rr) / fn;
        if (rel < tol) break;
        let rz2 = 0; for (let i = 0; i < ndof; i++) { z[i] = Minv[i] * r[i]; rz2 += r[i] * z[i]; }
        const beta = rz2 / rz; rz = rz2;
        for (let i = 0; i < ndof; i++) p[i] = z[i] + beta * p[i];
      }
    }
    const converged = rel < Math.max(tol * 10, 1e-5);
    if (!converged) warnings.push(`solver stopped at relative residual ${rel.toExponential(2)} after ${it} iterations; results may be inaccurate (usually a part held only at a point or edge)`);

    // reactions: K u - f at fixed dofs
    const Ku = new Float64Array(ndof);
    {
      for (let e = 0; e < ne; e++) {
        const base = e * 24;
        for (let a = 0; a < 24; a++) ue[a] = u[dofIdx[base + a]];
        for (let a = 0; a < 24; a++) { let s = 0; for (let b = 0; b < 24; b++) s += Ke[a * 24 + b] * ue[b]; Ku[dofIdx[base + a]] += s; }
      }
    }
    const reaction: Vec3 = [0, 0, 0];
    for (let i = 0; i < ndof; i++) if (fixed[i]) reaction[i % 3] += Ku[i] - fFull[i];

    // stresses: corner values averaged at nodes
    const sig = new Float64Array(nn * 6), cnt = new Float64Array(nn);
    for (let e = 0; e < ne; e++) {
      const base = e * 24;
      for (let a = 0; a < 24; a++) ue[a] = u[dofIdx[base + a]];
      for (let m = 0; m < 8; m++) {
        const Sc = S[m], node = conn[e * 8 + m];
        for (let i = 0; i < 6; i++) { let s = 0; for (let b = 0; b < 24; b++) s += Sc[i * 24 + b] * ue[b]; sig[node * 6 + i] += s; }
        cnt[node]++;
      }
    }
    const vm = new Float64Array(nn);
    let maxVm = 0, maxVmAt = 0, maxD = 0, maxDAt = 0;
    for (let id = 0; id < nn; id++) {
      const c = cnt[id] || 1;
      const sx = sig[id * 6] / c, sy = sig[id * 6 + 1] / c, sz = sig[id * 6 + 2] / c, txy = sig[id * 6 + 3] / c, tyz = sig[id * 6 + 4] / c, tzx = sig[id * 6 + 5] / c;
      const v = Math.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) + 3 * (txy * txy + tyz * tyz + tzx * tzx));
      vm[id] = v;
      if (v > maxVm) { maxVm = v; maxVmAt = id; }
      const d = Math.hypot(u[id * 3], u[id * 3 + 1], u[id * 3 + 2]);
      if (d > maxD) { maxD = d; maxDAt = id; }
    }
    const surfVm: number[] = [];
    for (let id = 0; id < nn; id++) if (surface[id]) surfVm.push(vm[id]);
    surfVm.sort((a, b) => a - b);
    const p99 = surfVm.length ? surfVm[Math.min(surfVm.length - 1, Math.floor(surfVm.length * 0.99))] : maxVm;

    const yieldS = material.yieldStrengthMPa ?? null;
    const sf = yieldS != null && maxVm > 0 ? yieldS / maxVm : yieldS != null ? Infinity : null;
    const meshVol = ne * cellVol;
    if (solidVolume > 0 && Math.abs(meshVol - solidVolume) / solidVolume > 0.15) warnings.push(`voxel mesh volume differs from the solid by ${(100 * (meshVol - solidVolume) / solidVolume).toFixed(0)}%; refine the mesh (mesh.elementSize) for thin features`);
    const appliedMag = Math.hypot(...applied), reactMag = Math.hypot(...reaction);
    if (appliedMag > 0 && converged && Math.abs(reactMag - appliedMag) / appliedMag > 0.05 && !loads.some((l) => l.kind === 'torque')) warnings.push('reaction forces do not balance the applied load; some load may act directly on fixed nodes');

    let field: FeaResult['field'];
    if (opts.fields !== false) {
      // display mesh: split long triangle edges so the colour field is sampled about once per element
      const disp = refineMesh(mesh, 1.2 * hmax, 600000);
      const nOut = disp.positions.length / 3;
      const vmOut = new Float32Array(nOut), dOut = new Float32Array(nOut * 3);
      for (let v = 0; v < nOut; v++) {
        const x = disp.positions[v * 3], y = disp.positions[v * 3 + 1], zz = disp.positions[v * 3 + 2];
        const fx = (x - lo[0]) / h[0], fy = (y - lo[1]) / h[1], fz = (zz - lo[2]) / h[2];
        const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
        let wsum = 0, s = 0, dx = 0, dy = 0, dz = 0;
        let best = -1, bestDist = Infinity;
        for (let dk = -1; dk <= 2; dk++) for (let dj = -1; dj <= 2; dj++) for (let di = -1; di <= 2; di++) {
          const i = i0 + di, j = j0 + dj, k = k0 + dk;
          if (i < 0 || j < 0 || k < 0 || i > nx || j > ny || k > nz) continue;
          const id = nodeId[gridNode(i, j, k)];
          if (id < 0) continue;
          const ex = Math.abs(fx - i), ey = Math.abs(fy - j), ez = Math.abs(fz - k);
          const dist = ex + ey + ez;
          if (dist < bestDist) { bestDist = dist; best = id; }
          if (ex >= 1 || ey >= 1 || ez >= 1) continue;
          const w = (1 - ex) * (1 - ey) * (1 - ez);
          wsum += w; s += w * vm[id]; dx += w * u[id * 3]; dy += w * u[id * 3 + 1]; dz += w * u[id * 3 + 2];
        }
        if (wsum > 1e-9) { vmOut[v] = s / wsum; dOut[v * 3] = dx / wsum; dOut[v * 3 + 1] = dy / wsum; dOut[v * 3 + 2] = dz / wsum; }
        else if (best >= 0) { vmOut[v] = vm[best]; dOut[v * 3] = u[best * 3]; dOut[v * 3 + 1] = u[best * 3 + 1]; dOut[v * 3 + 2] = u[best * 3 + 2]; }
      }
      field = { positions: disp.positions, indices: disp.indices, vonMises: vmOut, displacement: dOut };
    }

    const round = (x: number, d = 4) => +x.toPrecision(d);
    const at = (id: number): Vec3 => nodePos(id).map((x) => round(x, 6)) as Vec3;
    return {
      method: 'fea', element: 'hex8-incompatible',
      elements: ne, nodes: nn, cellSize: h.map((x) => round(x)) as Vec3,
      iterations: it, converged, relativeResidual: rel, solveMs: Date.now() - t0,
      maxVonMisesMPa: round(maxVm), p99VonMisesMPa: round(p99), maxVonMisesAt: at(maxVmAt),
      maxDisplacementMm: round(maxD), maxDisplacementAt: at(maxDAt),
      safetyFactor: sf == null ? null : round(sf), yieldStrengthMPa: yieldS,
      pass: opts.targetSafetyFactor != null && sf != null ? sf >= opts.targetSafetyFactor : undefined,
      appliedForceN: applied.map((x) => round(x)) as Vec3, reactionForceN: reaction.map((x) => round(x)) as Vec3,
      meshVolumeMm3: round(meshVol, 6), solidVolumeMm3: round(solidVolume, 6),
      fixedNodes, loadedNodes, warnings, field,
    };
  }
}

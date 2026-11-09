// Rigid-body dynamics for assemblies: every part (or group of parts welded by fixed joints) is a
// rigid body with mass and inertia from its mesh. Joints are solved as constraints between bodies
// (so free-floating bases, closed loops and contacts all work together), colliders are convex
// hulls, and contacts with the ground and between bodies carry friction and restitution.
// The solver is a sequential-impulse velocity solver with Baumgarte position correction and
// semi-implicit Euler integration. Units inside are SI (m, kg, s); the API speaks mm and degrees.
import { ForgeError } from './errors';
import { Shape } from './shape';
import { ShapeGroup, hullPoints } from './ops';
import { mat4, Mat4, toVec3, v3, Vec3 } from './math';
import { connectorFrame, xfConnector } from './shape';
import { jointMotion, Assembly, type Joint, type Part } from './assembly';
import { PhysicalProperties, Sim } from './sim';

// ---------------------------------------------------------------- small math
type M3 = number[]; // row-major 3x3
type Quat = [number, number, number, number]; // w x y z
const m3 = {
  mulV: (m: M3, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]],
  mul: (a: M3, b: M3): M3 => {
    const o = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return o;
  },
  T: (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]],
  inv: (m: M3): M3 => {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-30) return [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const s = 1 / det;
    return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
  },
  zero: (): M3 => [0, 0, 0, 0, 0, 0, 0, 0, 0],
};
const q = {
  mul: (a: Quat, b: Quat): Quat => [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ],
  conj: (a: Quat): Quat => [a[0], -a[1], -a[2], -a[3]],
  norm: (a: Quat): Quat => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l, a[3] / l]; },
  toM3: (a: Quat): M3 => {
    const [w, x, y, z] = a;
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ];
  },
  angleDeg: (a: Quat) => (2 * Math.acos(Math.min(1, Math.abs(a[0]))) * 180) / Math.PI,
};
const G0 = 9.80665;

// ---------------------------------------------------------------- types
export interface SimMaterialProps { mu: number; restitution: number }
interface Hull { verts: Vec3[]; planes: { n: Vec3; d: number }[]; center: Vec3; radius: number }
interface Body {
  id: number; name: string; parts: string[];
  motion: 'dynamic' | 'static' | 'kinematic';
  invM: number; m: number; Ib: M3; invIb: M3; invIw: M3;
  x: Vec3; q: Quat; v: Vec3; w: Vec3;
  com0mm: Vec3; x0: Vec3;
  hulls: Hull[]; mat: SimMaterialProps;
  // world-space cache per step
  wv?: Vec3[][]; wp?: { n: Vec3; d: number }[][]; wc?: Vec3[]; R?: M3;
}
interface Row {
  a: Body | null; b: Body | null;
  // Jacobian: linear direction n applied at rA/rB, or pure angular axis
  lin?: Vec3; ang?: Vec3; rA?: Vec3; rB?: Vec3;
  bias: number; lo: number; hi: number; acc: number; k: number;
  kind: 'joint' | 'limit' | 'motor' | 'friction';
  joint?: string;
}
interface Contact { a: Body | null; b: Body; p: Vec3; n: Vec3; depth: number }

export interface DynamicsOptions {
  duration?: number; dt?: number; iterations?: number;
  gravity?: Vec3 | number; // m/s² vector, or magnitude along -Z
  ground?: boolean | { z?: number; friction?: number; restitution?: number };
  targets?: Record<string, number>; velocities?: Record<string, number>;
  initial?: Record<string, any>;
  bodyVelocities?: Record<string, { linear?: Vec3; angular?: Vec3 }>; // mm/s, deg/s
  loads?: ({ part: string; force: Vec3; at?: Vec3 } | { joint: string; value: number })[];
  ignorePairs?: [string, string][];
  contacts?: boolean; sampleHz?: number; recordContacts?: boolean;
  motion?: Record<string, 'dynamic' | 'static' | 'kinematic'>;
}

export interface DynamicsFrame { t: number; values: Record<string, number>; transforms: Record<string, Mat4>; contacts?: { p: Vec3; n: Vec3; a: string; b: string }[] }

// ---------------------------------------------------------------- body construction
function partShape(p: Part): Shape { return p.shape instanceof Shape ? p.shape : (p.shape as ShapeGroup).toShape(); }

function makeHull(points: Vec3[]): Hull | null {
  if (points.length < 4) return null;
  let shape: Shape;
  try { shape = hullPoints(points); } catch { return null; }
  const me = shape.mesh;
  const verts: Vec3[] = [];
  for (let i = 0; i < me.positions.length; i += 3) verts.push([me.positions[i], me.positions[i + 1], me.positions[i + 2]]);
  if (verts.length < 4) return null;
  const planes: { n: Vec3; d: number }[] = [];
  for (let t = 0; t < me.indices.length; t += 3) {
    const a = verts[me.indices[t]], b = verts[me.indices[t + 1]], c = verts[me.indices[t + 2]];
    const cr = v3.cross(v3.sub(b, a), v3.sub(c, a));
    if (v3.len(cr) < 1e-12) continue;
    const n = v3.norm(cr), d = v3.dot(n, a);
    if (planes.some((pl) => v3.dot(pl.n, n) > 0.99995 && Math.abs(pl.d - d) < 1e-6)) continue;
    planes.push({ n, d });
  }
  const center = v3.scale(verts.reduce((s, v) => v3.add(s, v), [0, 0, 0] as Vec3), 1 / verts.length);
  const radius = Math.max(...verts.map((v) => v3.dist(v, center)));
  return { verts, planes, center, radius };
}

/** World-space (mm) collider point clouds for a part at its initial pose. */
function colliderClouds(p: Part, T: Mat4): Vec3[][] {
  const c = p.sim?.collider ?? { kind: 'convexHull' };
  const world = (pts: Vec3[]) => pts.map((x) => mat4.apply(T, toVec3(x)));
  const meshPts = (s: Shape) => { const me = s.mesh; const out: Vec3[] = []; for (let i = 0; i < me.positions.length; i += 3) out.push([me.positions[i], me.positions[i + 1], me.positions[i + 2]]); return out; };
  switch (c.kind) {
    case 'none': return [];
    case 'capsule': {
      const out: Vec3[] = [];
      const from = toVec3(c.from), to = toVec3(c.to), r = c.radius;
      for (const e of [from, to]) for (let i = 0; i < 10; i++) for (let k = 0; k <= 6; k++) {
        const th = (i / 10) * 2 * Math.PI, ph = (k / 6) * Math.PI;
        out.push([e[0] + r * Math.sin(ph) * Math.cos(th), e[1] + r * Math.sin(ph) * Math.sin(th), e[2] + r * Math.cos(ph)]);
      }
      return [world(out)];
    }
    case 'hull': if (c.points?.length) return [world(c.points)]; break;
    case 'boundingBox': {
      const b = partShape(p).transform(T).boundingBox();
      const out: Vec3[] = [];
      for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
      return [out];
    }
    case 'pieces': case 'convexDecomposition': {
      const pieces = p.shape instanceof ShapeGroup ? p.shape.children.map((ch: any) => (ch.item instanceof Shape ? ch.item : ch.item?.toShape?.())).filter(Boolean) : partShape(p).decompose();
      return pieces.map((s: Shape) => world(meshPts(s.hull())));
    }
  }
  return [world(meshPts(partShape(p).hull()))];
}

function inertiaTensor(i: { ixx: number; iyy: number; izz: number; ixy: number; iyz: number; izx: number }): M3 {
  return [i.ixx, i.ixy, i.izx, i.ixy, i.iyy, i.iyz, i.izx, i.iyz, i.izz];
}

function simMaterial(p: Part): SimMaterialProps {
  const m = p.sim?.material ?? p.sim?.physicalMaterial ?? {};
  return { mu: m.staticFriction ?? m.friction ?? 0.6, restitution: m.restitution ?? 0.1 };
}

// ---------------------------------------------------------------- the world
export class RigidWorld {
  bodies: Body[] = [];
  partBody = new Map<string, Body>();
  partT0 = new Map<string, Mat4>();
  joints: { j: Joint; a: Body | null; b: Body | null; v0: number; pA: Vec3; pB: Vec3; axA: Vec3; axB: Vec3; xA: Vec3; xB: Vec3; yB: Vec3; prev: number; value: number; peak: number; sat: number }[] = [];
  springs: { name: string; a: Body | null; b: Body | null; pA: Vec3; pB: Vec3; spec: any }[] = [];
  gravity: Vec3; groundZ: number | null; groundMat: SimMaterialProps;
  noCollide = new Set<string>();
  warnings: string[] = [];
  base: Record<string, any>;

  constructor(public asm: Assembly, public o: DynamicsOptions = {}) {
    const solved = asm.solve(o.initial ? { ...asm.resolveState(), ...o.initial } : undefined);
    this.base = solved.getJointState();
    const g = o.gravity ?? asm.simulation?.gravity ?? G0;
    this.gravity = typeof g === 'number' ? [0, 0, -g] : toVec3(g);

    // group parts welded by fixed joints into compound bodies (union-find)
    const parent = new Map<string, string>();
    const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
    for (const p of asm.parts) parent.set(p.name, p.name);
    for (const j of asm.joints) if (j.type === 'fixed' || j.type === 'path') parent.set(find(j.child), find(j.parent));
    if (asm.joints.some((j) => j.type === 'path')) this.warnings.push('path joints are held at their initial value in dynamics');
    const groups = new Map<string, Part[]>();
    for (const p of asm.parts) { const r = find(p.name); groups.set(r, [...(groups.get(r) ?? []), p]); }

    // root parts (no joint makes them a child) decide whether a tree is anchored
    const children = new Set(asm.joints.map((j) => j.child));
    let minZ = Infinity;
    for (const [root, parts] of groups) {
      let m = 0; let com: Vec3 = [0, 0, 0];
      const props: { m: number; com: Vec3; I: M3 }[] = [];
      const clouds: Vec3[][] = [];
      let mat: SimMaterialProps = { mu: 0.6, restitution: 0.1 };
      let motion: Body['motion'] = 'dynamic';
      for (const p of parts) {
        const T = solved.getTransform(p.name);
        this.partT0.set(p.name, T);
        const shape = partShape(p).transform(T);
        const bb = shape.boundingBox();
        minZ = Math.min(minZ, bb.min[2]);
        const mass = solved.massOf(p);
        const pp = PhysicalProperties.approximate(shape, {});
        const scale = pp.massKg > 0 ? mass / pp.massKg : 0;
        props.push({ m: mass, com: pp.centerOfMass, I: inertiaTensor(pp.inertia).map((x) => x * scale) });
        m += mass; com = v3.add(com, v3.scale(pp.centerOfMass, mass));
        clouds.push(...colliderClouds(p, T));
        mat = simMaterial(p);
        const mk = o.motion?.[p.name] ?? p.sim?.motion?.kind;
        if (mk === 'static' || mk === 'kinematic') motion = mk;
        else if (!children.has(p.name) && asm.simulation?.fixedBase && (asm.simulation.rootPart ?? asm.parts[0].name) === p.name) motion = 'static';
      }
      com = m > 0 ? v3.scale(com, 1 / m) : partShape(parts[0]).transform(this.partT0.get(parts[0].name)!).centroid();
      // parallel-axis sum about the compound's centre of mass (kg·m²)
      let I = m3.zero();
      for (const pr of props) {
        const d = v3.scale(v3.sub(pr.com, com), 1e-3), dd = v3.dot(d, d);
        const shift = [dd - d[0] * d[0], -d[0] * d[1], -d[0] * d[2], -d[1] * d[0], dd - d[1] * d[1], -d[1] * d[2], -d[2] * d[0], -d[2] * d[1], dd - d[2] * d[2]].map((x) => x * pr.m);
        I = I.map((x, i) => x + pr.I[i] + shift[i]);
      }
      // guard degenerate inertia (flat or tiny parts)
      const tr = Math.max(1e-12, (I[0] + I[4] + I[8]) / 3);
      for (const i of [0, 4, 8]) I[i] = Math.max(I[i], tr * 1e-3);
      const hulls = clouds.map((c) => makeHull(c.map((x) => v3.scale(v3.sub(x, com), 1e-3)))).filter(Boolean) as Hull[];
      const dyn = motion === 'dynamic' && m > 0;
      const b: Body = {
        id: this.bodies.length, name: root, parts: parts.map((p) => p.name), motion: dyn ? 'dynamic' : motion === 'dynamic' ? 'static' : motion,
        m, invM: dyn ? 1 / m : 0, Ib: I, invIb: dyn ? m3.inv(I) : m3.zero(), invIw: m3.zero(),
        x: v3.scale(com, 1e-3), x0: v3.scale(com, 1e-3), q: [1, 0, 0, 0], v: [0, 0, 0], w: [0, 0, 0], com0mm: com, hulls, mat,
      };
      const bv = parts.map((p) => o.bodyVelocities?.[p.name]).find(Boolean);
      if (bv && b.motion !== 'static') { b.v = v3.scale(toVec3(bv.linear ?? [0, 0, 0]), 1e-3); b.w = v3.scale(toVec3(bv.angular ?? [0, 0, 0]), Math.PI / 180); }
      this.bodies.push(b);
      for (const p of parts) this.partBody.set(p.name, b);
    }

    const gopt = o.ground ?? asm.simulation?.ground ?? true;
    this.groundZ = gopt === false ? null : (typeof gopt === 'object' && gopt.z != null ? gopt.z : minZ) * 1e-3;
    this.groundMat = { mu: (typeof gopt === 'object' && gopt.friction) || 0.8, restitution: (typeof gopt === 'object' && gopt.restitution) || 0 };

    // joints between bodies
    for (const j of asm.joints) {
      const a = this.partBody.get(j.parent)!, b = this.partBody.get(j.child)!;
      this.noCollide.add(pairKey(a, b));
      if (a === b) continue; // welded (fixed) or loop inside one compound
      const pc = xfConnector(asm.getConnectorLocal(j.parent, j.parentConn), solved.getTransform(j.parent));
      const F = connectorFrame(pc);
      const M = mat4.mul(F, jointMotion(j, this.base[j.name]));
      const origin = pc.origin; // mm, world
      const axis = v3.norm(pc.axis);
      const xA: Vec3 = v3.norm([F[0], F[1], F[2]]);
      const yB: Vec3 = v3.norm([M[4], M[5], M[6]]);
      // child anchor sits where the child connector is at t0 (matches parent unless a loop is open)
      const cc = xfConnector(asm.getConnectorLocal(j.child, j.childConn), solved.getTransform(j.child));
      const toLocal = (body: Body, pmm: Vec3) => v3.scale(v3.sub(pmm, body.com0mm), 1e-3);
      const v0 = typeof this.base[j.name] === 'number' ? this.base[j.name] : 0;
      this.joints.push({
        j, a, b, v0,
        pA: toLocal(a, origin), pB: toLocal(b, j.type === 'prismatic' || j.type === 'cylindrical' || j.type === 'planar' ? origin : cc.origin),
        axA: axis, axB: axis, xA, xB: xA, yB, prev: 0, value: v0, peak: 0, sat: 0,
      });
    }
    for (const n of o.ignorePairs ?? []) { const A = this.partBody.get(n[0]), B = this.partBody.get(n[1]); if (A && B) this.noCollide.add(pairKey(A, B)); }
    for (const s of asm.springs) {
      const [pa] = asm.splitRef(s.from), [pb] = asm.splitRef(s.to);
      const A = this.partBody.get(pa)!, B = this.partBody.get(pb)!;
      const wa = solved.connectorWorld(s.from).origin, wb = solved.connectorWorld(s.to).origin;
      this.springs.push({ name: s.name, a: A, b: B, pA: v3.scale(v3.sub(wa, A.com0mm), 1e-3), pB: v3.scale(v3.sub(wb, B.com0mm), 1e-3), spec: s.spring });
    }
    for (const b of this.bodies) this.refresh(b);
  }

  // ------------------------------------------------------------ helpers
  private refresh(b: Body) {
    const R = q.toM3(b.q);
    b.R = R;
    b.invIw = b.invM ? m3.mul(R, m3.mul(b.invIb, m3.T(R))) : m3.zero();
    b.wv = b.hulls.map((h) => h.verts.map((p) => v3.add(m3.mulV(R, p), b.x)));
    b.wp = b.hulls.map((h) => h.planes.map((pl) => { const n = m3.mulV(R, pl.n); return { n, d: pl.d + v3.dot(n, b.x) }; }));
    b.wc = b.hulls.map((h) => v3.add(m3.mulV(R, h.center), b.x));
  }
  private world(b: Body, local: Vec3): Vec3 { return v3.add(m3.mulV(b.R!, local), b.x); }
  private dir(b: Body | null, local: Vec3): Vec3 { return b ? m3.mulV(b.R!, local) : local; }
  private velAt(b: Body | null, r: Vec3): Vec3 { return b ? v3.add(b.v, v3.cross(b.w, r)) : [0, 0, 0]; }
  private applyImpulse(b: Body | null, P: Vec3, r: Vec3) {
    if (!b || !b.invM) return;
    b.v = v3.add(b.v, v3.scale(P, b.invM));
    b.w = v3.add(b.w, m3.mulV(b.invIw, v3.cross(r, P)));
  }
  private applyAngular(b: Body | null, L: Vec3) { if (b && b.invM) b.w = v3.add(b.w, m3.mulV(b.invIw, L)); }

  private linRow(a: Body | null, b: Body | null, n: Vec3, rA: Vec3, rB: Vec3, bias: number, lo: number, hi: number, kind: Row['kind'], joint?: string): Row {
    let k = 0;
    if (a?.invM) k += a.invM + v3.dot(n, v3.cross(m3.mulV(a.invIw, v3.cross(rA, n)), rA));
    if (b?.invM) k += b.invM + v3.dot(n, v3.cross(m3.mulV(b.invIw, v3.cross(rB, n)), rB));
    return { a, b, lin: n, rA, rB, bias, lo, hi, acc: 0, k: k > 0 ? 1 / k : 0, kind, joint };
  }
  private angRow(a: Body | null, b: Body | null, ax: Vec3, bias: number, lo: number, hi: number, kind: Row['kind'], joint?: string): Row {
    let k = 0;
    if (a?.invM) k += v3.dot(ax, m3.mulV(a.invIw, ax));
    if (b?.invM) k += v3.dot(ax, m3.mulV(b.invIw, ax));
    return { a, b, ang: ax, bias, lo, hi, acc: 0, k: k > 0 ? 1 / k : 0, kind, joint };
  }
  private rowVel(r: Row): number {
    if (r.lin) return v3.dot(v3.sub(this.velAt(r.b, r.rB!), this.velAt(r.a, r.rA!)), r.lin);
    return v3.dot(v3.sub(r.b?.w ?? [0, 0, 0], r.a?.w ?? [0, 0, 0]), r.ang!);
  }
  private applyRow(r: Row, l: number) {
    if (r.lin) { this.applyImpulse(r.b, v3.scale(r.lin, l), r.rB!); this.applyImpulse(r.a, v3.scale(r.lin, -l), r.rA!); }
    else { this.applyAngular(r.b, v3.scale(r.ang!, l)); this.applyAngular(r.a, v3.scale(r.ang!, -l)); }
  }

  // ------------------------------------------------------------ joint coordinate
  private measure(J: RigidWorld['joints'][number]) {
    const { j, a, b } = J;
    const ax = this.dir(a, J.axA);
    if (j.type === 'prismatic') {
      const pA = a ? this.world(a, J.pA) : J.pA, pB = this.world(b!, J.pB);
      return J.v0 + v3.dot(v3.sub(pB, pA), ax) * 1000;
    }
    const xA = this.dir(a, J.xA), xB = this.dir(b, J.xB);
    let ang = (Math.atan2(v3.dot(v3.cross(xA, xB), ax), v3.dot(xA, xB)) * 180) / Math.PI;
    // unwrap so the value stays continuous past ±180°
    while (ang - J.prev > 180) ang -= 360;
    while (ang - J.prev < -180) ang += 360;
    J.prev = ang;
    return J.v0 + ang;
  }

  // ------------------------------------------------------------ contacts
  private collide(): Contact[] {
    const out: Contact[] = [];
    const margin = 1e-3; // 1 mm speculative margin
    const reduce = (cs: Contact[], max = 6) => {
      if (cs.length <= max) return cs;
      cs.sort((x, y) => y.depth - x.depth);
      const pick = [cs[0]];
      while (pick.length < max) {
        let best: Contact | null = null, bd = -1;
        for (const c of cs) { if (pick.includes(c)) continue; const d = Math.min(...pick.map((p) => v3.dist(p.p, c.p))); if (d > bd) { bd = d; best = c; } }
        if (!best) break;
        pick.push(best);
      }
      return pick;
    };
    // ground
    if (this.groundZ != null) for (const b of this.bodies) {
      if (!b.invM) continue;
      const cs: Contact[] = [];
      for (const vs of b.wv!) for (const p of vs) if (p[2] < this.groundZ + margin) cs.push({ a: null, b, p, n: [0, 0, 1], depth: this.groundZ - p[2] });
      out.push(...reduce(cs));
    }
    if (this.o.contacts === false) return out;
    // body pairs
    for (let i = 0; i < this.bodies.length; i++) for (let k = i + 1; k < this.bodies.length; k++) {
      const A = this.bodies[i], B = this.bodies[k];
      if (!A.invM && !B.invM) continue;
      if (this.noCollide.has(pairKey(A, B))) continue;
      for (let ha = 0; ha < A.hulls.length; ha++) for (let hb = 0; hb < B.hulls.length; hb++) {
        if (v3.dist(A.wc![ha], B.wc![hb]) > A.hulls[ha].radius + B.hulls[hb].radius + margin) continue;
        const cs: Contact[] = [];
        const inside = (p: Vec3, planes: { n: Vec3; d: number }[]) => {
          let depth = Infinity, n: Vec3 = [0, 0, 1];
          for (const pl of planes) { const s = pl.d - v3.dot(pl.n, p); if (s < -margin) return null; if (s < depth) { depth = s; n = pl.n; } }
          return { depth, n };
        };
        for (const p of A.wv![ha]) { const h = inside(p, B.wp![hb]); if (h) cs.push({ a: A, b: B, p, n: v3.scale(h.n, -1), depth: h.depth }); }
        for (const p of B.wv![hb]) { const h = inside(p, A.wp![ha]); if (h) cs.push({ a: A, b: B, p, n: h.n, depth: h.depth }); }
        out.push(...reduce(cs, 8));
      }
    }
    return out;
  }

  // ------------------------------------------------------------ stepping
  t = 0;
  contacts: Contact[] = [];
  maxPenetration = 0;
  peakContacts = 0;

  step(dt: number) {
    const o = this.o, beta = 0.2, slop = 2e-4;
    // external forces: gravity, assembly springs, user loads, passive joint springs and damping
    for (const b of this.bodies) if (b.invM) {
      b.v = v3.add(b.v, v3.scale(this.gravity, dt));
      // gyroscopic term (explicit)
      const Iw = m3.mulV(m3.mul(b.R!, m3.mul(b.Ib, m3.T(b.R!))), b.w);
      b.w = v3.sub(b.w, v3.scale(m3.mulV(b.invIw, v3.cross(b.w, Iw)), dt));
    }
    for (const s of this.springs) {
      const pA = s.a ? this.world(s.a, s.pA) : s.pA, pB = s.b ? this.world(s.b, s.pB) : s.pB;
      const d = v3.sub(pB, pA), L = v3.len(d) * 1000, n = v3.norm(d);
      const ext = L - s.spec.freeLength;
      const F = s.spec.kind === 'compression' ? -Math.max(0, -ext) * s.spec.rateNPerMm : Math.max(0, ext) * s.spec.rateNPerMm + (s.spec.initialTensionN ?? 0);
      // positive F pulls the ends together
      if (s.a) this.applyImpulse(s.a, v3.scale(n, F * dt), v3.sub(pA, s.a.x));
      if (s.b) this.applyImpulse(s.b, v3.scale(n, -F * dt), v3.sub(pB, s.b.x));
    }
    for (const L of o.loads ?? []) {
      if ('part' in L) {
        const b = this.partBody.get(L.part);
        if (!b) throw new ForgeError('SIM.NO_PART', `load on unknown part "${L.part}"`);
        const at = L.at ? v3.scale(v3.sub(mat4.apply(this.partT0.get(L.part)!, toVec3(L.at)), b.com0mm), 1e-3) : [0, 0, 0] as Vec3;
        const r = m3.mulV(b.R!, at);
        this.applyImpulse(b, v3.scale(toVec3(L.force), dt), r);
      }
    }
    const rows: Row[] = [];
    for (const J of this.joints) {
      const { j, a, b } = J;
      J.value = j.type === 'revolute' || j.type === 'prismatic' || j.type === 'cylindrical' ? this.measure(J) : J.value;
      const pA = a ? this.world(a, J.pA) : J.pA, pB = this.world(b!, J.pB);
      const rA = a ? v3.sub(pA, a.x) : [0, 0, 0] as Vec3, rB = v3.sub(pB, b!.x);
      const ax = this.dir(a, J.axA);
      const err = v3.sub(pB, pA);
      const basis: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const t1 = v3.perp(ax), t2 = v3.cross(ax, t1);
      const linRows = (dirs: Vec3[]) => { for (const n of dirs) rows.push(this.linRow(a, b, n, rA, rB, (-beta * v3.dot(err, n)) / dt, -Infinity, Infinity, 'joint', j.name)); };
      const lockAll = () => {
        const qa = a ? a.q : [1, 0, 0, 0] as Quat;
        let qr = q.mul(q.conj(qa), b!.q);
        if (qr[0] < 0) qr = qr.map((x) => -x) as Quat;
        const e = this.dir(a, [2 * qr[1], 2 * qr[2], 2 * qr[3]]);
        for (const n of basis) rows.push(this.angRow(a, b, n, (-beta * v3.dot(e, n)) / dt, -Infinity, Infinity, 'joint', j.name));
      };
      const alignAxis = () => {
        const e = v3.cross(ax, this.dir(b, J.axB));
        for (const n of [t1, t2]) rows.push(this.angRow(a, b, n, (-beta * v3.dot(e, n)) / dt, -Infinity, Infinity, 'joint', j.name));
      };
      switch (j.type) {
        case 'revolute': linRows(basis); alignAxis(); break;
        case 'ball': linRows(basis); break;
        case 'universal': {
          linRows(basis);
          const xA = this.dir(a, J.xA), yB = this.dir(b, J.yB);
          const n = v3.cross(yB, xA);
          if (v3.len(n) > 1e-6) rows.push(this.angRow(a, b, v3.norm(n), (-beta * v3.dot(xA, yB)) / dt, -Infinity, Infinity, 'joint', j.name));
          break;
        }
        case 'prismatic': linRows([t1, t2]); lockAll(); break;
        case 'cylindrical': linRows([t1, t2]); alignAxis(); break;
        case 'planar': linRows([ax]); alignAxis(); break;
        default: linRows(basis); lockAll();
      }
      if (j.type !== 'revolute' && j.type !== 'prismatic') continue;
      // limits, drives, friction, springs and damping along the joint's free axis
      const rev = j.type === 'revolute';
      const toSI = rev ? Math.PI / 180 : 1e-3;
      const axisRow = (bias: number, lo: number, hi: number, kind: Row['kind'], sign = 1) =>
        rev ? this.angRow(a, b, v3.scale(ax, sign), bias, lo, hi, kind, j.name) : this.linRow(a, b, v3.scale(ax, sign), rA, rB, bias, lo, hi, kind, j.name);
      if (j.min != null && J.value <= j.min + (rev ? 0.5 : 0.2)) rows.push(axisRow((beta * Math.max(0, (j.min - J.value) * toSI)) / dt + Math.min(0, (J.value - j.min) * toSI) / dt, 0, Infinity, 'limit'));
      if (j.max != null && J.value >= j.max - (rev ? 0.5 : 0.2)) rows.push(axisRow((beta * Math.max(0, (J.value - j.max) * toSI)) / dt + Math.min(0, (j.max - J.value) * toSI) / dt, 0, Infinity, 'limit', -1));
      const d = j.drive ?? {};
      const probe = axisRow(0, 0, 0, 'motor');
      const relVel = this.rowVel(probe);
      const lead = j.follows ? this.joints.find((x) => x.j.name === j.follows!.joint) : undefined;
      if (lead) {
        const target = (j.follows!.ratio ?? 1) * lead.value + (j.follows!.offset ?? 0);
        rows.push(axisRow(((target - J.value) * toSI) / (dt * 8), -1e3 * dt, 1e3 * dt, 'motor'));
      } else if (d.kind === 'servo' || j.driven) {
        const target = o.targets?.[j.name] ?? d.target ?? J.v0;
        const k = d.stiffnessNmPerDeg ?? 1, c = d.servoDampingNmsPerDeg ?? k * 0.05;
        const maxV = (d.maxSpeedRpm ?? 60) * (rev ? 2 * Math.PI / 60 : 1e-3 / 60 * 1000);
        const vt = Math.max(-maxV, Math.min(maxV, ((target - J.value) * toSI * k) / Math.max(1e-9, c)));
        const maxF = (d.maxTorqueNm ?? d.maxForceN ?? j.effort ?? 10) * dt;
        rows.push(axisRow(vt, -maxF, maxF, 'motor'));
      } else if (d.kind === 'velocity') {
        const rpm = o.velocities?.[j.name] ?? d.targetRpm ?? d.maxSpeedRpm ?? 0;
        const vt = rev ? rpm * 2 * Math.PI / 60 : rpm * 1e-3;
        const maxF = (d.maxTorqueNm ?? j.effort ?? 1) * dt;
        rows.push(axisRow(vt, -maxF, maxF, 'motor'));
      } else if (o.targets?.[j.name] != null) {
        const vt = Math.max(-6, Math.min(6, (o.targets[j.name] - J.value) * toSI * 20));
        rows.push(axisRow(vt, -(j.effort ?? 10) * dt, (j.effort ?? 10) * dt, 'motor'));
      }
      // explicit spring + clamped damping as impulses along the axis
      let tau = 0;
      if (d.kind === 'torsionSpring') tau -= d.stiffnessNmPerDeg * (J.value - (d.restDeg ?? 0));
      if (d.kind === 'linearSpring') tau -= d.stiffnessNPerMm * (J.value - (d.restMm ?? 0));
      for (const L of o.loads ?? []) if ('joint' in L && L.joint === j.name) tau += L.value;
      const keff = probe.k;
      const damping = d.damping ?? j.damping ?? 0;
      let imp = tau * dt;
      if (damping && keff) imp -= Math.min(1, damping * (rev ? 1 : 1e3) * dt / keff) * keff * relVel;
      if (imp) this.applyRow(probe, imp);
      const fr = d.friction ?? j.friction;
      if (fr) rows.push(axisRow(0, -fr * dt, fr * dt, 'friction'));
    }
    // contacts
    this.contacts = this.collide();
    this.peakContacts = Math.max(this.peakContacts, this.contacts.length);
    const crow: { n: Row; t1: Row; t2: Row; mu: number }[] = [];
    for (const c of this.contacts) {
      this.maxPenetration = Math.max(this.maxPenetration, c.depth);
      const rA = c.a ? v3.sub(c.p, c.a.x) : [0, 0, 0] as Vec3, rB = v3.sub(c.p, c.b.x);
      const matA = c.a ? c.a.mat : this.groundMat;
      const mu = Math.max(matA.mu, c.b.mat.mu), e = (matA.restitution + c.b.mat.restitution) / 2;
      const n = this.linRow(c.a, c.b, c.n, rA, rB, 0, 0, Infinity, 'joint');
      const vn = this.rowVel(n);
      let bias = c.depth > slop ? (beta * (c.depth - slop)) / dt : c.depth < 0 ? c.depth / dt : 0;
      if (vn < -0.2 && e > 0) bias = Math.max(bias, -e * vn);
      n.bias = bias;
      const t1 = v3.perp(c.n), t2 = v3.cross(c.n, t1);
      crow.push({ n, t1: this.linRow(c.a, c.b, t1, rA, rB, 0, 0, 0, 'friction'), t2: this.linRow(c.a, c.b, t2, rA, rB, 0, 0, 0, 'friction'), mu });
    }
    // sequential impulses
    const iters = o.iterations ?? 24;
    for (let it = 0; it < iters; it++) {
      for (const r of rows) this.solveRow(r);
      for (const c of crow) {
        this.solveRow(c.n);
        const lim = c.mu * c.n.acc;
        c.t1.lo = c.t2.lo = -lim; c.t1.hi = c.t2.hi = lim;
        this.solveRow(c.t1); this.solveRow(c.t2);
      }
    }
    // drive effort bookkeeping
    for (const r of rows) if (r.kind === 'motor' && r.joint) {
      const J = this.joints.find((x) => x.j.name === r.joint)!;
      const eff = Math.abs(r.acc) / dt;
      J.peak = Math.max(J.peak, eff);
      if (Number.isFinite(r.hi) && Math.abs(r.acc) >= r.hi * 0.999) J.sat += dt;
    }
    // integrate
    for (const b of this.bodies) {
      if (b.motion === 'static') continue;
      b.x = v3.add(b.x, v3.scale(b.v, dt));
      const wq: Quat = [0, b.w[0], b.w[1], b.w[2]];
      const dq = q.mul(wq, b.q);
      b.q = q.norm([b.q[0] + 0.5 * dt * dq[0], b.q[1] + 0.5 * dt * dq[1], b.q[2] + 0.5 * dt * dq[2], b.q[3] + 0.5 * dt * dq[3]]);
      this.refresh(b);
    }
    this.t += dt;
  }

  private solveRow(r: Row) {
    if (!r.k) return;
    const vel = this.rowVel(r);
    let l = (r.bias - vel) * r.k;
    const old = r.acc;
    r.acc = Math.max(r.lo, Math.min(r.hi, old + l));
    l = r.acc - old;
    if (l) this.applyRow(r, l);
  }

  // ------------------------------------------------------------ outputs
  partTransform(part: string): Mat4 {
    const b = this.partBody.get(part)!;
    const R = b.R!;
    const x = v3.scale(b.x, 1000);
    const Tb: Mat4 = [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, x[0], x[1], x[2], 1];
    return mat4.mul(Tb, mat4.mul(mat4.translation(-b.com0mm[0], -b.com0mm[1], -b.com0mm[2]), this.partT0.get(part)!));
  }
  transforms(): Record<string, Mat4> { return Object.fromEntries(this.asm.parts.map((p) => [p.name, this.partTransform(p.name)])); }
  jointValues(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const J of this.joints) if (J.j.type === 'revolute' || J.j.type === 'prismatic' || J.j.type === 'cylindrical') out[J.j.name] = J.value;
    return out;
  }
  kineticEnergy(): number {
    let e = 0;
    for (const b of this.bodies) if (b.invM) {
      const Iw = m3.mulV(m3.mul(b.R!, m3.mul(b.Ib, m3.T(b.R!))), b.w);
      e += 0.5 * b.m * v3.dot(b.v, b.v) + 0.5 * v3.dot(b.w, Iw);
    }
    return e;
  }
}

function pairKey(a: { id: number }, b: { id: number }) { return a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`; }

// ---------------------------------------------------------------- entry points
export interface DynamicsResult {
  engine: 'rigid-body';
  frames: DynamicsFrame[];
  final: Record<string, number>;
  finalTransforms: Record<string, Mat4>;
  summary: {
    duration: number; dt: number; steps: number; bodies: number; contacts: number; peakContacts: number;
    maxPenetrationMm: number; kineticEnergyJ: number; settled: boolean;
    parts: Record<string, { displacementMm: number; rotationDeg: number; finalCenterMm: Vec3; resting: boolean }>;
    drives: Record<string, { peakEffort: number; limit?: number; saturatedS: number }>;
    jointTravel: Record<string, { start: number; end: number; min: number; max: number }>;
  };
  warnings: string[];
}

/** Rigid-body dynamics of an assembly under gravity with contacts, joint constraints and drives. */
export function simulateDynamics(asm: Assembly, o: DynamicsOptions = {}): DynamicsResult {
  const dt = o.dt ?? asm.simulation?.dt ?? 1 / 500;
  const duration = o.duration ?? asm.simulation?.duration ?? 2;
  const steps = Math.max(1, Math.round(duration / dt));
  if (steps > 200000) throw new ForgeError('SIM.TOO_LONG', `simulation of ${steps} steps is too long; raise dt or shorten duration`);
  const w = new RigidWorld(asm, o);
  const every = Math.max(1, Math.round(1 / (o.sampleHz ?? 60) / dt));
  const frames: DynamicsFrame[] = [];
  const travel: Record<string, { start: number; end: number; min: number; max: number }> = {};
  const record = () => {
    const values = w.jointValues();
    for (const [k, v] of Object.entries(values)) {
      const t = travel[k] ?? (travel[k] = { start: v, end: v, min: v, max: v });
      t.end = v; t.min = Math.min(t.min, v); t.max = Math.max(t.max, v);
    }
    const f: DynamicsFrame = { t: w.t, values, transforms: w.transforms() };
    if (o.recordContacts) f.contacts = w.contacts.map((c) => ({ p: v3.scale(c.p, 1000), n: c.n, a: c.a?.name ?? 'ground', b: c.b.name }));
    frames.push(f);
  };
  record();
  for (let s = 1; s <= steps; s++) {
    w.step(dt);
    if (!Number.isFinite(w.bodies.reduce((acc, b) => acc + b.x[0] + b.x[1] + b.x[2], 0))) throw new ForgeError('SIM.UNSTABLE', `simulation blew up at t=${w.t.toFixed(3)} s; lower dt or check masses and drives`);
    if (s % every === 0) record();
  }
  const parts: DynamicsResult['summary']['parts'] = {};
  for (const p of asm.parts) {
    const b = w.partBody.get(p.name)!;
    // fastest point of the body (mm/s); a little contact jitter still counts as resting
    const reach = Math.max(10, ...b.hulls.map((h) => (v3.len(h.center) + h.radius) * 1000));
    const speed = v3.len(b.v) * 1000 + v3.len(b.w) * reach;
    parts[p.name] = { displacementMm: v3.len(v3.sub(b.x, b.x0)) * 1000, rotationDeg: q.angleDeg(b.q), finalCenterMm: v3.scale(b.x, 1000), resting: b.motion === 'static' || speed < 10 };
  }
  const drives: DynamicsResult['summary']['drives'] = {};
  for (const J of w.joints) if (J.peak > 0) drives[J.j.name] = { peakEffort: J.peak, limit: J.j.drive?.maxTorqueNm ?? J.j.drive?.maxForceN ?? J.j.effort, saturatedS: J.sat };
  const ke = w.kineticEnergy();
  return {
    engine: 'rigid-body', frames, final: w.jointValues(), finalTransforms: w.transforms(),
    summary: {
      duration: w.t, dt, steps, bodies: w.bodies.length, contacts: w.contacts.length, peakContacts: w.peakContacts,
      maxPenetrationMm: w.maxPenetration * 1000, kineticEnergyJ: ke, settled: Object.values(parts).every((p) => p.resting),
      parts, drives, jointTravel: travel,
    },
    warnings: w.warnings,
  };
}

/**
 * Hold test: load one joint with a constant torque (N·m) or force (N) and check how far it moves.
 * Runs a control pass without the load so travel caused by settling is not blamed on the load.
 */
export function holdTest(asm: Assembly, o: { joint: string; load: number; seconds?: number; maxTravel?: number } & DynamicsOptions) {
  const j = asm.joints.find((x) => x.name === o.joint);
  if (!j) throw new ForgeError('SIM.NO_JOINT', `no joint "${o.joint}"`);
  const base = { ...o, duration: o.seconds ?? o.duration ?? 2 };
  const control = simulateDynamics(asm, { ...base, sampleHz: 10 });
  const loaded = simulateDynamics(asm, { ...base, sampleHz: 10, loads: [...(o.loads ?? []), { joint: o.joint, value: o.load }] });
  const c = control.final[o.joint] ?? 0, l = loaded.final[o.joint] ?? 0;
  const travel = Math.abs(l - c);
  const max = o.maxTravel ?? (j.type === 'prismatic' ? 1 : 3);
  return { joint: o.joint, load: o.load, unit: j.type === 'prismatic' ? 'N' : 'N·m', travel, travelUnit: j.type === 'prismatic' ? 'mm' : 'deg', maxTravel: max, pass: travel <= max, control: c, loaded: l };
}

/** Drop a single part (or group) from a height onto the ground and report how it lands. */
export function dropTest(shape: any, o: DynamicsOptions & { height?: number; rotate?: Vec3; name?: string } = {}) {
  let s: any = shape instanceof Assembly ? null : shape;
  if (!s) return simulateDynamics(shape, o);
  if (o.rotate) s = s.rotate(o.rotate);
  const bb = (s instanceof Shape ? s : s.toShape()).boundingBox();
  s = s.translate(0, 0, (o.height ?? 100) - bb.min[2]);
  const asm = new Assembly(o.name ?? 'Drop').addPart(o.name ?? 'Part', s);
  return simulateDynamics(asm, { ground: { z: 0 }, ...o });
}

// script API: Sim.run / Sim.drop / Sim.hold and assembly.simulate(...)
Object.assign(Sim, {
  run: (asm: Assembly, o?: DynamicsOptions) => simulateDynamics(asm, o),
  drop: dropTest,
  hold: (asm: Assembly, o: any) => holdTest(asm, o),
});
(Assembly.prototype as any).simulate = function (this: Assembly, o?: DynamicsOptions) { return simulateDynamics(this, o); };
(Assembly.prototype as any).holdTest = function (this: Assembly, o: any) { return holdTest(this, o); };

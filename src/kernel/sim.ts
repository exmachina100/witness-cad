// Physical materials, Sim.* (simulation metadata + a joint-space preview integrator), Fea.* (estimated static stress).
import { ForgeError } from './errors';
import { Shape } from './shape';
import { v3, Vec3 } from './math';
import type { Assembly, SolvedAssembly } from './assembly';

// ---------------------------------------------------------------- materials
export interface PhysMat { id: string; name: string; densityKgM3: number; grade?: string; designation?: string; appearance?: any; notes?: string; youngsModulusMPa?: number; poissonRatio?: number; yieldStrengthMPa?: number }
const registry = new Map<string, PhysMat>();
const UNIT_TO_KGM3: Record<string, number> = { 'kg/m3': 1, 'g/cm3': 1000, 'g/mm3': 1e6, 'lb/in3': 27679.9, 'lb/ft3': 16.0185 };

export const PhysicalMaterial = {
  define(name: string, o: any = {}): PhysMat {
    const density = o.densityKgM3 ?? (o.density != null ? o.density * (UNIT_TO_KGM3[o.densityUnit ?? 'kg/m3'] ?? 1) : undefined);
    if (density == null) throw new ForgeError('MATERIAL.DENSITY', `material "${name}" needs a density`);
    const m: PhysMat = { id: o.id ?? name.toLowerCase().replace(/\W+/g, '-'), name, densityKgM3: density, ...o };
    registry.set(m.id, m);
    return m;
  },
  get(id: string) {
    const m = registry.get(id);
    if (!m) throw new ForgeError('MATERIAL.NOT_FOUND', `no material "${id}"`);
    return m;
  },
  presets: {
    aluminum6061T6: () => PhysicalMaterial.define('Aluminum 6061-T6', { id: 'al-6061-t6', densityKgM3: 2700, youngsModulusMPa: 68900, poissonRatio: 0.33, yieldStrengthMPa: 276, appearance: { color: '#c8ccd0', metalness: 0.8, roughness: 0.35 } }),
    mildSteel: () => PhysicalMaterial.define('Mild steel', { id: 'mild-steel', densityKgM3: 7850, youngsModulusMPa: 200000, poissonRatio: 0.29, yieldStrengthMPa: 250, appearance: { color: '#8a8f94', metalness: 0.7, roughness: 0.45 } }),
    astmA36Steel: () => PhysicalMaterial.define('ASTM A36 steel', { id: 'astm-a36', densityKgM3: 7850, youngsModulusMPa: 200000, poissonRatio: 0.26, yieldStrengthMPa: 250 }),
    pla: () => PhysicalMaterial.define('PLA', { id: 'pla', densityKgM3: 1240, youngsModulusMPa: 3500, poissonRatio: 0.36, yieldStrengthMPa: 50 }),
    petg: () => PhysicalMaterial.define('PETG', { id: 'petg', densityKgM3: 1270, youngsModulusMPa: 2100, poissonRatio: 0.38, yieldStrengthMPa: 50 }),
    abs: () => PhysicalMaterial.define('ABS', { id: 'abs', densityKgM3: 1040, youngsModulusMPa: 2300, poissonRatio: 0.35, yieldStrengthMPa: 40 }),
    plywood: () => PhysicalMaterial.define('Plywood', { id: 'plywood', densityKgM3: 600 }),
  },
};

export const PhysicalProperties = {
  approximate(target: any, o: any = {}) {
    const shape: Shape = target instanceof Shape ? target : target.toShape ? target.toShape() : target;
    const density = o.densityKgM3 ?? (o.material?.densityKgM3) ?? (o.density != null ? o.density * (UNIT_TO_KGM3[o.densityUnit ?? 'kg/m3'] ?? 1) : 1240);
    const volumeMm3 = shape.volume();
    const massKg = volumeMm3 * 1e-9 * density;
    const com = shape.centroid();
    // inertia from mesh via signed tetrahedra (kg·m²), about the centre of mass
    const me = shape.mesh;
    const I = [0, 0, 0, 0, 0, 0]; // xx yy zz xy yz zx in mm^5 (× density later)
    for (let t = 0; t < me.indices.length / 3; t++) {
      const p = [0, 1, 2].map((k) => { const i = me.indices[t * 3 + k]; return v3.sub([me.positions[i * 3], me.positions[i * 3 + 1], me.positions[i * 3 + 2]], com); });
      const det = v3.dot(p[0], v3.cross(p[1], p[2]));
      const f = (a: number, b: number) => {
        let s = 0;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += p[i][a] * p[j][b] * (i === j ? 2 : 1);
        return (det * s) / 120;
      };
      const xx = f(0, 0), yy = f(1, 1), zz = f(2, 2);
      I[0] += yy + zz; I[1] += xx + zz; I[2] += xx + yy;
      I[3] -= f(0, 1); I[4] -= f(1, 2); I[5] -= f(2, 0);
    }
    const k = density * 1e-15; // mm^5 → m^5 times kg/m^3
    return {
      targetName: o.targetName, volumeMm3, massKg, densityKgM3: density, centerOfMass: com,
      inertia: { ixx: I[0] * k, iyy: I[1] * k, izz: I[2] * k, ixy: I[3] * k, iyz: I[4] * k, izx: I[5] * k },
      surfaceAreaMm2: shape.surfaceArea(),
    };
  },
};

// ---------------------------------------------------------------- Sim
const tag = (kind: string) => (o: any = {}) => ({ kind, ...o });
export const Sim = {
  material: (name: string, o: any = {}) => ({ kind: 'simMaterial', name, staticFriction: 0.6, dynamicFriction: 0.5, restitution: 0.1, ...o }),
  body: (o: any = {}) => ({ kind: 'simBody', ...o }),
  collider: {
    pieces: tag('pieces'),
    capsule: (from: Vec3, to: Vec3, radius: number) => ({ kind: 'capsule', from, to, radius }),
    hull: (points?: Vec3[]) => ({ kind: 'hull', points }),
    convexHull: () => ({ kind: 'convexHull' }),
    convexDecomposition: (o: any = {}) => ({ kind: 'convexDecomposition', ...o }),
    boundingBox: () => ({ kind: 'boundingBox' }),
    visualMesh: () => ({ kind: 'visualMesh' }),
    sdfMesh: (o: any = {}) => ({ kind: 'sdfMesh', resolution: 256, ...o }),
    none: (reason = '') => ({ kind: 'none', reason }),
  },
  motion: { dynamic: () => ({ kind: 'dynamic' }), kinematic: () => ({ kind: 'kinematic' }), static: () => ({ kind: 'static' }), deformable: () => ({ kind: 'deformable' }) },
  drive: {
    passive: (o: any = {}) => ({ kind: 'passive', damping: 0, friction: 0, ...o }),
    velocity: (o: any) => ({ kind: 'velocity', ...o }),
    servo: (o: any) => ({ kind: 'servo', damping: 0, friction: 0, ...o }),
    torsionSpring: (o: any) => ({ kind: 'torsionSpring', restDeg: 0, damping: 0, friction: 0, ...o }),
    linearSpring: (o: any) => ({ kind: 'linearSpring', restMm: 0, damping: 0, friction: 0, ...o }),
  },
  contact: { wheelSurface: (c: string) => ({ kind: 'wheelSurface', connector: c }), gripperSurface: (c: string) => ({ kind: 'gripperSurface', connector: c }) },
  profile: { robotBodyRunnable: () => ({ kind: 'robotBodyRunnable' }), robotBodyIsaac: () => ({ kind: 'robotBodyIsaac' }) },
  controller: { diffDrive: (o: any) => ({ kind: 'diffDrive', topic: '/cmd_vel', odomTopic: '/odom', ...o }) },
};

/**
 * Joint-space preview simulation under gravity. Each moving joint is integrated independently
 * with the lumped inertia of its subtree. It is a fast approximation for previews, not a full
 * multibody solver.
 */
export function simulate(asm: Assembly, o: { duration?: number; dt?: number; targets?: Record<string, number>; velocities?: Record<string, number> } = {}) {
  const dt = o.dt ?? 1 / 240, steps = Math.round((o.duration ?? 2) / dt);
  const moving = asm.joints.filter((j) => j.type === 'revolute' || j.type === 'prismatic');
  const q: Record<string, number> = {}, qd: Record<string, number> = {};
  const base = asm.resolveState();
  for (const j of moving) { q[j.name] = Number(base[j.name] ?? 0); qd[j.name] = 0; }
  const frames: { t: number; values: Record<string, number> }[] = [];
  const sampleEvery = Math.max(1, Math.round(1 / 60 / dt));
  let solved: SolvedAssembly = asm.solve({ ...base, ...q });
  const inertia: Record<string, number> = {};
  for (const j of moving) {
    let I = 0;
    for (const name of solved.subtree(j.child)) {
      const p = asm.part(name);
      const m = solved.massOf(p);
      const s = solved.getPart(name);
      const com = (s instanceof Shape ? s : s.toShape()).centroid();
      const f = solved.connectorWorld(`${j.child}.${j.childConn}`);
      if (j.type === 'revolute') {
        const r = v3.sub(com, f.origin);
        const perp = v3.sub(r, v3.scale(f.axis, v3.dot(r, f.axis)));
        I += m * (v3.dot(perp, perp) * 1e-6) + m * 1e-5;
      } else I += m;
    }
    inertia[j.name] = Math.max(1e-6, I);
  }
  for (let s = 0; s <= steps; s++) {
    if (s % 4 === 0) solved = asm.solve({ ...base, ...q });
    for (const j of moving) {
      const d = j.drive ?? {};
      let tau = solved.jointLoad(j.name);
      const isRev = j.type === 'revolute';
      const toRad = isRev ? Math.PI / 180 : 1e-3; // deg→rad or mm→m
      const pos = q[j.name] * toRad, vel = qd[j.name] * toRad;
      if (d.kind === 'servo') {
        const target = (o.targets?.[j.name] ?? d.target ?? base[j.name] ?? 0) * toRad;
        const kp = (d.stiffnessNmPerDeg ?? 1) * (180 / Math.PI), kd = (d.servoDampingNmsPerDeg ?? (d.stiffnessNmPerDeg ?? 1) * 0.05) * (180 / Math.PI);
        let u = kp * (target - pos) - kd * vel;
        if (d.maxTorqueNm) u = Math.max(-d.maxTorqueNm, Math.min(d.maxTorqueNm, u));
        tau += u;
      } else if (d.kind === 'torsionSpring') {
        tau += -(d.stiffnessNmPerDeg * (180 / Math.PI)) * (pos - (d.restDeg ?? 0) * toRad);
      } else if (d.kind === 'linearSpring') {
        tau += -(d.stiffnessNPerMm * 1000) * (pos - (d.restMm ?? 0) * toRad);
      } else if (d.kind === 'velocity') {
        const target = (o.velocities?.[j.name] ?? d.targetRpm ?? d.maxSpeedRpm ?? 0) * (isRev ? 2 * Math.PI / 60 : 1e-3);
        tau += Math.max(-(d.maxTorqueNm ?? 1), Math.min(d.maxTorqueNm ?? 1, (target - vel) * 10));
      }
      tau -= (d.damping ?? j.damping ?? 0.001) * vel;
      if (d.friction ?? j.friction) tau -= Math.sign(vel) * (d.friction ?? j.friction);
      const acc = tau / inertia[j.name];
      let nv = vel + acc * dt;
      let np = pos + nv * dt;
      const lo = j.min != null ? j.min * toRad : -Infinity, hi = j.max != null ? j.max * toRad : Infinity;
      if (np < lo) { np = lo; nv = Math.max(0, nv) * 0; }
      if (np > hi) { np = hi; nv = Math.min(0, nv) * 0; }
      q[j.name] = np / toRad;
      qd[j.name] = nv / toRad;
    }
    if (s % sampleEvery === 0) frames.push({ t: s * dt, values: { ...q } });
  }
  return { frames, final: { ...q } };
}

// ---------------------------------------------------------------- Fea (estimate)
export const Fea = {
  material: (name: string, o: any) => ({ kind: 'feaMaterial', name, ...o }),
  materials: {
    isotropicPrintedPla: () => Fea.material('PLA (isotropic)', { densityKgM3: 1240, youngsModulusMPa: 3500, poissonRatio: 0.36, yieldStrengthMPa: 50 }),
    printedPla: (o: any = {}) => Fea.material('PLA (printed)', { densityKgM3: 1240, youngsModulusMPa: 3500 * ((o.infillPercent ?? 100) / 100) ** 0.7, poissonRatio: 0.36, yieldStrengthMPa: 50 * ((o.infillPercent ?? 100) / 100) * 0.8, ...o }),
    aluminum6061T6: () => Fea.material('Aluminum 6061-T6', { densityKgM3: 2700, youngsModulusMPa: 68900, poissonRatio: 0.33, yieldStrengthMPa: 276 }),
    astmA36StructuralSteel: () => Fea.material('ASTM A36', { densityKgM3: 7850, youngsModulusMPa: 200000, poissonRatio: 0.26, yieldStrengthMPa: 250 }),
  },
  body: (o: any) => ({ kind: 'feaBody', ...o }),
  region: {
    face: (part: string, face: string) => ({ kind: 'face', part, face }),
    plane: (part: string, face: string, o: any) => ({ kind: 'plane', part, face, ...o }),
  },
  fix: { fixed: (region: any) => ({ kind: 'fixed', region }) },
  load: { force: (region: any, o: { newtons: number; direction: Vec3 }) => ({ kind: 'force', region, ...o }) },
  target: { minSafetyFactor: (v: number) => ({ kind: 'minSafetyFactor', value: v }) },
  render: { targets: (...t: any[]) => ({ kind: 'render', targets: t }) },
  mesh: { quadraticTets: (o: any) => ({ kind: 'quadraticTets', ...o }) },
  study: { staticStress: (name: string, o: any) => ({ kind: 'staticStress', name, ...o }) },
};

/** Estimate: nominal stress = total force / smallest cross-section between fixture and load. */
export function estimateStaticStress(shape: Shape, study: any, material: any) {
  const loads = study.loads ?? [];
  const total = loads.reduce((s: number, l: any) => s + Math.abs(l.newtons ?? 0), 0);
  const dir = v3.norm(loads[0]?.direction ?? [0, 0, -1]);
  // slice perpendicular to the dominant axis of the part to find the weakest section
  const bb = shape.boundingBox();
  const axis = bb.size.indexOf(Math.max(...bb.size));
  const rot = axis === 2 ? null : axis === 0 ? [0, 90, 0] : [-90, 0, 0];
  const s = rot ? shape.rotate(rot as Vec3) : shape;
  const b2 = s.boundingBox();
  let minArea = Infinity;
  for (let i = 1; i < 20; i++) {
    const z = b2.min[2] + ((b2.max[2] - b2.min[2]) * i) / 20;
    const a = s.m.slice(z).area();
    if (a > 0) minArea = Math.min(minArea, a);
  }
  // bending contribution: treat as cantilever of length L with rectangular section
  const L = Math.max(...bb.size);
  const sideways = Math.abs(dir[axis]) < 0.7;
  const c = Math.sqrt(minArea) / 2;
  const Iz = Math.pow(Math.sqrt(minArea), 4) / 12;
  const stress = sideways ? (total * L * c) / Iz : total / minArea;
  const sf = (material?.yieldStrengthMPa ?? 50) / Math.max(1e-9, stress);
  return { estimate: true, maxStressMPa: stress, safetyFactor: sf, minSectionMm2: minArea, method: sideways ? 'cantilever bending' : 'axial', pass: study.target ? sf >= study.target.value : undefined };
}

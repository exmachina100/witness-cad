// Fea.* script API: declare static stress studies (material, fixtures, loads, mesh, target) and
// run them with the voxel hex solver in fea.ts.
import { ForgeError } from './errors';
import { Shape } from './shape';
import { ctx } from './context';
import { union } from './ops';
import type { Vec3 } from './math';
import { solveStaticStress, FeaFixture, FeaLoad, FeaRegion, FeaResult, FeaMaterialProps } from './fea';

type Dir = 'x' | 'y' | 'z';
/** A region as declared in a script; part/face names resolve against the model when the study runs. */
export type RegionSpec =
  | { kind: 'face'; part?: string; face: string }
  | { kind: 'plane'; part?: string; face: string; offset?: number; tolerance?: number }
  | { kind: 'box'; min: Vec3; max: Vec3 }
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'side'; side: 'xmin' | 'xmax' | 'ymin' | 'ymax' | 'zmin' | 'zmax' };

export interface StaticStudy {
  kind: 'staticStress';
  name: string;
  part?: string;
  material?: any;
  fixtures: { kind: 'fixed' | 'roller' | 'dofs'; region: RegionSpec; dofs?: Dir[] }[];
  loads: any[];
  target?: { kind: 'minSafetyFactor'; value: number };
  mesh?: { elementSize?: number; targetElements?: number; size?: number };
}

const vec = (v: any, what: string): Vec3 => {
  if (!Array.isArray(v) || v.length !== 3 || v.some((x) => typeof x !== 'number' || !isFinite(x))) throw new ForgeError('FEA.VECTOR', `${what} must be [x, y, z]`);
  return v as Vec3;
};
const region = (r: any, what: string): RegionSpec => {
  if (typeof r === 'string') return { kind: 'face', face: r };
  if (!r || !['face', 'plane', 'box', 'sphere', 'side'].includes(r.kind)) throw new ForgeError('FEA.REGION', `${what} needs a region such as Fea.region.face("part", "bottom")`);
  return r;
};

const mat = (name: string, o: any) => ({ kind: 'feaMaterial', name, ...o });

export const Fea = {
  material: (name: string, o: { youngsModulusMPa: number; poissonRatio?: number; yieldStrengthMPa?: number; densityKgM3?: number }) => {
    if (!(o?.youngsModulusMPa > 0)) throw new ForgeError('FEA.MATERIAL', `material "${name}" needs youngsModulusMPa`);
    return mat(name, { poissonRatio: 0.3, ...o });
  },
  materials: {
    isotropicPrintedPla: () => mat('PLA (isotropic)', { densityKgM3: 1240, youngsModulusMPa: 3500, poissonRatio: 0.36, yieldStrengthMPa: 50 }),
    printedPla: (o: any = {}) => mat('PLA (printed)', { densityKgM3: 1240, youngsModulusMPa: 3500 * ((o.infillPercent ?? 100) / 100) ** 0.7, poissonRatio: 0.36, yieldStrengthMPa: 50 * ((o.infillPercent ?? 100) / 100) * 0.8, ...o }),
    petg: () => mat('PETG', { densityKgM3: 1270, youngsModulusMPa: 2100, poissonRatio: 0.38, yieldStrengthMPa: 50 }),
    abs: () => mat('ABS', { densityKgM3: 1040, youngsModulusMPa: 2300, poissonRatio: 0.35, yieldStrengthMPa: 40 }),
    nylon: () => mat('Nylon PA12', { densityKgM3: 1010, youngsModulusMPa: 1700, poissonRatio: 0.39, yieldStrengthMPa: 48 }),
    aluminum6061T6: () => mat('Aluminum 6061-T6', { densityKgM3: 2700, youngsModulusMPa: 68900, poissonRatio: 0.33, yieldStrengthMPa: 276 }),
    astmA36StructuralSteel: () => mat('ASTM A36', { densityKgM3: 7850, youngsModulusMPa: 200000, poissonRatio: 0.26, yieldStrengthMPa: 250 }),
    stainless304: () => mat('Stainless 304', { densityKgM3: 8000, youngsModulusMPa: 193000, poissonRatio: 0.29, yieldStrengthMPa: 215 }),
    titanium6Al4V: () => mat('Titanium Ti-6Al-4V', { densityKgM3: 4430, youngsModulusMPa: 113800, poissonRatio: 0.342, yieldStrengthMPa: 880 }),
    plywood: () => mat('Plywood (isotropic approx.)', { densityKgM3: 600, youngsModulusMPa: 8000, poissonRatio: 0.3, yieldStrengthMPa: 30 }),
  },
  body: (o: any) => ({ kind: 'feaBody', ...o }),
  region: {
    /** A labelled or direction-named face (top/bottom/left/right/front/back) of a part. Omit the part for single-part models. */
    face: (part: string, face?: string): RegionSpec => (face === undefined ? { kind: 'face', face: part } : { kind: 'face', part, face }),
    /** Every surface point on the infinite plane through a face (optionally shifted along its normal). */
    plane: (part: string, face: string, o: { offset?: number; tolerance?: number } = {}): RegionSpec => ({ kind: 'plane', part, face, ...o }),
    box: (min: Vec3, max: Vec3): RegionSpec => ({ kind: 'box', min: vec(min, 'Fea.region.box min'), max: vec(max, 'Fea.region.box max') }),
    sphere: (center: Vec3, radius: number): RegionSpec => ({ kind: 'sphere', center: vec(center, 'Fea.region.sphere center'), radius }),
    /** The extreme side of the analysed body's bounding box, e.g. "zmin". */
    side: (side: 'xmin' | 'xmax' | 'ymin' | 'ymax' | 'zmin' | 'zmax'): RegionSpec => ({ kind: 'side', side }),
  },
  fix: {
    fixed: (r: any) => ({ kind: 'fixed' as const, region: region(r, 'Fea.fix.fixed') }),
    /** Holds the region only along the dominant axis of its face normal; it may slide in the plane. */
    roller: (r: any) => ({ kind: 'roller' as const, region: region(r, 'Fea.fix.roller') }),
    /** Holds only the listed global directions. */
    dofs: (r: any, dofs: Dir[]) => ({ kind: 'dofs' as const, region: region(r, 'Fea.fix.dofs'), dofs }),
  },
  load: {
    force: (r: any, o: { newtons: number; direction?: Vec3 }) => ({ kind: 'force', region: region(r, 'Fea.load.force'), newtons: o.newtons, direction: vec(o.direction ?? [0, 0, -1], 'direction') }),
    /** Uniform pressure pushing into the face (MPa = N/mm^2). Use kpa for convenience. */
    pressure: (r: any, o: { mpa?: number; kpa?: number }) => ({ kind: 'pressure', region: region(r, 'Fea.load.pressure'), mpa: o.mpa ?? (o.kpa ?? 0) / 1000 }),
    /** Torque about an axis through the region centroid (or `origin`). */
    torque: (r: any, o: { nm?: number; nmm?: number; axis: Vec3; origin?: Vec3 }) => ({ kind: 'torque', region: region(r, 'Fea.load.torque'), nmm: o.nmm ?? (o.nm ?? 0) * 1000, axis: vec(o.axis, 'axis'), origin: o.origin }),
    /** Self weight from the material density. */
    gravity: (o: { acceleration?: Vec3; g?: number } = {}) => ({ kind: 'gravity', acceleration: o.acceleration ?? [0, 0, -(o.g ?? 9.80665)] }),
  },
  target: { minSafetyFactor: (v: number) => ({ kind: 'minSafetyFactor' as const, value: v }) },
  render: { targets: (...t: any[]) => ({ kind: 'render', targets: t }) },
  mesh: {
    /** Hexahedral voxel mesh. `size` is the element edge in mm; otherwise aims for `targetElements` (default 12000). */
    hex: (o: { size?: number; targetElements?: number } = {}) => ({ kind: 'hex', elementSize: o.size, targetElements: o.targetElements }),
    /** Accepted for compatibility; solved with the hex mesher using `size` as the element edge. */
    quadraticTets: (o: any = {}) => ({ kind: 'hex', elementSize: o.size ?? o.maxElementSize, targetElements: o.targetElements }),
  },
  study: {
    /** Declare a linear static stress study. It is listed in the Inspect panel and by check_strength. */
    staticStress: (name: string, o: any = {}): StaticStudy => {
      if (!o.fixtures?.length) throw new ForgeError('FEA.FIXTURES', `study "${name}" needs at least one fixture`);
      if (!o.loads?.length) throw new ForgeError('FEA.LOADS', `study "${name}" needs at least one load`);
      const s: StaticStudy = { kind: 'staticStress', name, part: o.part, material: o.material, fixtures: o.fixtures, loads: o.loads, target: typeof o.target === 'number' ? { kind: 'minSafetyFactor', value: o.target } : o.target, mesh: o.mesh };
      const list = ctx().feaStudies;
      const i = list.findIndex((x) => x.name === name);
      if (i >= 0) list[i] = s; else list.push(s);
      return s;
    },
  },
  /** Run a study right away inside the script on a shape, returning the solver summary. */
  solve: (shape: Shape, study: StaticStudy | any, opts: any = {}) => {
    if (!(shape instanceof Shape)) throw new ForgeError('FEA.SOLVE', 'Fea.solve(shape, study) needs a solid shape');
    const s = study.kind === 'staticStress' ? study : { kind: 'staticStress', name: 'inline', ...study };
    const r = runStudy(s, { solids: new Map([[shape.name ?? 'part', shape]]), single: shape }, { ...opts, fields: false });
    delete (r as any).field;
    return r;
  },
};

// ---------------------------------------------------------------- running

export interface StudyTargets {
  /** Solids by object / part name, in world space. */
  solids: Map<string, Shape>;
  /** Optional pre-merged body (used when no part is named). */
  single?: Shape;
  /** Per-part material from addPart(..., { fea: { material } }) */
  partMaterials?: Map<string, any>;
}

function pickShape(t: StudyTargets, name: string | undefined, forWhat: string): Shape {
  if (name == null) {
    if (t.single) return t.single;
    const all = [...t.solids.values()];
    if (!all.length) throw new ForgeError('FEA.NO_SOLID', 'nothing to analyse: the model has no solids');
    return all.length === 1 ? all[0] : union(all);
  }
  const s = t.solids.get(name) ?? [...t.solids.entries()].find(([k]) => k.endsWith('/' + name))?.[1];
  if (!s) throw new ForgeError('FEA.NO_PART', `${forWhat}: no part named "${name}". Parts: ${[...t.solids.keys()].join(', ')}`);
  return s;
}

function resolveRegion(r: RegionSpec, t: StudyTargets, body: Shape, studyPart?: string): FeaRegion {
  switch (r.kind) {
    case 'box': case 'sphere': case 'side': return r as FeaRegion;
    case 'face': case 'plane': {
      const owner = r.part != null ? pickShape(t, r.part, 'region') : studyPart != null ? pickShape(t, studyPart, 'region') : body;
      const f = owner.face(r.face);
      const label = `${r.part ? r.part + '.' : ''}${r.face}`;
      if (!f.planar && f.radius) return { kind: 'cylinder', center: f.center, axis: f.normal, radius: f.radius, label };
      const off = r.kind === 'plane' ? r.offset ?? 0 : 0;
      const point: Vec3 = [f.center[0] + f.normal[0] * off, f.center[1] + f.normal[1] * off, f.center[2] + f.normal[2] * off];
      const rect = r.kind === 'face' && f.size[0] > 0 && f.size[1] > 0 ? { center: f.center, u: f.uAxis, v: f.vAxis, size: f.size } : undefined;
      return { kind: 'plane', point, normal: f.normal, rect, area: r.kind === 'face' && f.area > 0 ? f.area : undefined, tolerance: (r as any).tolerance, label };
    }
  }
  throw new ForgeError('FEA.REGION', `unknown region ${(r as any)?.kind}`);
}

const DEFAULT_MATERIAL = { name: 'PLA (isotropic)', densityKgM3: 1240, youngsModulusMPa: 3500, poissonRatio: 0.36, yieldStrengthMPa: 50 };

export function runStudy(study: StaticStudy, t: StudyTargets, opts: { targetElements?: number; elementSize?: number; fields?: boolean } = {}): FeaResult & { study: string; part?: string; material: string; target?: number; body: Shape } {
  const body = pickShape(t, study.part, `study "${study.name}"`);
  let material: FeaMaterialProps | undefined = study.material ?? (study.part ? t.partMaterials?.get(study.part) : undefined);
  const warnings: string[] = [];
  if (!material) { material = DEFAULT_MATERIAL; warnings.push('no material given; assumed isotropic PLA (E 3.5 GPa, yield 50 MPa)'); }
  if (!(material.youngsModulusMPa > 0)) throw new ForgeError('FEA.MATERIAL', `material "${material.name ?? '?'}" has no youngsModulusMPa`);
  const fixtures: FeaFixture[] = study.fixtures.map((f) => {
    const reg = resolveRegion(f.region, t, body, study.part);
    if (f.kind === 'roller') {
      const n = reg.kind === 'plane' ? reg.normal : [0, 0, 1];
      const ax = [0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0);
      return { region: reg, dofs: ['xyz'[ax] as Dir] };
    }
    return { region: reg, dofs: f.kind === 'dofs' ? f.dofs : undefined };
  });
  const loads: FeaLoad[] = study.loads.map((l: any) => {
    if (l.kind === 'gravity') return { kind: 'gravity', acceleration: l.acceleration };
    const reg = resolveRegion(l.region, t, body, study.part);
    if (l.kind === 'force') {
      const d = l.direction as Vec3, len = Math.hypot(...d) || 1;
      return { kind: 'force', region: reg, force: [d[0] / len * l.newtons, d[1] / len * l.newtons, d[2] / len * l.newtons] };
    }
    if (l.kind === 'pressure') return { kind: 'pressure', region: reg, mpa: l.mpa };
    if (l.kind === 'torque') return { kind: 'torque', region: reg, axis: l.axis, nmm: l.nmm, origin: l.origin };
    throw new ForgeError('FEA.LOAD', `unknown load kind "${l.kind}"`);
  });
  const r = solveStaticStress(body.mesh, material, fixtures, loads, {
    targetElements: opts.targetElements ?? study.mesh?.targetElements,
    elementSize: opts.elementSize ?? study.mesh?.elementSize ?? study.mesh?.size,
    targetSafetyFactor: study.target?.value,
    fields: opts.fields,
  });
  r.warnings.unshift(...warnings);
  return { ...r, study: study.name, part: study.part, material: material.name ?? 'custom', target: study.target?.value, body };
}

/** Plain-data summary of a result (no typed arrays, no shapes) for JSON tools. */
export function summarizeFea(r: any) {
  const { field, body, ...rest } = r;
  return rest;
}

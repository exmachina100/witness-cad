// Run declared or quick FEA studies against the last build (used by the app worker, MCP server and CLI).
import { live, studyTargets } from './runtime';
import { Fea, runStudy, StaticStudy } from './feaStudy';
import { ForgeError } from './errors';

export interface QuickStudy {
  part?: string;
  /** face selector for the fixture, e.g. "bottom" or a face label */
  fix: string;
  /** face selector the load acts on */
  load: string;
  newtons: number;
  direction?: [number, number, number];
  material?: string | any;
  targetSafetyFactor?: number;
  gravity?: boolean;
}

export interface FeaRequest { study?: string; quick?: QuickStudy; targetElements?: number; elementSize?: number; fields?: boolean }

export function quickStudy(q: QuickStudy): StaticStudy {
  const mats: any = Fea.materials;
  const material = typeof q.material === 'string' ? (mats[q.material]?.() ?? (() => { throw new ForgeError('FEA.MATERIAL', `unknown material "${q.material}". Known: ${Object.keys(mats).join(', ')}`); })()) : q.material;
  const region = (face: string) => (q.part ? Fea.region.face(q.part, face) : Fea.region.face(face));
  const loads: any[] = [Fea.load.force(region(q.load), { newtons: q.newtons, direction: q.direction ?? [0, 0, -1] })];
  if (q.gravity) loads.push(Fea.load.gravity());
  return {
    kind: 'staticStress', name: 'Quick study', part: q.part, material,
    fixtures: [Fea.fix.fixed(region(q.fix))], loads,
    target: q.targetSafetyFactor ? Fea.target.minSafetyFactor(q.targetSafetyFactor) : undefined,
  };
}

/** Runs a study on the model from the last successful build. */
export function runFea(req: FeaRequest) {
  if (!live.result?.ok) throw new ForgeError('FEA.NO_BUILD', 'build the model before running a strength study');
  let study: StaticStudy;
  if (req.quick) study = quickStudy(req.quick);
  else {
    const list = live.feaStudies;
    if (!list.length) throw new ForgeError('FEA.NO_STUDY', 'the model declares no Fea.study.staticStress(...) studies; pass a quick study instead');
    const found = req.study ? list.find((s) => s.name === req.study) : list[0];
    if (!found) throw new ForgeError('FEA.NO_STUDY', `no study named "${req.study}". Studies: ${list.map((s) => s.name).join(', ')}`);
    study = found;
  }
  const t = studyTargets();
  return runStudy(study, t, { targetElements: req.targetElements, elementSize: req.elementSize, fields: req.fields });
}

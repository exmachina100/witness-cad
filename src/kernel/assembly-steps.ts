// Assembly steps (ForgeCAD semantics): each part after the base carries a straight removal
// direction. Steps follow listing order; a group with a step is a sub-assembly that is built
// first and then moves in as one unit. This module orders the steps, computes explode offsets,
// checks that every removal is clear (ASSEMBLY.STEP.PASSES_THROUGH) and finds build-up waves.
import { K } from './wasm';
import { mat4, toVec3, v3, Vec3, Mat4 } from './math';
import { ForgeError } from './errors';
import type { RunResult, SceneObject } from './runtime';

export interface StepSpec { direction: Vec3; title?: string; note?: string }
export interface AssemblyStepInfo {
  index: number; title: string; note?: string; direction: Vec3;
  kind: 'part' | 'subAssembly'; parts: string[]; objectIds: string[]; context: string;
}
export interface InstructionPage { title: string; text: string }
export interface AssemblyStepsInfo { steps: AssemblyStepInfo[]; base: string[]; pages: InstructionPage[] }
export interface StepDiagnostic { code: string; severity: 'error' | 'warning' | 'info'; message: string; step?: number; parts?: string[]; obstacles?: string[] }

const AXES: Record<string, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], '+x': [1, 0, 0], '+y': [0, 1, 0], '+z': [0, 0, 1], '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1] };
let groupSeq = 0;

/** Normalise withAssemblyStep input: { direction: 'x'|'-z'|[x,y,z], title?, note? } (a bare direction also works). */
export function normalizeStep(step: any): StepSpec & { order?: number } {
  if (typeof step === 'number') return { direction: [0, 0, 1], order: step };
  if (typeof step === 'string' || Array.isArray(step)) step = { direction: step };
  const d = step?.direction;
  if (d == null) throw new ForgeError('ASSEMBLY.STEP.DIRECTION', 'withAssemblyStep needs { direction: "x" | "y" | "z" | [x, y, z] }');
  const dir = typeof d === 'string' ? AXES[d.toLowerCase().trim()] : toVec3(d);
  if (!dir || v3.len(dir) < 1e-9) throw new ForgeError('ASSEMBLY.STEP.DIRECTION', `assembly step direction "${d}" is not an axis or a non-zero vector`);
  return { ...step, direction: v3.norm(dir) };
}
export function normalizePage(page: any): InstructionPage {
  const title = String(page?.title ?? '').trim(), text = String(page?.text ?? '').trim();
  if (!title || !text) throw new ForgeError('ASSEMBLY.INSTRUCTION_PAGE', 'withInstructionPage needs a non-empty title and text');
  return { title, text };
}
/** Tag for the children of a group that carries a step. */
export function groupStepTag(step: any, name?: string) { return { id: `g${++groupSeq}`, name, ...normalizeStep(step) }; }
/** Rotate step directions stored in meta by a transform (directions travel with the part). */
export function transformStepMeta(meta: any, xf: Mat4): any {
  if (!meta?.assemblyStep?.direction && !meta?.assemblyGroups?.length) return meta;
  const rot = (s: any) => (s?.direction ? { ...s, direction: v3.norm(mat4.applyDir(xf, s.direction)) } : s);
  return { ...meta, assemblyStep: rot(meta.assemblyStep), assemblyGroups: meta.assemblyGroups?.map(rot) };
}

interface Leaf { kind: 'leaf'; obj: SceneObject; step?: StepSpec }
interface Node { kind: 'node'; id: string; name: string; step?: StepSpec; children: (Leaf | Node)[] }

const worldDir = (o: SceneObject, d: Vec3): Vec3 => (o.transform ? v3.norm(mat4.applyDir(o.transform, d)) : d);
const membersOf = (n: Leaf | Node): SceneObject[] => (n.kind === 'leaf' ? [n.obj] : n.children.flatMap(membersOf));
const partName = (o: SceneObject) => o.name;

function tree(result: RunResult): Node {
  const root: Node = { kind: 'node', id: 'root', name: 'model', children: [] };
  for (const o of result.objects) {
    if (o.kind !== 'solid' || o.mock) continue;
    let at = root;
    for (const g of (o.meta?.assemblyGroups ?? []) as any[]) {
      let n = at.children.find((c): c is Node => c.kind === 'node' && c.id === g.id);
      if (!n) { n = { kind: 'node', id: g.id, name: g.name ?? `sub-assembly ${at.children.length + 1}`, step: g.direction ? { direction: worldDir(o, g.direction), title: g.title, note: g.note } : undefined, children: [] }; at.children.push(n); }
      at = n;
    }
    const s = o.meta?.assemblyStep;
    at.children.push({ kind: 'leaf', obj: o, step: s?.direction ? { direction: worldDir(o, s.direction), title: s.title, note: s.note } : undefined });
  }
  return root;
}

interface Planned { info: AssemblyStepInfo; moving: SceneObject[]; obstacles: SceneObject[] }
function plan(root: Node): { planned: Planned[]; base: SceneObject[] } {
  const planned: Planned[] = [];
  const walk = (n: Node) => {
    const placed: SceneObject[] = n.children.filter((c): c is Leaf => c.kind === 'leaf' && !c.step).map((c) => c.obj);
    for (const c of n.children) {
      if (c.kind === 'leaf' && !c.step) continue;
      if (c.kind === 'node') walk(c);
      const moving = membersOf(c);
      if (c.step) {
        planned.push({
          info: {
            index: planned.length + 1, title: c.step.title ?? (c.kind === 'leaf' ? `Insert ${partName(c.obj)}` : `Install ${c.name}`), note: c.step.note, direction: c.step.direction,
            kind: c.kind === 'leaf' ? 'part' : 'subAssembly', parts: moving.map(partName), objectIds: moving.map((o) => o.id), context: n.name,
          }, moving, obstacles: [...placed],
        });
      }
      placed.push(...moving);
    }
  };
  walk(root);
  const base = root.children.filter((c): c is Leaf => c.kind === 'leaf' && !c.step).map((c) => c.obj);
  return { planned, base };
}

export function assemblySteps(result: RunResult): AssemblyStepsInfo {
  const { planned, base } = plan(tree(result));
  const pages: InstructionPage[] = [], seen = new Set<string>();
  for (const o of result.objects) for (const p of (o.meta?.instructionPages ?? []) as InstructionPage[]) { const k = `${p.title}\u0000${p.text}`; if (!seen.has(k)) { seen.add(k); pages.push(p); } }
  return { steps: planned.map((p) => p.info), base: base.map(partName), pages };
}

// ---------------------------------------------------------------- geometry
function bbox(objs: SceneObject[]) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const o of objs) {
    const m = o.mesh!; const T = o.transform;
    for (let i = 0; i < m.positions.length; i += 3) {
      const p = T ? mat4.apply(T, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]) : [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
    }
  }
  return { min: mn as Vec3, max: mx as Vec3 };
}
const extentAlong = (objs: SceneObject[], d: Vec3) => { const b = bbox(objs); return Math.abs(d[0]) * (b.max[0] - b.min[0]) + Math.abs(d[1]) * (b.max[1] - b.min[1]) + Math.abs(d[2]) * (b.max[2] - b.min[2]); };

/** Per-object explode offset at 100 %: parts stack outward along their steps (later steps sit further out). */
export function stepExplodeOffsets(result: RunResult): Record<string, Vec3> | null {
  const { planned } = plan(tree(result));
  if (!planned.length) return null;
  const out: Record<string, Vec3> = {};
  for (const o of result.objects) out[o.id] = [0, 0, 0];
  const gap = Math.max(5, 0.15 * Math.max(...(() => { const b = bbox(result.objects.filter((o) => o.kind === 'solid' && o.mesh)); return v3.sub(b.max, b.min); })()));
  const lanes: { dir: Vec3; reach: number }[] = [];
  for (const p of planned) {
    const s = extentAlong(p.moving, p.info.direction);
    let lane = lanes.find((l) => v3.dot(l.dir, p.info.direction) > 0.7);
    if (!lane) { lane = { dir: p.info.direction, reach: 0 }; lanes.push(lane); }
    lane.reach += s + gap;
    for (const o of p.moving) out[o.id] = v3.add(out[o.id], v3.scale(p.info.direction, lane.reach));
  }
  return out;
}

const solidCache = new WeakMap<SceneObject, any>();
function manifoldOf(o: SceneObject): any {
  if (solidCache.has(o)) return solidCache.get(o);
  let m: any = null;
  try {
    const k = K(), src = o.mesh!, T = o.transform;
    const pos = new Float32Array(src.positions.length);
    for (let i = 0; i < pos.length; i += 3) { const p = T ? mat4.apply(T, [src.positions[i], src.positions[i + 1], src.positions[i + 2]]) : [src.positions[i], src.positions[i + 1], src.positions[i + 2]]; pos[i] = p[0]; pos[i + 1] = p[1]; pos[i + 2] = p[2]; }
    const mesh = new k.Mesh({ numProp: 3, vertProperties: pos, triVerts: new Uint32Array(src.indices) });
    mesh.merge();
    m = new k.Manifold(mesh);
    if (m.status?.() && String(m.status()) !== 'NoError' && m.status() !== 0) m = null;
  } catch { m = null; }
  solidCache.set(o, m);
  return m;
}
const overlaps = (a: any, b: any) => { try { return a.intersect(b).volume(); } catch { return 0; } };

/** Objects among `obstacles` that `moving` passes through when moved along d from its place. */
function sweepHits(moving: SceneObject[], obstacles: SceneObject[], d: Vec3, reach: number): SceneObject[] {
  const k = K();
  const mm = moving.map(manifoldOf).filter(Boolean);
  if (!mm.length || !obstacles.length) return [];
  const mov = mm.length === 1 ? mm[0] : k.Manifold.union(mm);
  const mb = bbox(moving), size = v3.sub(mb.max, mb.min), minDim = Math.max(0.5, Math.min(...size.filter((x) => x > 1e-6)));
  const n = Math.max(8, Math.min(48, Math.ceil(reach / (minDim / 2))));
  const hits: SceneObject[] = [];
  for (const ob of obstacles) {
    const om = manifoldOf(ob);
    if (!om) continue;
    const base = overlaps(mov, om), tol = Math.max(1e-3, 1e-4 * Math.min(mov.volume(), om.volume()));
    const ob0 = bbox([ob]);
    for (let i = 1; i <= n; i++) {
      const t = v3.scale(d, (reach * i) / n);
      // bbox prefilter
      const lo = v3.add(mb.min, t), hi = v3.add(mb.max, t);
      if (lo[0] > ob0.max[0] || hi[0] < ob0.min[0] || lo[1] > ob0.max[1] || hi[1] < ob0.min[1] || lo[2] > ob0.max[2] || hi[2] < ob0.min[2]) continue;
      if (overlaps(mov.translate(t), om) > base + tol) { hits.push(ob); break; }
    }
  }
  return hits;
}

/** check_assembly step check: every removal is clear of the parts still in place. */
export function checkAssemblySteps(result: RunResult): { steps: AssemblyStepInfo[]; diagnostics: StepDiagnostic[]; waves: number[][] } {
  const { planned } = plan(tree(result));
  const diagnostics: StepDiagnostic[] = [];
  if (!planned.length) {
    diagnostics.push({ code: 'ASSEMBLY.NO_STEPS', severity: 'info', message: 'No assembly steps: add .withAssemblyStep({ direction }) to each part after the base to get an explode order, build-up video and build guide.' });
    return { steps: [], diagnostics, waves: [] };
  }
  const all = result.objects.filter((o) => o.kind === 'solid' && o.mesh && !o.mock);
  const b = bbox(all), reach = v3.len(v3.sub(b.max, b.min)) * 1.2 + 1;
  for (const p of planned) {
    const hits = sweepHits(p.moving, p.obstacles, p.info.direction, reach);
    if (hits.length) diagnostics.push({
      code: 'ASSEMBLY.STEP.PASSES_THROUGH', severity: 'error', step: p.info.index, parts: p.info.parts, obstacles: hits.map(partName),
      message: `Step ${p.info.index} (${p.info.title}): moving ${p.info.parts.join(', ')} along [${p.info.direction.map((x) => +x.toFixed(3)).join(', ')}] passes through ${hits.map(partName).join(', ')}. Choose a clear direction, change the order, or make a sub-assembly.`,
    });
  }
  // Build-up waves: consecutive steps in one context that do not block each other move together.
  const waves: number[][] = [];
  let cur: Planned[] = [];
  for (const p of planned) {
    const blocks = cur.some((q) => q.info.context !== p.info.context || sweepHits(p.moving, q.moving, p.info.direction, reach).length || sweepHits(q.moving, p.moving, q.info.direction, reach).length);
    if (cur.length && blocks) { waves.push(cur.map((q) => q.info.index)); cur = []; }
    cur.push(p);
  }
  if (cur.length) waves.push(cur.map((q) => q.info.index));
  return { steps: planned.map((p) => p.info), diagnostics, waves };
}

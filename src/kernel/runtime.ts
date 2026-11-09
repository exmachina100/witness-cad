// Runs a .forge.js project: evaluates files with the global API, resolves require(), and
// turns the returned value into renderable scene objects.
import { buildGlobals } from './globals';
import { ctxRef, RunContext, ParamDef, CheckResult, BomRow, DimRecord, LabelRecord, LogRecord } from './context';
import { allocations, Shape } from './shape';
import { Sketch } from './sketch';
import { ShapeGroup } from './ops';
import { Assembly, SolvedAssembly } from './assembly';
import { ConstraintSketch } from './constraints';
import { Curve3D } from './curves';
import { mat4, Mat4 } from './math';
import type { Manifold } from 'manifold-3d';
import { MeshRuns, SurfaceDef, surfaceTable } from './surfaces';

/** `runs` + `surfaces` let exporters rebuild exact surfaces (see kernel/surfaces.ts). */
export interface MeshData { positions: Float32Array; indices: Uint32Array; runs?: MeshRuns; surfaces?: Record<number, SurfaceDef[]> }
export interface SceneObject {
  id: string;
  name: string;
  kind: 'solid' | 'sketch' | 'curve';
  mesh?: MeshData;
  lines?: Float32Array; // xyz pairs for sketch outlines and curves
  color?: string;
  material?: any;
  mock?: boolean;
  assembly?: string;
  part?: string;
  transform?: Mat4;
  stats?: { volume: number; area: number; bbox: { min: number[]; max: number[] }; triangles: number };
  meta?: any;
}
export interface JointInfo { name: string; type: string; min?: number; max?: number; default?: any; unit?: string; parent: string; child: string; follows?: any; drive?: any }
export interface AssemblyInfo { name: string; parts: string[]; joints: JointInfo[]; poses: Record<string, any>; animations: Record<string, any>; values: Record<string, any>; warnings: string[]; simulation?: any; springs: string[]; cables: string[] }
export interface RunResult {
  ok: boolean;
  objects: SceneObject[];
  params: ParamDef[];
  checks: CheckResult[];
  bom: BomRow[];
  dims: DimRecord[];
  labels: LabelRecord[];
  logs: LogRecord[];
  scene: any;
  cutPlanes: any[];
  explode: any;
  assemblies: AssemblyInfo[];
  feaStudies?: FeaStudyInfo[];
  error?: { message: string; code?: string; line?: number; column?: number; file?: string; stack?: string };
  warnings: string[];
  timeMs: number;
  returned?: any;
}

export interface Project { files: Record<string, string>; entry?: string }

export function normalizePath(p: string) {
  const parts: string[] = [];
  for (const s of p.replace(/\\/g, '/').split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') parts.pop();
    else parts.push(s);
  }
  return parts.join('/');
}
function dirname(p: string) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }

let lastAllocations: Manifold[] = [];
export const live: { assemblies: Map<string, Assembly>; result: RunResult | null; returned: any; feaStudies: any[] } = { assemblies: new Map(), result: null, returned: undefined, feaStudies: [] };

export interface FeaStudyInfo { name: string; part?: string; material?: string; target?: number; fixtures: number; loads: number; assembly?: string }

/** World-space solids of the last run keyed by object/part name, plus per-part FEA materials, for running studies. */
export function studyTargets(returned: any = live.returned) {
  const solids = new Map<string, Shape>();
  const partMaterials = new Map<string, any>();
  const add = (n: string, s: Shape) => { if (s.isEmpty()) return; let k = n, i = 2; while (solids.has(k)) k = `${n} ${i++}`; solids.set(k, s); };
  const walk = (v: any, name: string) => {
    if (v == null) return;
    if (v instanceof Shape) { add(v.name ?? (name || 'Model'), v); return; }
    if (v instanceof ShapeGroup) { for (const ch of v.children) walk(ch.item, name ? `${name}/${ch.name}` : ch.name); return; }
    if (v instanceof Assembly || v instanceof SolvedAssembly) {
      const asm = v instanceof SolvedAssembly ? v.assembly : v;
      const solved = v instanceof SolvedAssembly ? v : asm.solve();
      for (const p of asm.parts) {
        const w = solved.getPart(p.name);
        if (p.fea?.material) partMaterials.set(p.name, p.fea.material);
        if (w instanceof Shape) add(p.name, w);
        else if (w instanceof ShapeGroup) add(p.name, w.shapes().length === 1 ? w.shapes()[0] : (w as any).toShape?.() ?? w.shapes()[0]);
      }
      return;
    }
    if (v instanceof Sketch || v instanceof ConstraintSketch || v instanceof Curve3D) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, name ? `${name}/${i + 1}` : (x?.name ?? `Item ${i + 1}`))); return; }
    if (typeof v === 'object' && v.kind !== 'staticStress') for (const [k, x] of Object.entries(v)) if (typeof x !== 'function') walk(x, name ? `${name}/${k}` : k);
  };
  walk(returned, '');
  return { solids, partMaterials };
}

/** External project resolver for require("project:alias"). */
export const projectResolver: { fn: ((alias: string) => Project | null) | null } = { fn: null };

export function runProject(project: Project, paramValues: Record<string, any> = {}, opts: { entry?: string; keepAlive?: boolean } = {}): RunResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  // Free geometry from the previous run.
  for (const m of lastAllocations) { try { m.delete(); } catch { /* already freed */ } }
  lastAllocations = [];
  allocations.list = lastAllocations;
  const c = new RunContext(paramValues);
  c.files = project.files;
  ctxRef.current = c;
  const globals = buildGlobals();
  const entry = normalizePath(opts.entry ?? project.entry ?? pickEntry(project.files));
  const cache = new Map<string, any>();
  const mainModule: any = { id: entry, filename: entry };

  const consoleProxy = {
    log: (...a: any[]) => c.log('log', ...a), info: (...a: any[]) => c.log('info', ...a),
    warn: (...a: any[]) => c.log('warn', ...a), error: (...a: any[]) => c.log('error', ...a), debug: (...a: any[]) => c.log('log', ...a),
  };

  const loadFile = (file: string, fromProject: Project, moduleObj: any): any => {
    const src = fromProject.files[file];
    if (src == null) throw Object.assign(new Error(`require: file not found "${file}"`), { code: 'REQUIRE.NOT_FOUND' });
    if (file.endsWith('.json')) return JSON.parse(src);
    const prevFile = c.currentFile;
    c.currentFile = file;
    const exportsObj: any = {};
    moduleObj.exports = exportsObj;
    const req = makeRequire(file, fromProject);
    const names = Object.keys(globals);
    const fn = new Function(...names, 'require', 'module', 'exports', 'console', '"use strict";\n' + src + `\n//# sourceURL=${file}`);
    try {
      const ret = fn(...names.map((n) => globals[n]), req, moduleObj, exportsObj, consoleProxy);
      const out = ret !== undefined ? ret : moduleObj.exports !== exportsObj || Object.keys(exportsObj).length ? moduleObj.exports : undefined;
      return out;
    } finally {
      c.currentFile = prevFile;
    }
  };

  const makeRequire = (from: string, fromProject: Project) => {
    const req: any = (spec: string) => {
      if (typeof spec !== 'string') throw new Error('require() needs a path string');
      if (spec.startsWith('project:')) {
        const alias = spec.slice(8);
        const p = projectResolver.fn?.(alias);
        if (!p) throw Object.assign(new Error(`require: unknown project "${alias}"`), { code: 'REQUIRE.PROJECT' });
        const key = `project:${alias}`;
        if (!cache.has(key)) cache.set(key, wrapImported(loadFile(normalizePath(p.entry ?? pickEntry(p.files)), p, { id: key })));
        return cache.get(key);
      }
      if (!spec.startsWith('.') && !spec.startsWith('/')) throw Object.assign(new Error(`require: use a relative path with extension, e.g. require("./${spec}")`), { code: 'REQUIRE.BARE' });
      const file = normalizePath((spec.startsWith('/') ? '' : dirname(from) + '/') + spec);
      if (!/\.(forge\.js|js|json)$/.test(file)) throw Object.assign(new Error(`require: include the file extension ("${spec}.forge.js")`), { code: 'REQUIRE.EXTENSION' });
      const key = file;
      if (!cache.has(key)) {
        cache.set(key, undefined);
        cache.set(key, wrapImported(loadFile(file, fromProject, { id: file, filename: file })));
      }
      return cache.get(key);
    };
    req.main = mainModule;
    return req;
  };

  let returned: any;
  let error: RunResult['error'];
  try {
    returned = loadFile(entry, project, mainModule);
    if (returned === undefined) c.warnings.push('The script returned nothing. End it with `return shape;`.');
  } catch (e: any) {
    error = toError(e, entry);
  }

  const objects: SceneObject[] = [];
  const assemblies: AssemblyInfo[] = [];
  live.assemblies.clear();
  live.feaStudies = [...c.feaStudies];
  if (!error) {
    try {
      collect(returned, '', objects, assemblies, c);
    } catch (e: any) {
      error = toError(e, entry);
    }
  }
  const result: RunResult = {
    ok: !error,
    objects, params: c.params, checks: c.checks, bom: c.bom, dims: c.dims, labels: c.labels, logs: c.logs, scene: c.scene,
    cutPlanes: c.cutPlanes, explode: c.explode, assemblies, error, feaStudies: live.feaStudies.map(feaInfo), warnings: [...c.warnings], timeMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
  };
  live.result = result;
  live.returned = returned;
  allocations.list = null;
  return result;
}

function feaInfo(s: any): FeaStudyInfo {
  return { name: s.name, part: s.part, material: s.material?.name, target: s.target?.value, fixtures: s.fixtures?.length ?? 0, loads: s.loads?.length ?? 0, assembly: s.assembly };
}

function wrapImported(v: any) {
  return v;
}

export function pickEntry(files: Record<string, string>): string {
  if (files['main.forge.js'] != null) return 'main.forge.js';
  const f = Object.keys(files).find((k) => k.endsWith('.forge.js'));
  if (!f) throw new Error('project has no .forge.js file');
  return f;
}

function toError(e: any, file: string): RunResult['error'] {
  const stack: string = e?.stack ?? '';
  let line: number | undefined, column: number | undefined, f = file;
  // anonymous function frames: "<anonymous>:LINE:COL" or "file.forge.js:LINE:COL"
  const m = stack.match(/([\w./-]+\.(?:forge\.)?js):(\d+):(\d+)/) ?? stack.match(/<anonymous>:(\d+):(\d+)/);
  if (m) {
    if (m.length === 4) { f = m[1]; line = Number(m[2]) - 2; column = Number(m[3]); }
    else { line = Number(m[1]) - 2; column = Number(m[2]); }
    // Function() adds two header lines ("function anonymous(" + params line) plus our "use strict" line
    if (line != null) line = Math.max(1, line - 1);
  }
  return { message: e?.message ?? String(e), code: e?.code, line, column, file: f, stack };
}

let objCounter = 0;
function meshOf(s: Shape): MeshData { const m = s.mesh; return { positions: m.positions, indices: m.indices, runs: m.runs, surfaces: surfaceTable(m.runs) }; }

function sketchLines(s: Sketch): Float32Array {
  const out: number[] = [];
  const P = s.placement ?? mat4.identity();
  for (const poly of s.toPolygons())
    for (let i = 0; i < poly.length; i++) {
      const a = mat4.apply(P, [poly[i][0], poly[i][1], 0]), b = mat4.apply(P, [poly[(i + 1) % poly.length][0], poly[(i + 1) % poly.length][1], 0]);
      out.push(...a, ...b);
    }
  return new Float32Array(out);
}

function solidObject(s: Shape, name: string, c: RunContext, extra: Partial<SceneObject> = {}): SceneObject {
  const bb = s.boundingBox();
  return {
    id: `o${++objCounter}`, name, kind: 'solid', mesh: meshOf(s), color: s.colorValue, material: s.materialProps,
    mock: c.mocks.has(s), stats: { volume: s.volume(), area: s.surfaceArea(), bbox: { min: bb.min, max: bb.max }, triangles: s.numTri() },
    meta: Object.keys(s.meta).length ? s.meta : undefined, ...extra,
  };
}

function collect(v: any, name: string, out: SceneObject[], asms: AssemblyInfo[], c: RunContext) {
  if (v == null) return;
  const nm = name || (v?.name as string) || 'Model';
  if (v instanceof Shape) { if (!v.isEmpty()) out.push(solidObject(v, v.name ?? nm, c)); return; }
  if (v instanceof Sketch) { out.push({ id: `o${++objCounter}`, name: nm, kind: 'sketch', lines: sketchLines(v), color: v.color_, mock: c.mocks.has(v) }); return; }
  if (v instanceof ConstraintSketch) { collect(v.toSketch(), nm, out, asms, c); return; }
  if (v?.kind === 'sheetMetal' || v?.kind === 'surfaceBody') { collect(v.toShape(), nm, out, asms, c); return; }
  if (v?.kind === 'laserKit') { collect(v.parts.map((p: any) => p.shape), nm, out, asms, c); return; }
  if (v instanceof Curve3D) {
    const pts = v.sample(200);
    const arr: number[] = [];
    for (let i = 0; i + 1 < pts.length; i++) arr.push(...pts[i], ...pts[i + 1]);
    out.push({ id: `o${++objCounter}`, name: nm, kind: 'curve', lines: new Float32Array(arr) });
    return;
  }
  if (v instanceof ShapeGroup) {
    for (const ch of v.children) collect(ch.item, name ? `${name}/${ch.name}` : ch.name, out, asms, c);
    return;
  }
  if (v instanceof Assembly || v instanceof SolvedAssembly) {
    const asm = v instanceof SolvedAssembly ? v.assembly : v;
    const solved = v instanceof SolvedAssembly ? v : asm.solve();
    const asmName = name || asm.name;
    live.assemblies.set(asmName, asm);
    for (const st of asm.feaStudies) if (!live.feaStudies.some((x) => x.name === st.name)) live.feaStudies.push({ ...st, assembly: asmName });
    for (const p of asm.parts) {
      const T = solved.getTransform(p.name);
      const shapes: { n: string; s: Shape }[] = p.shape instanceof Shape ? [{ n: p.name, s: p.shape }] : p.shape.shapes().map((s, i) => ({ n: `${p.name}/${p.shape instanceof ShapeGroup ? p.shape.children[i]?.name ?? i : i}`, s }));
      for (const { n, s } of shapes) if (!s.isEmpty()) out.push(solidObject(s, n, c, { assembly: asmName, part: p.name, transform: T }));
    }
    // springs and cables are rendered as world-space solids
    for (const sp of asm.springs) collect(solved.toGroup().child(`spring:${sp.name}`), `${asmName}/spring:${sp.name}`, out, asms, c);
    for (const cb of asm.cables) collect(solved.toGroup().child(`cable:${cb.name}`), `${asmName}/cable:${cb.name}`, out, asms, c);
    asms.push({
      name: asmName, parts: asm.parts.map((p) => p.name),
      joints: asm.joints.map((j) => ({ name: j.name, type: j.type, min: j.min, max: j.max, default: j.default, unit: j.unit, parent: j.parent, child: j.child, follows: j.follows, drive: j.drive })),
      poses: asm.poses, animations: asm.animations, values: solved.getJointState(), warnings: solved.warnings(), simulation: asm.simulation,
      springs: asm.springs.map((s) => s.name), cables: asm.cables.map((s) => s.name),
    });
    return;
  }
  if (Array.isArray(v)) { v.forEach((x, i) => collect(x, name ? `${name}/${i + 1}` : (x?.name ?? `Item ${i + 1}`), out, asms, c)); return; }
  if (typeof v === 'object') {
    if (v.kind === 'staticStress' || v.kind === 'feaMaterial') return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'function') continue;
      collect(x, name ? `${name}/${k}` : k, out, asms, c);
    }
  }
}

/** Re-solve a live assembly with new joint values without rebuilding geometry. */
export function solveLive(asmName: string, values: Record<string, any>) {
  const asm = live.assemblies.get(asmName);
  if (!asm) return null;
  const s = asm.solve(values);
  const transforms: Record<string, Mat4> = {};
  for (const p of asm.parts) transforms[p.name] = s.getTransform(p.name);
  return { transforms, values: s.getJointState(), warnings: s.warnings() };
}

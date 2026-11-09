/// <reference lib="webworker" />
// Evaluation worker: owns the WASM kernel, runs scripts, re-solves assemblies and produces exports.
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import interUrl from '@fontsource/inter/files/inter-latin-400-normal.woff?url';
import interBoldUrl from '@fontsource/inter/files/inter-latin-700-normal.woff?url';
import { initKernel } from '../kernel/wasm';
import { registerFont } from '../kernel/text';
import { runProject, solveLive, live, projectResolver, RunResult } from '../kernel/runtime';
import { exportModel } from '../export';
import { simulate, estimateStaticStress } from '../kernel/sim';
import { simulateDynamics, holdTest } from '../kernel/physics';
import { intersectWithPlane, projectToPlane, union } from '../kernel/ops';
import { Shape } from '../kernel/shape';
import { ShapeGroup } from '../kernel/ops';

const ready = (async () => {
  await initKernel(wasmUrl);
  for (const [k, u] of [['Inter', interUrl], ['Inter Bold', interBoldUrl]] as const) {
    try { registerFont(k, await (await fetch(u)).arrayBuffer(), k === 'Inter'); } catch { /* optional */ }
  }
})();

let projects: Record<string, { files: Record<string, string>; entry?: string }> = {};
projectResolver.fn = (alias) => projects[alias] ?? null;

function transferables(r: RunResult): Transferable[] {
  const out: Transferable[] = [];
  for (const o of r.objects) {
    if (o.mesh) { out.push(o.mesh.positions.buffer, o.mesh.indices.buffer); }
    if (o.lines) out.push(o.lines.buffer);
  }
  return out;
}

function allSolids(): Shape[] {
  const out: Shape[] = [];
  const walk = (v: any) => {
    if (!v) return;
    if (v instanceof Shape) out.push(v);
    else if (v instanceof ShapeGroup) out.push(...v.shapes());
    else if (v.kind === 'assembly' || v.kind === 'solvedAssembly') { const s = v.kind === 'assembly' ? v.solve() : v; out.push(...s.toGroup().shapes()); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(live.returned);
  return out;
}

self.onmessage = async (ev: MessageEvent) => {
  const { id, type, payload } = ev.data;
  try {
    await ready;
    let result: any;
    let transfer: Transferable[] = [];
    switch (type) {
      case 'run': {
        if (payload.projects) projects = payload.projects;
        const r = runProject({ files: payload.files, entry: payload.entry }, payload.params ?? {});
        // logs and errors stay plain data; meshes are transferred
        result = r;
        // clone typed arrays so live results keep theirs for exports
        result = { ...r, objects: r.objects.map((o) => ({ ...o, mesh: o.mesh ? { positions: o.mesh.positions.slice(), indices: o.mesh.indices.slice() } : undefined, lines: o.lines?.slice() })) };
        transfer = transferables(result);
        break;
      }
      case 'solve': result = solveLive(payload.assembly, payload.values); break;
      case 'export': {
        if (!live.result) throw new Error('build the model before exporting');
        const out = exportModel(live.result, payload.format, payload.opts ?? {});
        const data = typeof out.data === 'string' ? new TextEncoder().encode(out.data) : out.data;
        result = { ...out, data };
        transfer = [data.buffer];
        break;
      }
      case 'simulate': {
        const asm = live.assemblies.get(payload.assembly);
        if (!asm) throw new Error(`no assembly "${payload.assembly}"`);
        const opts = payload.opts ?? {};
        if (opts.engine === 'joints') {
          const sim = simulate(asm, opts);
          result = { engine: 'joints', frames: sim.frames.map((f) => ({ t: f.t, values: f.values, transforms: solveLive(payload.assembly, f.values)?.transforms })), final: sim.final };
        } else {
          const sim = simulateDynamics(asm, opts);
          result = { engine: sim.engine, frames: sim.frames, final: sim.final, summary: sim.summary, warnings: sim.warnings };
        }
        break;
      }
      case 'holdTest': {
        const asm = live.assemblies.get(payload.assembly);
        if (!asm) throw new Error(`no assembly "${payload.assembly}"`);
        result = holdTest(asm, payload.opts);
        break;
      }
      case 'collisions': {
        const asm = live.assemblies.get(payload.assembly);
        if (!asm) throw new Error(`no assembly "${payload.assembly}"`);
        result = asm.solve(payload.values).collisionReport();
        break;
      }
      case 'jointLoads': {
        const asm = live.assemblies.get(payload.assembly);
        if (!asm) throw new Error(`no assembly "${payload.assembly}"`);
        result = asm.solve(payload.values).jointLoads();
        break;
      }
      case 'section': {
        const solids = allSolids();
        if (!solids.length) throw new Error('nothing to section');
        const u = union(solids);
        const sk = payload.mode === 'projection' ? projectToPlane(u, { normal: payload.normal }) : intersectWithPlane(u, { normal: payload.normal, offset: payload.offset ?? 0 });
        result = { polygons: sk.toPolygons(), area: sk.area(), bounds: sk.bounds() };
        break;
      }
      case 'fea': {
        const solids = allSolids();
        result = estimateStaticStress(union(solids), payload.study, payload.material);
        break;
      }
      default: throw new Error(`unknown request ${type}`);
    }
    (self as any).postMessage({ id, ok: true, result }, transfer);
  } catch (e: any) {
    (self as any).postMessage({ id, ok: false, error: e?.message ?? String(e) });
  }
};

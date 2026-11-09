// Witness CAD MCP server: lets outside agents create projects, edit files, build, check, look at and export models.
// stdio by default; `--http <port>` serves streamable HTTP at /mcp.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { store, readMeta } from './store';
import { initNode, ensureStepReaderNode } from '../src/kernel/node';
import { projectNeedsStep } from '../src/kernel/importers';
import { runProject, projectResolver, live, solveLive, RunResult } from '../src/kernel/runtime';
import { exportModel, EXPORT_FORMATS } from '../src/export';
import { worldMeshes, ExportMesh } from '../src/export/mesh';
import { Shape } from '../src/kernel/shape';
import { K } from '../src/kernel/wasm';
import { union } from '../src/kernel/ops';
import { simulateDynamics, holdTest } from '../src/kernel/physics';
import { runFea } from '../src/kernel/feaRun';
import { summarizeFea } from '../src/kernel/feaStudy';
import { renderPng, RenderView } from '../src/render/raster';
import { renderTurntableGif } from '../src/render/video';
import { Analysis } from '../src/kernel/surfacing';
import { zlibSync, strToU8 } from 'fflate';
import { readDoc, searchDocs, DOCS_INDEX } from '../src/docs';
import { summarizeBuild } from '../src/app/agent-summary';
import { EXAMPLES } from '../src/app/examples';

projectResolver.fn = (alias) => store.byAlias(alias);

// ------------------------------------------------------------------ helpers
type Ref = { project: string; draft?: string; version?: string };
function filesOf(r: Ref) { return r.version ? store.versionFiles(r.project, r.version) : store.files(r.project, r.draft); }
async function build(r: Ref, params?: Record<string, any>): Promise<RunResult> {
  await initNode();
  const m = readMeta(r.project);
  if (projectNeedsStep(filesOf(r))) await ensureStepReaderNode();
  return runProject({ files: filesOf(r), entry: m.entry }, { ...(m.params ?? {}), ...(params ?? {}) });
}
function transformsFor(result: RunResult, values?: Record<string, Record<string, any>>) {
  const t: Record<string, number[]> = {};
  for (const a of result.assemblies) {
    const s = solveLive(a.name, { ...a.values, ...(values?.[a.name] ?? {}) });
    if (s) Object.assign(t, s.transforms);
  }
  return t;
}
function meshShape(m: ExportMesh): Shape {
  const k = K();
  const man = new k.Manifold(new k.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices }));
  return new Shape(man);
}
function solidsByName(result: RunResult, transforms?: Record<string, number[]>) {
  const map = new Map<string, Shape>();
  for (const m of worldMeshes(result.objects, { transforms })) { try { map.set(m.name, meshShape(m)); } catch { /* non-manifold mesh */ } }
  return map;
}
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const json = (v: any) => text(JSON.stringify(v, null, 2));
const fail = (e: any) => ({ content: [{ type: 'text' as const, text: `error: ${e?.message ?? e}` }], isError: true });
const wrap = <A,>(fn: (a: A) => Promise<any> | any) => async (a: A) => { try { return await fn(a); } catch (e) { return fail(e); } };

const jobs = new Map<string, { id: string; status: 'done' | 'failed'; kind: string; path?: string; bytes?: number; error?: string; createdAt: number }>();
const newJob = (kind: string) => 'job_' + Math.random().toString(36).slice(2, 10) + '_' + kind;

const project = z.string().describe('Project id from list_projects or create_project');
const draft = z.string().optional().describe('Draft id: read/write/build the draft instead of the working copy');
const params = z.record(z.string(), z.any()).optional().describe('Parameter overrides by name');

// ------------------------------------------------------------------ server
export function createWitnessServer() {
  const server = new McpServer({ name: 'witness-cad', version: '1.0.0' });
  const tool = (name: string, description: string, inputSchema: any, fn: (a: any) => any) => server.registerTool(name, { description, inputSchema }, wrap(fn) as any);

  tool('read_docs', `Read a Witness CAD documentation page. Pages: ${DOCS_INDEX.map((d) => d.id).join(', ')}. Read "welcome" and "core" before writing models.`,
    { page: z.string() }, ({ page }) => text(readDoc(page) ?? `no page "${page}"`));
  tool('search_docs', 'Search the Witness CAD docs for an API name or topic.', { query: z.string() },
    ({ query }) => text(searchDocs(query).map((h) => `${h.page}: ${h.snippet}`).join('\n') || 'no matches'));

  tool('list_projects', 'List projects with their ids, root file, versions and drafts.', {},
    () => json(store.list().map((m) => ({ id: m.id, name: m.name, description: m.description, entry: m.entry, alias: m.alias, versions: m.versions.length, drafts: m.drafts.length, updated: new Date(m.updatedAt).toISOString() }))));
  tool('create_project', `Create a project, optionally from an example (${EXAMPLES.map((e) => e.id).join(', ')}) or with initial files.`,
    { name: z.string(), description: z.string().optional(), example: z.string().optional(), files: z.record(z.string(), z.string()).optional(), alias: z.string().optional() },
    ({ name, description, example, files, alias }) => {
      const ex = example ? EXAMPLES.find((e) => e.id === example) : null;
      if (example && !ex) throw new Error(`no example "${example}"`);
      const m = store.create(name, files ?? ex?.files, description ?? ex?.description);
      if (alias) store.setMeta(m.id, { alias });
      return json({ id: m.id, entry: m.entry, files: Object.keys(store.files(m.id)), version: m.currentVersion });
    });
  tool('list_versions', 'List saved versions of a project.', { project },
    ({ project }) => { const m = readMeta(project); return json(m.versions.map((v) => ({ id: v.id, name: v.name, note: v.note, current: v.id === m.currentVersion, created: new Date(v.createdAt).toISOString(), files: Object.keys(v.files).length }))); });
  tool('create_draft', 'Create a draft branch from a version (default: current) or copy another draft (from_draft). Edit the draft with the draft id, then merge_draft.',
    { project, name: z.string(), base_version: z.string().optional(), from_draft: z.string().optional().describe('Start from this draft\'s files instead of a version'), brief: z.string().optional().describe('What the draft should achieve') },
    ({ project, name, base_version, from_draft, brief }) => {
      const src = from_draft ? readMeta(project).drafts.find((x) => x.id === from_draft) : null;
      if (from_draft && !src) throw new Error(`no draft "${from_draft}"`);
      const d = store.createDraft(project, name, src?.baseVersion ?? base_version, brief);
      if (src) for (const [path, content] of Object.entries(src.files)) store.write(project, path, content, d.id);
      return json({ draft: d.id, baseVersion: d.baseVersion, from: from_draft });
    });
  tool('list_drafts', 'List open drafts of a project.', { project },
    ({ project }) => json(readMeta(project).drafts.map((d) => ({ id: d.id, name: d.name, brief: d.brief, baseVersion: d.baseVersion, files: Object.keys(d.files) }))));
  tool('merge_draft', 'Merge a draft into the project as a new saved version.', { project, draft: z.string(), name: z.string().optional() },
    ({ project, draft, name }) => { const d = readMeta(project).drafts.find((x) => x.id === draft); if (!d) throw new Error(`no draft "${draft}"`); const v = store.saveVersion(project, name ?? d.name, d.brief, draft); return json({ version: v.id, name: v.name }); });

  tool('read_file', 'Read a project file. Omit path to list files.', { project, path: z.string().optional(), draft, version: z.string().optional() },
    ({ project, path, draft, version }) => {
      const f = filesOf({ project, draft, version });
      if (!path) return text(Object.keys(f).sort().join('\n'));
      if (f[path] === undefined) throw new Error(`no file "${path}". Files: ${Object.keys(f).join(', ')}`);
      return text(f[path]);
    });
  tool('write_file', 'Create or overwrite a project file with full content.', { project, path: z.string(), content: z.string(), draft },
    ({ project, path, content, draft }) => { store.write(project, path, content, draft); return text(`wrote ${path} (${content.length} chars)`); });
  tool('edit_file', 'Replace exactly one occurrence of old_string with new_string.', { project, path: z.string(), old_string: z.string(), new_string: z.string(), draft },
    ({ project, path, old_string, new_string, draft }) => {
      const f = store.files(project, draft)[path];
      if (f === undefined) throw new Error(`no file "${path}"`);
      const n = f.split(old_string).length - 1;
      if (n !== 1) throw new Error(`old_string must occur exactly once (found ${n})`);
      store.write(project, path, f.replace(old_string, new_string), draft);
      return text(`edited ${path}`);
    });
  tool('save_version', 'Save the working copy (or a draft) as a named version.', { project, name: z.string(), note: z.string().optional(), draft },
    ({ project, name, note, draft }) => { const v = store.saveVersion(project, name, note, draft); return json({ version: v.id }); });

  tool('build_model', 'Build the model. Returns errors with file/line, warnings, verify checks, params, objects with size/volume, assemblies and BOM.',
    { project, draft, version: z.string().optional(), params },
    async ({ project, draft, version, params }) => text(summarizeBuild(await build({ project, draft, version }, params))));
  tool('build_variants', 'Build several parameter variants and compare checks, sizes and volumes.',
    { project, draft, variants: z.array(z.object({ name: z.string(), params: z.record(z.string(), z.any()) })) },
    async ({ project, draft, variants }) => {
      const rows: any[] = [];
      for (const v of variants) {
        const r = await build({ project, draft }, v.params);
        rows.push({ variant: v.name, ok: r.ok, error: r.error?.message, checks: r.checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.label}`), volume: r.objects.reduce((s, o) => s + (o.stats?.volume ?? 0), 0), objects: r.objects.length });
      }
      return json(rows);
    });
  tool('check_names', 'List the names the model exposes: objects, assembly parts, joints, connectors-bearing parts and params; flags duplicates.',
    { project, draft },
    async ({ project, draft }) => {
      const r = await build({ project, draft });
      const names = r.objects.map((o) => o.name);
      const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
      return json({ ok: r.ok, objects: names, duplicates: dupes, params: r.params.map((p) => p.name), assemblies: r.assemblies.map((a) => ({ name: a.name, parts: a.parts, joints: a.joints.map((j) => `${j.name} (${j.type}: ${j.parent} → ${j.child})`) })) });
    });
  tool('check_fit', 'Check fit between two named objects: overlap volume (interference) and minimum gap.',
    { project, draft, a: z.string(), b: z.string(), min_clearance: z.number().optional().describe('Required clearance in mm'), joint_values: z.record(z.string(), z.record(z.string(), z.any())).optional() },
    async ({ project, draft, a, b, min_clearance, joint_values }) => {
      const r = await build({ project, draft });
      if (!r.ok) throw new Error(r.error?.message);
      const solids = solidsByName(r, transformsFor(r, joint_values));
      const A = solids.get(a), B = solids.get(b);
      if (!A || !B) throw new Error(`objects: ${[...solids.keys()].join(', ')}`);
      const overlap = A.intersect(B).volume();
      const gap = overlap > 1e-6 ? 0 : A.minGap(B, Math.max(50, (min_clearance ?? 0) * 4));
      return json({ a, b, overlapVolume: overlap, minGap: gap, interferes: overlap > 1e-6, pass: overlap <= 1e-6 && (min_clearance == null || gap >= min_clearance) });
    });
  tool('check_assembly', 'Solve assemblies at given joint values and report collisions, loop-closure warnings and joints.',
    { project, draft, joint_values: z.record(z.string(), z.record(z.string(), z.any())).optional() },
    async ({ project, draft, joint_values }) => {
      const r = await build({ project, draft });
      if (!r.ok) throw new Error(r.error?.message);
      if (!r.assemblies.length) return text('The model returns no assembly.');
      return json(r.assemblies.map((a) => {
        const asm = live.assemblies.get(a.name)!;
        const solved = asm.solve({ ...a.values, ...(joint_values?.[a.name] ?? {}) });
        return { assembly: a.name, joints: a.joints.map((j) => ({ name: j.name, type: j.type, min: j.min, max: j.max })), warnings: solved.warnings(), collisions: solved.collisionReport() };
      }));
    });
  tool('check_joint_torque', 'Gravity torque at each joint (N·m) compared with servo limits declared through Sim.drive.servo({ maxTorqueNm }).',
    { project, draft, joint_values: z.record(z.string(), z.record(z.string(), z.any())).optional() },
    async ({ project, draft, joint_values }) => {
      const r = await build({ project, draft });
      if (!r.ok) throw new Error(r.error?.message);
      return json(r.assemblies.map((a) => {
        const solved = live.assemblies.get(a.name)!.solve({ ...a.values, ...(joint_values?.[a.name] ?? {}) });
        const loads = solved.jointLoads();
        return { assembly: a.name, joints: Object.entries(loads).map(([j, t]) => { const lim = a.joints.find((x) => x.name === j)?.drive?.maxTorqueNm; return { joint: j, torqueNm: +t.toFixed(4), limitNm: lim, pass: lim == null ? undefined : Math.abs(t) <= lim }; }) };
      }));
    });
  tool('check_strength', 'Finite element static stress solve (linear elastic, hexahedral mesh). Runs a study declared with Fea.study.staticStress in the model, or a quick study from fix_face/load_face/newtons. Returns max and 99th-percentile von Mises stress, max displacement, safety factor vs yield, reactions and solver stats.',
    { project, draft,
      study: z.string().optional().describe('Name of a declared study; defaults to the first one'),
      part: z.string().optional().describe('Quick study: part to analyse (default: whole model)'),
      fix_face: z.string().optional().describe('Quick study: face held fixed, e.g. "bottom" or a face label'),
      load_face: z.string().optional().describe('Quick study: face the force acts on, e.g. "top"'),
      newtons: z.number().optional().describe('Quick study: total force in N'),
      direction: z.array(z.number()).length(3).optional().describe('Quick study: force direction, default [0,0,-1]'),
      material: z.string().optional().describe('Quick study: Fea.materials key, e.g. aluminum6061T6, isotropicPrintedPla, astmA36StructuralSteel'),
      target_safety_factor: z.number().optional(),
      gravity: z.boolean().optional().describe('Quick study: add self weight'),
      target_elements: z.number().optional().describe('Mesh density (default 12000 elements)'),
      element_size: z.number().optional().describe('Element edge length in mm (overrides target_elements)') },
    async ({ project, draft, study, part, fix_face, load_face, newtons, direction, material, target_safety_factor, gravity, target_elements, element_size }) => {
      const r = await build({ project, draft });
      if (!r.ok) throw new Error(r.error?.message);
      const quick = fix_face || load_face || newtons != null
        ? { part, fix: fix_face ?? 'bottom', load: load_face ?? 'top', newtons: newtons ?? 100, direction: direction as any, material: material ?? 'isotropicPrintedPla', targetSafetyFactor: target_safety_factor, gravity }
        : undefined;
      if (!quick && !r.feaStudies?.length) throw new Error('the model declares no Fea.study.staticStress studies; pass fix_face, load_face and newtons for a quick study');
      const res = runFea({ study, quick, targetElements: target_elements, elementSize: element_size, fields: false });
      return json({ studies: r.feaStudies, result: summarizeFea(res) });
    });
  tool('check_manufacturing', 'Printability/manufacturing checks per object: closed manifold, size vs build volume, overhang area, thin-feature hint, genus.',
    { project, draft, process: z.enum(['fdm', 'sla', 'cnc', 'laser']).optional(), build_volume: z.array(z.number()).length(3).optional() },
    async ({ project, draft, process = 'fdm', build_volume = [256, 256, 256] }) => {
      const r = await build({ project, draft });
      if (!r.ok) throw new Error(r.error?.message);
      const out: any[] = [];
      for (const m of worldMeshes(r.objects)) {
        let overhang = 0, total = 0;
        let minZ = Infinity;
        for (let i = 2; i < m.positions.length; i += 3) minZ = Math.min(minZ, m.positions[i]);
        for (let t = 0; t < m.indices.length; t += 3) {
          const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]].map((k) => [m.positions[k * 3], m.positions[k * 3 + 1], m.positions[k * 3 + 2]]);
          const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          const area = Math.hypot(n[0], n[1], n[2]) / 2; total += area;
          const nz = n[2] / (2 * area || 1);
          const onBed = Math.max(a[2], b[2], c[2]) < minZ + 0.05;
          if (nz < -Math.cos(Math.PI / 4) && !onBed) overhang += area;
        }
        const o = r.objects.find((x) => x.name === m.name)!;
        const size = o.stats!.bbox.max.map((x, i) => x - o.stats!.bbox.min[i]);
        let manifold = true, genus = 0;
        try { const s = meshShape(m); genus = s.genus(); } catch { manifold = false; }
        const fits = size.every((s, i) => s <= build_volume[i]);
        const thin = o.stats!.volume / Math.max(1e-6, o.stats!.area) < 0.4;
        const issues = [!manifold && 'mesh is not a closed manifold', !fits && `larger than build volume ${build_volume.join('×')}`, process === 'fdm' && overhang / total > 0.08 && `${((overhang / total) * 100).toFixed(0)}% of area overhangs beyond 45° (supports needed)`, thin && 'very thin features (volume/area < 0.4 mm)'].filter(Boolean);
        out.push({ object: m.name, size: size.map((s) => +s.toFixed(2)), volume: +o.stats!.volume.toFixed(2), genus, overhangArea: +overhang.toFixed(1), issues, pass: issues.length === 0 });
      }
      return json({ process, objects: out });
    });
  tool('check_simready', 'Check that assemblies are ready for simulation export (URDF/MJCF/SDF): joint limits, drives, masses, collisions, export test.',
    { project, draft },
    async ({ project, draft }) => {
      const r = await build({ project, draft });
      if (!r.ok) throw new Error(r.error?.message);
      if (!r.assemblies.length) return text('No assembly: return an Assembly to export robots.');
      return json(r.assemblies.map((a) => {
        const issues: string[] = [];
        for (const j of a.joints) {
          if ((j.type === 'revolute' || j.type === 'prismatic') && (j.min == null || j.max == null)) issues.push(`joint ${j.name} has no limits`);
          if ((j.type === 'revolute' || j.type === 'prismatic') && !j.drive) issues.push(`joint ${j.name} has no drive (passive)`);
        }
        const solved = live.assemblies.get(a.name)!.solve(a.values);
        const col = solved.collisionReport();
        for (const c of col.collisions as any[]) if (!c.jointed) issues.push(`parts ${c.a} and ${c.b} overlap ${c.volume.toFixed(1)} mm³`);
        let dynamics: any;
        try {
          const sim = simulateDynamics(live.assemblies.get(a.name)!, { duration: 0.5, initial: a.values, sampleHz: 10 });
          dynamics = { settled: sim.summary.settled, maxPenetrationMm: +sim.summary.maxPenetrationMm.toFixed(2), kineticEnergyJ: +sim.summary.kineticEnergyJ.toFixed(5) };
          if (sim.summary.maxPenetrationMm > 5) issues.push(`contacts penetrate ${sim.summary.maxPenetrationMm.toFixed(1)} mm in a 0.5 s dynamics run (check colliders and masses)`);
          for (const [j, d] of Object.entries(sim.summary.drives)) if (d.limit != null && d.saturatedS > 0.25) issues.push(`drive ${j} saturates at its ${d.limit} limit while holding the rest pose`);
        } catch (e: any) { dynamics = { error: e.message }; issues.push(`dynamics run failed: ${e.message}`); }
        const formats: Record<string, string> = {};
        for (const f of ['urdf', 'mjcf', 'sdf'] as const) { try { const e = exportModel(r, f, { assembly: a.name }); formats[f] = `ok (${typeof e.data === 'string' ? e.data.length : e.data.byteLength} bytes)`; } catch (e: any) { formats[f] = `failed: ${e.message}`; issues.push(`${f} export failed`); } }
        return { assembly: a.name, dynamics, mass: a.parts.map((p) => ({ part: p, kg: +solved.massOf(live.assemblies.get(a.name)!.part(p)).toFixed(4) })), exports: formats, issues, pass: issues.length === 0 };
      }));
    });
  tool('simulate_model', 'Rigid-body dynamics of each assembly: gravity, contacts with the ground and between parts (convex-hull colliders, friction, restitution), joints as constraints with limits and Sim.drive drives. Returns where every part ends up, whether the model settles, peak drive effort and joint travel.',
    { project, draft, assembly: z.string().optional(), duration: z.number().optional().describe('seconds, default 2'), dt: z.number().optional().describe('time step in s, default 0.002'),
      targets: z.record(z.string(), z.number()).optional().describe('servo targets per joint (deg or mm)'), joint_values: z.record(z.string(), z.any()).optional().describe('initial joint values'),
      ground: z.boolean().optional(), frames: z.number().optional().describe('number of evenly spaced frames of joint values to include (default 5)') },
    async ({ project, draft, assembly, duration, dt, targets, joint_values, ground, frames = 5 }) => {
      const r = await build({ project, draft });
      if (!r.ok) throw new Error(r.error?.message);
      const names = assembly ? [assembly] : r.assemblies.map((a) => a.name);
      if (!names.length) return text('No assembly: return an Assembly (or use Sim.drop in the script) to simulate.');
      return json(names.map((n) => {
        const asm = live.assemblies.get(n);
        if (!asm) throw new Error(`no assembly "${n}"`);
        const res = simulateDynamics(asm, { duration, dt, targets, initial: joint_values, ground: ground === false ? false : undefined, sampleHz: 30 });
        const pick = frames > 0 ? Array.from({ length: frames }, (_, i) => res.frames[Math.round((i * (res.frames.length - 1)) / Math.max(1, frames - 1))]) : [];
        const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(3)]));
        return { assembly: n, ...res.summary, parts: Object.fromEntries(Object.entries(res.summary.parts).map(([k, p]) => [k, { displacementMm: +p.displacementMm.toFixed(2), rotationDeg: +p.rotationDeg.toFixed(2), finalCenterMm: p.finalCenterMm.map((x) => +x.toFixed(2)), resting: p.resting }])),
          final: round(res.final), frames: pick.map((f) => ({ t: +f.t.toFixed(3), values: round(f.values) })), warnings: res.warnings };
      }));
    });
  tool('check_hold', 'Hold test: apply a constant torque (N·m) or force (N) to one joint for a few seconds and check it moves less than max_travel (deg or mm). A control run without the load is subtracted.',
    { project, draft, assembly: z.string().optional(), joint: z.string(), load: z.number(), seconds: z.number().optional(), max_travel: z.number().optional() },
    async ({ project, draft, assembly, joint, load, seconds, max_travel }) => {
      const r = await build({ project, draft });
      if (!r.ok) throw new Error(r.error?.message);
      const name = assembly ?? r.assemblies.find((a) => a.joints.some((j) => j.name === joint))?.name;
      const asm = name ? live.assemblies.get(name) : undefined;
      if (!asm) throw new Error(`no assembly with joint "${joint}"`);
      return json(holdTest(asm, { joint, load, seconds, maxTravel: max_travel }));
    });
  tool('read_make_list', 'Parts to make or buy (by process) and the bill of materials.', { project, draft },
    async ({ project, draft }) => {
      const r = await build({ project, draft });
      if (!r.ok) throw new Error(r.error?.message);
      return json({ parts: r.objects.filter((o) => o.kind === 'solid' && !o.mock).map((o) => ({ name: o.name, process: o.meta?.process ?? 'print', material: o.material?.name, size: o.stats?.bbox.max.map((v, i) => +(v - o.stats!.bbox.min[i]).toFixed(2)), volume: o.stats?.volume })), bom: r.bom });
    });
  tool('compare_versions', 'Compare two versions (or a version and the working copy): changed files and model differences.',
    { project, a: z.string().describe('Version id'), b: z.string().optional().describe('Version id; default the working copy') },
    async ({ project, a, b }) => {
      const fa = store.versionFiles(project, a), fb = b ? store.versionFiles(project, b) : store.files(project);
      const changed = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter((k) => fa[k] !== fb[k]).map((k) => ({ file: k, status: fa[k] === undefined ? 'added' : fb[k] === undefined ? 'removed' : 'modified', linesBefore: fa[k]?.split('\n').length, linesAfter: fb[k]?.split('\n').length }));
      const sum = (r: RunResult) => ({ ok: r.ok, error: r.error?.message, objects: r.objects.map((o) => ({ name: o.name, volume: +(o.stats?.volume ?? 0).toFixed(2) })), checks: r.checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.label}`) });
      const ra = sum(await build({ project, version: a }));
      const rb = sum(b ? await build({ project, version: b }) : await build({ project }));
      return json({ changedFiles: changed, before: ra, after: rb });
    });
  tool('view_model', 'Render the model to a PNG so you can look at it. Views: iso, front, back, left, right, top, bottom.',
    { project, draft, view: z.enum(['iso', 'front', 'back', 'left', 'right', 'top', 'bottom']).optional(), joint_values: z.record(z.string(), z.record(z.string(), z.any())).optional(), params, width: z.number().optional(), height: z.number().optional() },
    async ({ project, draft, view, joint_values, params, width, height }) => {
      const r = await build({ project, draft }, params);
      if (!r.ok) throw new Error(summarizeBuild(r));
      const png = renderPng(r, { view: view as RenderView, transforms: transformsFor(r, joint_values), width: Math.min(width ?? 800, 1600), height: Math.min(height ?? 560, 1200) });
      return { content: [{ type: 'image' as const, data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }, { type: 'text' as const, text: `${view ?? 'iso'} view, ${r.objects.length} objects` }] };
    });
  tool('export_model', `Export the model to a file in the project's exports folder. Formats: ${Object.keys(EXPORT_FORMATS).join(', ')}.`,
    { project, draft, format: z.string(), assembly: z.string().optional(), joint_values: z.record(z.string(), z.record(z.string(), z.any())).optional() },
    async ({ project, draft, format, assembly, joint_values }) => {
      const id = newJob(format);
      try {
        const r = await build({ project, draft });
        if (!r.ok) throw new Error(r.error?.message);
        const e = exportModel(r, format as any, { name: readMeta(project).name, assembly, transforms: transformsFor(r, joint_values) });
        const path = join(store.exportsDir(project), e.filename);
        const data = typeof e.data === 'string' ? Buffer.from(e.data) : Buffer.from(e.data);
        writeFileSync(path, data);
        jobs.set(id, { id, status: 'done', kind: format, path, bytes: data.length, createdAt: Date.now() });
      } catch (err: any) { jobs.set(id, { id, status: 'failed', kind: format, error: err.message, createdAt: Date.now() }); }
      return json(jobs.get(id));
    });
  tool('export_drawing', 'Export a dimensioned three-view part drawing (SVG) with the BOM.', { project, draft },
    async ({ project, draft }) => {
      const r = await build({ project, draft });
      if (!r.ok) throw new Error(r.error?.message);
      const e = exportModel(r, 'drawing', { name: readMeta(project).name });
      const path = join(store.exportsDir(project), e.filename);
      writeFileSync(path, e.data as any);
      const id = newJob('drawing');
      jobs.set(id, { id, status: 'done', kind: 'drawing', path, bytes: String(e.data).length, createdAt: Date.now() });
      return json(jobs.get(id));
    });

  tool('check_surfaces', 'Check surface sheets, bodies and product skins the model returns: area, degenerate or folded cells, open edges, and whether bodies close into solids.',
    { project, draft, params },
    async ({ project, draft, params }) => {
      const r = await build({ project, draft }, params);
      if (!r.ok) throw new Error(summarizeBuild(r));
      const found: any[] = [];
      const walk = (v: any, name: string) => {
        if (v == null || typeof v !== 'object') return;
        if (v.kind === 'surfaceSheet') { found.push({ name, kind: 'sheet', ...Analysis.SurfaceHealth(v) }); return; }
        if (v.kind === 'productSkin') { found.push({ name, kind: 'productSkin', stations: v.stations.length, ...Analysis.SurfaceHealth(v.surface()) }); return; }
        if (v.kind === 'surfaceBody') { const open = v.openEdges(1e-2); found.push({ name, kind: 'body', sheets: v.sheets.length, openEdges: open.length, closed: open.length === 0, sheetHealth: v.sheets.map((sh: any) => Analysis.SurfaceHealth(sh).ok) }); return; }
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${name}[${i}]`));
        else if (v.constructor === Object) for (const [k, x] of Object.entries(v)) walk(x, name ? `${name}.${k}` : k);
      };
      walk(live.returned, '');
      if (!found.length) return text('The model returns no surface sheets, bodies or product skins. Return them (for example `return { skin, sheet }`) to check them.');
      const bad = found.filter((f) => f.ok === false || f.closed === false);
      return json({ ok: bad.length === 0, surfaces: found });
    });
  tool('compare_to_reference', 'Compare the model with a reference: a saved version id, or a mesh/STEP file in the project (STL, OBJ, 3MF, PLY, STEP). Reports volumes, bounding boxes, overlap (IoU) and the volume only in one or the other.',
    { project, draft, reference: z.string().describe('Version id or project file name'), params },
    async ({ project, draft, reference, params }) => {
      const r = await build({ project, draft }, params);
      if (!r.ok) throw new Error(summarizeBuild(r));
      const mine = worldMeshes(r.objects).map((m) => ({ ...m, positions: m.positions.slice(), indices: m.indices.slice() }));
      const meta = readMeta(project);
      let refFiles: Record<string, string>, refEntry: string | undefined;
      if (meta.versions.some((v) => v.id === reference)) { refFiles = store.versionFiles(project, reference); refEntry = meta.entry; }
      else {
        const files = filesOf({ project, draft });
        if (files[reference] == null) throw new Error(`"${reference}" is neither a version id nor a project file`);
        refFiles = { ...files, '__reference.forge.js': `return ${/\.(step|stp)$/i.test(reference) ? 'Import.step' : 'Import.mesh'}(${JSON.stringify(reference)});` };
        refEntry = '__reference.forge.js';
        if (/\.(step|stp)$/i.test(reference)) await ensureStepReaderNode();
      }
      const rr = runProject({ files: refFiles, entry: refEntry }, {});
      if (!rr.ok) throw new Error(`reference did not build: ${rr.error?.message}`);
      const k = K();
      const solid = (ms: ExportMesh[]) => k.Manifold.union(ms.map((m) => { const mesh = new k.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices }); mesh.merge(); return new k.Manifold(mesh); }));
      const A = solid(mine), B = solid(worldMeshes(rr.objects));
      const inter = A.intersect(B).volume(), va = A.volume(), vb = B.volume();
      const bb = (m: any) => { const b = m.boundingBox(); return { min: Array.from(b.min as number[]).map((v) => +v.toFixed(3)), max: Array.from(b.max as number[]).map((v) => +v.toFixed(3)) }; };
      return json({ model: { volume: +va.toFixed(3), bounds: bb(A) }, reference: { volume: +vb.toFixed(3), bounds: bb(B) }, overlapVolume: +inter.toFixed(3), onlyInModel: +(va - inter).toFixed(3), onlyInReference: +(vb - inter).toFixed(3), iou: +(inter / Math.max(1e-9, va + vb - inter)).toFixed(4) });
    });
  tool('paint_model', 'Set display/export colours of objects by name (writes paint.json, which overrides colours from the code). Use "*" for every object; pass null to clear a name.',
    { project, draft, colors: z.record(z.string(), z.string().nullable()) },
    ({ project, draft, colors }) => {
      const prev = store.files(project, draft)['paint.json'];
      let map: Record<string, string> = {};
      try { map = prev ? JSON.parse(prev) : {}; } catch { map = {}; }
      for (const [n, c] of Object.entries(colors as Record<string, string | null>)) { if (c == null) delete map[n]; else { if (!/^#?[0-9a-f]{3,8}$/i.test(c)) throw new Error(`"${c}" is not a hex colour`); map[n] = c.startsWith('#') ? c : '#' + c; } }
      store.write(project, 'paint.json', JSON.stringify(map, null, 2) + '\n', draft);
      return json({ paint: map });
    });
  tool('render_picture', 'Render a picture of the model (PNG), save it in the project\'s exports folder and return it. Views: iso, front, back, left, right, top, bottom; or give azimuth/elevation in degrees.',
    { project, draft, version: z.string().optional(), view: z.enum(['iso', 'front', 'back', 'left', 'right', 'top', 'bottom']).optional(), azimuth: z.number().optional(), elevation: z.number().optional(), width: z.number().optional(), height: z.number().optional(), background: z.string().optional().describe('Hex colour'), params, joint_values: z.record(z.string(), z.record(z.string(), z.any())).optional() },
    async ({ project, draft, version, view, azimuth, elevation, width, height, background, params, joint_values }) => {
      const r = await build({ project, draft, version }, params);
      if (!r.ok) throw new Error(summarizeBuild(r));
      const dir = azimuth != null || elevation != null ? (() => { const a = ((azimuth ?? -50) * Math.PI) / 180, e = ((elevation ?? 30) * Math.PI) / 180; return [Math.cos(a) * Math.cos(e), Math.sin(a) * Math.cos(e), Math.sin(e)] as [number, number, number]; })() : undefined;
      const bg = background ? (background.replace('#', '').match(/../g) ?? []).map((h: string) => parseInt(h, 16)) as [number, number, number] : undefined;
      const png = renderPng(r, { view: view as RenderView, direction: dir, background: bg, transforms: transformsFor(r, joint_values), width: Math.min(width ?? 1200, 2400), height: Math.min(height ?? 800, 1600) });
      const path = join(store.exportsDir(project), `${readMeta(project).name.replace(/[^\w.-]+/g, '_')}-${view ?? 'view'}-${Date.now()}.png`);
      writeFileSync(path, png);
      return { content: [{ type: 'image' as const, data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }, { type: 'text' as const, text: `saved ${path}` }] };
    });
  tool('render_video', 'Render a turntable video of the model as an animated GIF, save it in the exports folder and return its path.',
    { project, draft, frames: z.number().optional(), fps: z.number().optional(), elevation: z.number().optional(), width: z.number().optional(), height: z.number().optional(), params },
    async ({ project, draft, frames, fps, elevation, width, height, params }) => {
      const r = await build({ project, draft }, params);
      if (!r.ok) throw new Error(summarizeBuild(r));
      const gif = renderTurntableGif(r, { frames, fps, elevation, width: Math.min(width ?? 480, 960), height: Math.min(height ?? 360, 720) });
      const path = join(store.exportsDir(project), `${readMeta(project).name.replace(/[^\w.-]+/g, '_')}-turntable.gif`);
      writeFileSync(path, gif);
      const id = newJob('video');
      jobs.set(id, { id, status: 'done', kind: 'video', path, bytes: gif.length, createdAt: Date.now() });
      return json(jobs.get(id));
    });
  tool('read_version_picture', 'Picture (PNG) of a saved version, to see what it looked like.',
    { project, version: z.string(), view: z.enum(['iso', 'front', 'back', 'left', 'right', 'top', 'bottom']).optional() },
    async ({ project, version, view }) => {
      const r = await build({ project, version });
      if (!r.ok) throw new Error(`version ${version} does not build: ${r.error?.message}`);
      const png = renderPng(r, { view: view as RenderView, width: 800, height: 560 });
      const v = readMeta(project).versions.find((x) => x.id === version)!;
      return { content: [{ type: 'image' as const, data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }, { type: 'text' as const, text: `${v.name} (${new Date(v.createdAt).toISOString()})` }] };
    });
  tool('get_link', 'Get a share link that opens the project (all files) in the Witness CAD web app. Set WITNESS_APP_URL or pass app_url for a hosted app.',
    { project, draft, app_url: z.string().optional() },
    ({ project, draft, app_url }) => {
      const m = readMeta(project);
      const z = zlibSync(strToU8(JSON.stringify({ name: m.name, description: m.description, files: filesOf({ project, draft }), entry: m.entry })), { level: 9 });
      const code = Buffer.from(z).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const base = (app_url ?? process.env.WITNESS_APP_URL ?? 'http://localhost:5173/').replace(/#.*$/, '');
      return json({ url: `${base}#/share/${code}`, bytes: code.length });
    });
  tool('add_surface_detail', 'Add knurling, grooves, ribs, dimples, bumps, hex pockets or text to a planar face of a named object (stored in details.json and applied at build). Returns the build summary.',
    { project, draft, object: z.string().describe('Object name as built, or "*"'), face: z.string().optional().describe('Face name, default top'),
      kind: z.enum(['knurl', 'grooves', 'ribs', 'dimples', 'bumps', 'hex', 'text']), text: z.string().optional(), depth: z.number().optional(), height: z.number().optional(),
      mode: z.enum(['emboss', 'deboss']).optional(), spacing: z.number().optional(), size: z.number().optional(), angle: z.number().optional(), margin: z.number().optional(), width: z.number().optional(),
      replace: z.boolean().optional().describe('Drop earlier details on the same object and face') },
    async ({ project, draft, replace, ...d }) => {
      const prev = store.files(project, draft)['details.json'];
      let list: any[] = [];
      try { list = prev ? JSON.parse(prev) : []; } catch { list = []; }
      const entry = { face: 'top', ...Object.fromEntries(Object.entries(d).filter(([k, v]) => v !== undefined && k !== 'project')) } as any;
      if (replace) list = list.filter((x) => !(x.object === entry.object && (x.face ?? 'top') === entry.face));
      list.push(entry);
      store.write(project, 'details.json', JSON.stringify(list, null, 2) + '\n', draft);
      const r = await build({ project, draft });
      const warn = r.warnings.filter((w) => w.startsWith('surface detail'));
      if (warn.length) throw new Error(warn.join('\n'));
      return text(`added ${entry.kind} to ${entry.object}.${entry.face} (${list.length} detail(s) in details.json)\n\n${summarizeBuild(r)}`);
    });
  tool('get_job', 'Get the status and output path of an export job.', { job: z.string() },
    ({ job }) => { const j = jobs.get(job); if (!j) throw new Error(`no job "${job}"`); return json(j); });

  return server;
}

// ------------------------------------------------------------------ transports
async function main() {
  const i = process.argv.indexOf('--http');
  if (i < 0) {
    await createWitnessServer().connect(new StdioServerTransport());
    return;
  }
  const port = Number(process.argv[i + 1] ?? 8787);
  createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end('Witness CAD MCP: POST /mcp'); return; }
    const server = createWitnessServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => transport.handleRequest(req, res, body ? JSON.parse(body) : undefined));
  }).listen(port, () => console.error(`Witness CAD MCP listening on http://localhost:${port}/mcp`));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.ts')) main();

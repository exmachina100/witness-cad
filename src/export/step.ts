// STEP AP214 writer for exact B-rep solids (ADVANCED_BREP_SHAPE_REPRESENTATION).
import type { ExportMesh } from './mesh';
import { Brep, buildBrep, BrepError, CurveGeom, Surf } from './brep';
import { NurbsSurface, nurbsCone, nurbsCylinder, nurbsSphere, nurbsTorus, transformSurfaceNurbs } from '../kernel/nurbs';
import { v3, Vec3 } from '../kernel/math';

export const escStep = (s: string) => s.replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_');

/** STEP REAL: always has a decimal point, exponent written with E. */
export function stepReal(v: number): string {
  if (!Number.isFinite(v)) throw new BrepError('non-finite coordinate');
  if (Math.abs(v) < 1e-300) return '0.';
  let s = String(Number(v.toPrecision(15)));
  if (s.includes('e')) {
    let [m, e] = s.split('e');
    if (!m.includes('.')) m += '.';
    s = `${m}E${e.replace('+', '')}`;
  } else if (!s.includes('.')) s += '.';
  return s;
}

class Writer {
  lines: string[] = [];
  private n = 0;
  add(s: string): number { this.n++; this.lines.push(`#${this.n}=${s};`); return this.n; }
  point(p: Vec3) { return this.add(`CARTESIAN_POINT('',(${p.map(stepReal).join(',')}))`); }
  dir(d: Vec3) { return this.add(`DIRECTION('',(${v3.norm(d).map(stepReal).join(',')}))`); }
  placement(o: Vec3, z: Vec3, x?: Vec3) {
    const zz = v3.norm(z);
    let xx = x ? v3.sub(x, v3.scale(zz, v3.dot(x, zz))) : v3.perp(zz);
    if (v3.len(xx) < 1e-9) xx = v3.perp(zz);
    return this.add(`AXIS2_PLACEMENT_3D('',#${this.point(o)},#${this.dir(zz)},#${this.dir(xx)})`);
  }
}

const ref = (ids: number[]) => `(${ids.map((i) => '#' + i).join(',')})`;
const bool = (b: boolean) => (b ? '.T.' : '.F.');

export function toStepExact(meshes: ExportMesh[], name = 'witness_model'): string {
  const breps = meshes.map((m) => ({ mesh: m, brep: buildBrep(m) }));
  const W = new Writer();
  const ctxApp = W.add(`APPLICATION_CONTEXT('automotive design')`);
  W.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${ctxApp})`);
  const len = W.add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const ang = W.add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const sol = W.add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = W.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#${len},'distance_accuracy_value','confusion accuracy')`);
  const geoCtx = W.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${len},#${ang},#${sol}))REPRESENTATION_CONTEXT('Context3D','3D Context with 1e-6 uncertainty'))`);
  const prodCtx = W.add(`PRODUCT_CONTEXT('',#${ctxApp},'mechanical')`);
  const defCtx = W.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${ctxApp},'design')`);
  const axis = W.placement([0, 0, 0], [0, 0, 1], [1, 0, 0]);

  const solids: number[] = [];
  const styled: number[] = [];
  for (const { mesh, brep } of breps) {
    for (const solid of writeSolids(W, brep, mesh.name)) {
      solids.push(solid);
      styled.push(writeColour(W, solid, mesh.color));
    }
  }
  const rep = W.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('${escStep(name)}',${ref([axis, ...solids])},#${geoCtx})`);
  W.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',${ref(styled)},#${geoCtx})`);
  const prod = W.add(`PRODUCT('${escStep(name)}','${escStep(name)}','',(#${prodCtx}))`);
  const form = W.add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
  const pdef = W.add(`PRODUCT_DEFINITION('design','',#${form},#${defCtx})`);
  const pds = W.add(`PRODUCT_DEFINITION_SHAPE('','',#${pdef})`);
  W.add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);
  const now = new Date().toISOString().slice(0, 19);
  return ['ISO-10303-21;', 'HEADER;', `FILE_DESCRIPTION(('Witness CAD exact B-rep'),'2;1');`,
    `FILE_NAME('${escStep(name)}.step','${now}',('Witness CAD'),(''),'Witness CAD','Witness CAD','');`,
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`, 'ENDSEC;', 'DATA;', ...W.lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}

function writeColour(W: Writer, item: number, c: [number, number, number, number]): number {
  const col = W.add(`COLOUR_RGB('',${stepReal(c[0])},${stepReal(c[1])},${stepReal(c[2])})`);
  const fasc = W.add(`FILL_AREA_STYLE_COLOUR('',#${col})`);
  const fas = W.add(`FILL_AREA_STYLE('',(#${fasc}))`);
  const ssfa = W.add(`SURFACE_STYLE_FILL_AREA(#${fas})`);
  const sss = W.add(`SURFACE_SIDE_STYLE('',(#${ssfa}))`);
  const ssu = W.add(`SURFACE_STYLE_USAGE(.BOTH.,#${sss})`);
  const psa = W.add(`PRESENTATION_STYLE_ASSIGNMENT((#${ssu}))`);
  return W.add(`STYLED_ITEM('color',(#${psa}),#${item})`);
}

function writeCurve(W: Writer, c: CurveGeom): number {
  switch (c.type) {
    case 'line': return W.add(`LINE('',#${W.point(c.p)},#${W.add(`VECTOR('',#${W.dir(c.d)},1.)`)})`);
    case 'circle': return W.add(`CIRCLE('',#${W.placement(c.c, c.axis, c.ref)},${stepReal(c.r)})`);
    case 'bspline': {
      const pts = c.ctrl.map((p) => W.point(p));
      return W.add(`B_SPLINE_CURVE_WITH_KNOTS('',${c.degree},${ref(pts)},.UNSPECIFIED.,.F.,.F.,(${c.mults.join(',')}),(${c.knots.map(stepReal).join(',')}),.UNSPECIFIED.)`);
    }
  }
}

function toNurbs(s: Surf): NurbsSurface {
  if (s.type === 'nurbs') return s.surf;
  if (s.type !== 'mapped') throw new BrepError(`no spline form for ${s.type}`);
  const b = s.base;
  let n: NurbsSurface;
  switch (b.type) {
    case 'cylinder': n = nurbsCylinder(b.origin, b.axis, b.radius, s.range?.[0] ?? 0, s.range?.[1] ?? 1); break;
    case 'cone': n = nurbsCone(b.origin, b.axis, b.radius, b.slope, s.range?.[0] ?? -b.radius / b.slope, s.range?.[1] ?? 0); break;
    case 'sphere': n = nurbsSphere(b.center, b.radius); break;
    case 'torus': n = nurbsTorus(b.center, b.axis, b.major, b.minor); break;
    default: throw new BrepError(`no spline form for ${b.type}`);
  }
  return transformSurfaceNurbs(n, s.M);
}

function knotList(U: number[]): { knots: number[]; mults: number[] } {
  const knots: number[] = [], mults: number[] = [];
  for (const x of U) {
    if (knots.length && Math.abs(knots[knots.length - 1] - x) < 1e-14) mults[mults.length - 1]++;
    else { knots.push(x); mults.push(1); }
  }
  return { knots, mults };
}

function writeNurbsSurface(W: Writer, s: NurbsSurface): number {
  const rows: string[] = [];
  for (let i = 0; i < s.nu; i++) {
    const ids: number[] = [];
    for (let j = 0; j < s.nv; j++) ids.push(W.point(s.ctrl[i * s.nv + j]));
    rows.push(ref(ids));
  }
  const ku = knotList(s.knotsU), kv = knotList(s.knotsV);
  const knotPart = `(${ku.mults.join(',')}),(${kv.mults.join(',')}),(${ku.knots.map(stepReal).join(',')}),(${kv.knots.map(stepReal).join(',')}),.UNSPECIFIED.`;
  const w = s.weights;
  if (!w || w.every((x) => Math.abs(x - 1) < 1e-15))
    return W.add(`B_SPLINE_SURFACE_WITH_KNOTS('',${s.degU},${s.degV},(${rows.join(',')}),.UNSPECIFIED.,.F.,.F.,.F.,${knotPart})`);
  const wrows: string[] = [];
  for (let i = 0; i < s.nu; i++) {
    const r: string[] = [];
    for (let j = 0; j < s.nv; j++) r.push(stepReal(w[i * s.nv + j]));
    wrows.push(`(${r.join(',')})`);
  }
  return W.add(`(BOUNDED_SURFACE()B_SPLINE_SURFACE(${s.degU},${s.degV},(${rows.join(',')}),.UNSPECIFIED.,.F.,.F.,.F.)B_SPLINE_SURFACE_WITH_KNOTS(${knotPart})GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE((${wrows.join(',')}))REPRESENTATION_ITEM('')SURFACE())`);
}

/** Writes every shell of the B-rep; returns the solid entity ids (voids are folded into their solid). */
function writeSolids(W: Writer, b: Brep, name: string): number[] {
  const surfIds = new Map<number, number>();
  const surface = (i: number) => {
    let id = surfIds.get(i);
    if (id !== undefined) return id;
    const s = b.surfaces[i];
    switch (s.type) {
      case 'plane': id = W.add(`PLANE('',#${W.placement(s.origin, s.normal)})`); break;
      case 'cylinder': id = W.add(`CYLINDRICAL_SURFACE('',#${W.placement(s.origin, s.axis)},${stepReal(s.radius)})`); break;
      case 'cone': id = W.add(`CONICAL_SURFACE('',#${W.placement(s.origin, s.axis)},${stepReal(s.radius)},${stepReal(Math.atan(s.slope))})`); break;
      case 'sphere': id = W.add(`SPHERICAL_SURFACE('',#${W.placement(s.center, [0, 0, 1], [1, 0, 0])},${stepReal(s.radius)})`); break;
      case 'torus': id = W.add(`TOROIDAL_SURFACE('',#${W.placement(s.center, s.axis)},${stepReal(s.major)},${stepReal(s.minor)})`); break;
      default: id = writeNurbsSurface(W, toNurbs(s)); break;
    }
    surfIds.set(i, id!);
    return id!;
  };
  const vIds = new Map<number, number>();
  const vertex = (i: number) => {
    let id = vIds.get(i);
    if (id === undefined) { id = W.add(`VERTEX_POINT('',#${W.point(b.vertices[i].p)})`); vIds.set(i, id); }
    return id;
  };
  const eIds = new Map<number, number>();
  const edge = (i: number) => {
    let id = eIds.get(i);
    if (id === undefined) {
      const e = b.edges[i];
      id = W.add(`EDGE_CURVE('',#${vertex(e.v0)},#${vertex(e.v1)},#${writeCurve(W, e.curve)},.T.)`);
      eIds.set(i, id);
    }
    return id;
  };
  const face = (fi: number) => {
    const f = b.faces[fi];
    const bounds = f.loops.map((l, li) => {
      const oes = l.edges.map((oe) => W.add(`ORIENTED_EDGE('',*,*,#${edge(oe.edge)},${bool(oe.forward)})`));
      const loop = W.add(`EDGE_LOOP('',${ref(oes)})`);
      return W.add(`${li === f.outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${loop},.T.)`);
    });
    return W.add(`ADVANCED_FACE('',${ref(bounds)},#${surface(f.surface)},${bool(f.sense)})`);
  };

  const outers = b.shells.map((s, i) => ({ s, i })).filter((x) => x.s.volume > 0);
  const voids = b.shells.map((s, i) => ({ s, i })).filter((x) => x.s.volume <= 0);
  if (!outers.length) throw new BrepError('mesh has no positive-volume shell');
  const voidsOf = new Map<number, number[]>();
  for (const v of voids) {
    // the smallest outer shell whose box contains the void
    let host = -1, hostVol = Infinity;
    for (const o of outers) {
      const inside = [0, 1, 2].every((k) => v.s.min[k] >= o.s.min[k] - 1e-9 && v.s.max[k] <= o.s.max[k] + 1e-9);
      if (inside && o.s.volume < hostVol) { host = o.i; hostVol = o.s.volume; }
    }
    if (host < 0) throw new BrepError('void shell outside every solid');
    voidsOf.set(host, [...(voidsOf.get(host) ?? []), v.i]);
  }
  const out: number[] = [];
  const nm = escStep(name);
  for (const o of outers) {
    const shell = W.add(`CLOSED_SHELL('',${ref(o.s.faces.map(face))})`);
    const vs = voidsOf.get(o.i);
    if (!vs) { out.push(W.add(`MANIFOLD_SOLID_BREP('${nm}',#${shell})`)); continue; }
    const voidShells = vs.map((vi) => {
      const cs = W.add(`CLOSED_SHELL('',${ref(b.shells[vi].faces.map(face))})`);
      return W.add(`ORIENTED_CLOSED_SHELL('',*,#${cs},.F.)`);
    });
    out.push(W.add(`BREP_WITH_VOIDS('${nm}',#${shell},${ref(voidShells)})`));
  }
  return out;
}

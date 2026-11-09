// Mesh exporters: STL, OBJ, 3MF, GLB, PLY, USDA, STEP (exact B-rep, faceted fallback), plus SVG drawings.
import { escStep, toStepExact } from './step';
import { BrepError } from './brep';
import { zipSync, strToU8 } from 'fflate';
import { ExportMesh, merged, safeName } from './mesh';

const enc = new TextEncoder();

export function toStlBinary(meshes: ExportMesh[]): Uint8Array {
  const { positions: p, indices: ix } = merged(meshes);
  const n = ix.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const header = enc.encode('Witness CAD binary STL');
  new Uint8Array(buf).set(header.slice(0, 80));
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const v of [nx, ny, nz, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]]) { dv.setFloat32(o, v, true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}

export function toStlAscii(meshes: ExportMesh[]): string {
  const lines: string[] = [];
  for (const m of meshes) {
    const p = m.positions;
    lines.push(`solid ${safeName(m.name)}`);
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      lines.push(` facet normal ${nx / l} ${ny / l} ${nz / l}`, '  outer loop');
      for (const i of [a, b, c]) lines.push(`   vertex ${p[i]} ${p[i + 1]} ${p[i + 2]}`);
      lines.push('  endloop', ' endfacet');
    }
    lines.push(`endsolid ${safeName(m.name)}`);
  }
  return lines.join('\n');
}

export function toObj(meshes: ExportMesh[]): { obj: string; mtl: string } {
  const out: string[] = ['# Witness CAD OBJ export (units: mm)', 'mtllib model.mtl'];
  const mtl: string[] = ['# Witness CAD materials'];
  let base = 1;
  meshes.forEach((m, i) => {
    const mat = `mat_${i}_${safeName(m.name)}`;
    mtl.push(`newmtl ${mat}`, `Kd ${m.color[0].toFixed(4)} ${m.color[1].toFixed(4)} ${m.color[2].toFixed(4)}`, `d ${m.color[3]}`, '');
    out.push(`o ${safeName(m.name)}`, `usemtl ${mat}`);
    for (let v = 0; v < m.positions.length; v += 3) out.push(`v ${m.positions[v]} ${m.positions[v + 1]} ${m.positions[v + 2]}`);
    for (let t = 0; t < m.indices.length; t += 3) out.push(`f ${m.indices[t] + base} ${m.indices[t + 1] + base} ${m.indices[t + 2] + base}`);
    base += m.positions.length / 3;
  });
  return { obj: out.join('\n'), mtl: mtl.join('\n') };
}

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0').toUpperCase();

export function to3mf(meshes: ExportMesh[], title = 'Witness CAD model'): Uint8Array {
  const colors = meshes.map((m) => `#${hex2(m.color[0])}${hex2(m.color[1])}${hex2(m.color[2])}${hex2(m.color[3])}`);
  const objs: string[] = [];
  const items: string[] = [];
  meshes.forEach((m, i) => {
    const id = i + 2;
    const verts: string[] = [];
    for (let v = 0; v < m.positions.length; v += 3) verts.push(`<vertex x="${m.positions[v]}" y="${m.positions[v + 1]}" z="${m.positions[v + 2]}"/>`);
    const tris: string[] = [];
    for (let t = 0; t < m.indices.length; t += 3) tris.push(`<triangle v1="${m.indices[t]}" v2="${m.indices[t + 1]}" v3="${m.indices[t + 2]}"/>`);
    objs.push(`<object id="${id}" name="${escapeXml(m.name)}" type="model" pid="1" pindex="${i}"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}"/>`);
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${escapeXml(title)}</metadata><metadata name="Application">Witness CAD</metadata>
<resources><basematerials id="1">${colors.map((c, i) => `<base name="${escapeXml(meshes[i].name)}" displaycolor="${c}"/>`).join('')}</basematerials>${objs.join('')}</resources>
<build>${items.join('')}</build></model>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`),
    '3D/3dmodel.model': strToU8(model),
  };
  return zipSync(files);
}

export function escapeXml(s: string) { return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!); }

/** Binary glTF 2.0 with one node + mesh + PBR material per object. Converts Z-up mm to Y-up metres. */
export function toGlb(meshes: ExportMesh[], opts: { zUp?: boolean } = {}): Uint8Array {
  const bufferViews: any[] = [], accessors: any[] = [], gmeshes: any[] = [], nodes: any[] = [], materials: any[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (data: Uint8Array, target: number) => {
    const pad = (4 - (data.byteLength % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target });
    chunks.push(data);
    if (pad) chunks.push(new Uint8Array(pad));
    offset += data.byteLength + pad;
    return bufferViews.length - 1;
  };
  meshes.forEach((m, i) => {
    const pos = new Float32Array(m.positions.length);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < pos.length; v += 3) {
      const x = m.positions[v] / 1000, y = m.positions[v + 1] / 1000, z = m.positions[v + 2] / 1000;
      const out = opts.zUp ? [x, y, z] : [x, z, -y];
      pos.set(out, v);
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], out[k]); max[k] = Math.max(max[k], out[k]); }
    }
    const pv = push(new Uint8Array(pos.buffer), 34962);
    const iv = push(new Uint8Array(new Uint32Array(m.indices).buffer), 34963);
    accessors.push({ bufferView: pv, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    accessors.push({ bufferView: iv, componentType: 5125, count: m.indices.length, type: 'SCALAR' });
    materials.push({
      name: m.name,
      pbrMetallicRoughness: { baseColorFactor: m.color, metallicFactor: m.material?.metalness ?? 0.05, roughnessFactor: m.material?.roughness ?? 0.5 },
      ...(m.color[3] < 1 ? { alphaMode: 'BLEND' } : {}), doubleSided: false,
    });
    gmeshes.push({ name: m.name, primitives: [{ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1, material: i }] });
    nodes.push({ name: m.name, mesh: i });
  });
  const json = { asset: { version: '2.0', generator: 'Witness CAD' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes: gmeshes, materials, accessors, bufferViews, buffers: [{ byteLength: offset }] };
  let jsonBytes = enc.encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) { const t = new Uint8Array(jsonBytes.length + jpad); t.set(jsonBytes); t.fill(0x20, jsonBytes.length); jsonBytes = t; }
  const total = 12 + 8 + jsonBytes.length + 8 + offset;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  let o = 20 + jsonBytes.length;
  dv.setUint32(o, offset, true); dv.setUint32(o + 4, 0x004e4942, true);
  o += 8;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

export function toPly(meshes: ExportMesh[]): string {
  const { positions: p, indices: ix } = merged(meshes);
  const lines = ['ply', 'format ascii 1.0', 'comment Witness CAD', `element vertex ${p.length / 3}`, 'property float x', 'property float y', 'property float z', `element face ${ix.length / 3}`, 'property list uchar int vertex_indices', 'end_header'];
  for (let i = 0; i < p.length; i += 3) lines.push(`${p[i]} ${p[i + 1]} ${p[i + 2]}`);
  for (let i = 0; i < ix.length; i += 3) lines.push(`3 ${ix[i]} ${ix[i + 1]} ${ix[i + 2]}`);
  return lines.join('\n');
}

/** USD ASCII stage, Z-up, metres. */
export function toUsda(meshes: ExportMesh[], opts: { name?: string; physics?: boolean } = {}): string {
  const root = safeName(opts.name ?? 'Model');
  const out = ['#usda 1.0', '(', '    defaultPrim = "' + root + '"', '    metersPerUnit = 0.001', '    upAxis = "Z"', '    doc = "Witness CAD export"', ')', '', `def Xform "${root}"`, '{'];
  for (const m of meshes) {
    const pts: string[] = [];
    for (let i = 0; i < m.positions.length; i += 3) pts.push(`(${m.positions[i]}, ${m.positions[i + 1]}, ${m.positions[i + 2]})`);
    out.push(`    def Mesh "${safeName(m.name)}"${opts.physics ? ' (\n        prepend apiSchemas = ["PhysicsRigidBodyAPI", "PhysicsCollisionAPI", "PhysicsMeshCollisionAPI"]\n    )' : ''}`, '    {');
    out.push(`        int[] faceVertexCounts = [${new Array(m.indices.length / 3).fill(3).join(', ')}]`);
    out.push(`        int[] faceVertexIndices = [${Array.from(m.indices).join(', ')}]`);
    out.push(`        point3f[] points = [${pts.join(', ')}]`);
    out.push(`        color3f[] primvars:displayColor = [(${m.color[0]}, ${m.color[1]}, ${m.color[2]})]`);
    out.push('        uniform token subdivisionScheme = "none"', '    }');
  }
  out.push('}');
  return out.join('\n');
}

/**
 * ISO 10303-21 (AP214) STEP file. Solids are written as exact B-rep (true planes, cylinders, cones,
 * spheres and tori, see brep.ts). If a mesh cannot be rebuilt as a closed B-rep the whole file falls
 * back to a faceted B-rep, which every CAD tool still opens.
 */
export function toStep(meshes: ExportMesh[], name = 'witness_model'): string {
  try {
    return toStepExact(meshes, name);
  } catch (e) {
    if (!(e instanceof BrepError)) console.warn('exact STEP export failed, writing faceted STEP instead:', e);
    return toStepFaceted(meshes, name);
  }
}

/** Faceted B-rep STEP: one planar triangle per face. */
export function toStepFaceted(meshes: ExportMesh[], name = 'witness_model'): string {
  let id = 0;
  const lines: string[] = [];
  const add = (s: string) => { id++; lines.push(`#${id}=${s};`); return id; };
  const ctxApp = add(`APPLICATION_CONTEXT('automotive design')`);
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${ctxApp})`);
  const len = add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const ang = add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const sol = add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#${len},'distance_accuracy_value','confusion accuracy')`);
  const geoCtx = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${len},#${ang},#${sol}))REPRESENTATION_CONTEXT('Context3D','3D Context with 1e-6 uncertainty'))`);
  const prodCtx = add(`PRODUCT_CONTEXT('',#${ctxApp},'mechanical')`);
  const defCtx = add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${ctxApp},'design')`);
  const origin = add(`CARTESIAN_POINT('',(0.,0.,0.))`);
  const dz = add(`DIRECTION('',(0.,0.,1.))`), dx = add(`DIRECTION('',(1.,0.,0.))`);
  const axis = add(`AXIS2_PLACEMENT_3D('',#${origin},#${dz},#${dx})`);
  const f = (v: number) => { const s = v.toPrecision(10); return s.includes('.') || s.includes('e') ? s.replace('e', 'E') : s + '.'; };
  const breps: number[] = [];
  for (const m of meshes) {
    const pts: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3) pts.push(add(`CARTESIAN_POINT('',(${f(m.positions[i])},${f(m.positions[i + 1])},${f(m.positions[i + 2])}))`));
    const faces: number[] = [];
    for (let t = 0; t < m.indices.length; t += 3) {
      const loop = add(`POLY_LOOP('',(#${pts[m.indices[t]]},#${pts[m.indices[t + 1]]},#${pts[m.indices[t + 2]]}))`);
      const bound = add(`FACE_OUTER_BOUND('',#${loop},.T.)`);
      faces.push(add(`FACE('',(#${bound}))`));
    }
    const shell = add(`CLOSED_SHELL('',(${faces.map((x) => '#' + x).join(',')}))`);
    breps.push(add(`FACETED_BREP('${escStep(m.name)}',#${shell})`));
  }
  const rep = add(`FACETED_BREP_SHAPE_REPRESENTATION('${escStep(name)}',(#${axis},${breps.map((b) => '#' + b).join(',')}),#${geoCtx})`);
  const prod = add(`PRODUCT('${escStep(name)}','${escStep(name)}','',(#${prodCtx}))`);
  const form = add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
  const pdef = add(`PRODUCT_DEFINITION('design','',#${form},#${defCtx})`);
  const pds = add(`PRODUCT_DEFINITION_SHAPE('','',#${pdef})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);
  const now = new Date().toISOString().slice(0, 19);
  return ['ISO-10303-21;', 'HEADER;', `FILE_DESCRIPTION(('Witness CAD faceted B-rep'),'2;1');`, `FILE_NAME('${escStep(name)}.step','${now}',('Witness CAD'),(''),'Witness CAD','Witness CAD','');`, `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`, 'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n');
}

export { safeName };

// Import.*: read DXF / SVG outlines as sketches, STL / OBJ / 3MF / PLY meshes and STEP solids as shapes.
// Sources are project files (by name), raw text, data: URLs, or bytes.
import { unzipSync, strFromU8 } from 'fflate';
import { ForgeError } from './errors';
import { K } from './wasm';
import { Shape } from './shape';
import { Sketch, catmullRom } from './sketch';
import { ctx } from './context';
import type { Vec2 } from './math';

/** Set by ensureStepReader() once the OpenCascade reader is loaded (node or browser). */
export const stepReader: { fn: ((bytes: Uint8Array) => { positions: number[]; indices: number[]; name?: string; color?: number[] }[]) | null } = { fn: null };

// ---------------------------------------------------------------- sources
function b64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  return new Uint8Array((globalThis as any).Buffer.from(b64, 'base64'));
}
function resolve(src: any): { bytes: Uint8Array; text: () => string; name: string } {
  let name = 'inline';
  if (typeof src === 'string') {
    const files = (ctx() as any).files as Record<string, string> | undefined;
    const key = files && (files[src] != null ? src : files[src.replace(/^\.\//, '')] != null ? src.replace(/^\.\//, '') : null);
    if (key) { name = key; src = files![key]; }
  }
  if (typeof src === 'string') {
    const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(src);
    if (m) { const bytes = m[1] ? b64ToBytes(m[2]) : new TextEncoder().encode(decodeURIComponent(m[2])); return { bytes, text: () => strFromU8(bytes), name }; }
    const s = src;
    return { bytes: new TextEncoder().encode(s), text: () => s, name };
  }
  const bytes = src instanceof Uint8Array ? src : src instanceof ArrayBuffer ? new Uint8Array(src) : null;
  if (!bytes) throw new ForgeError('IMPORT.BAD_SOURCE', 'Import expects a project file name, text, a data: URL or bytes');
  return { bytes, text: () => strFromU8(bytes), name };
}

// ---------------------------------------------------------------- meshes
function meshShape(positions: ArrayLike<number>, tris: ArrayLike<number>, o: { scale?: number; name?: string } = {}): Shape {
  const k = K();
  const s = o.scale ?? 1;
  const vp = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i++) vp[i] = positions[i] * s;
  const mesh = new k.Mesh({ numProp: 3, vertProperties: vp, triVerts: new Uint32Array(tris) });
  mesh.merge();
  let m;
  try { m = new k.Manifold(mesh); } catch (e: any) { throw new ForgeError('IMPORT.NOT_MANIFOLD', `imported mesh${o.name ? ` "${o.name}"` : ''} is not a closed solid (${e?.message ?? e}); use Import.mesh(..., { hull: true }) to wrap it`); }
  return new Shape(m, { name: o.name });
}
function parseStl(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  const pos: number[] = [], tri: number[] = [];
  if (bytes.byteLength === 84 + n * 50 && n > 0) {
    for (let i = 0; i < n; i++) { const o = 84 + i * 50 + 12; for (let v = 0; v < 3; v++) { tri.push(pos.length / 3); pos.push(dv.getFloat32(o + v * 12, true), dv.getFloat32(o + v * 12 + 4, true), dv.getFloat32(o + v * 12 + 8, true)); } }
    return { pos, tri };
  }
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  const text = strFromU8(bytes);
  let m; while ((m = re.exec(text))) { tri.push(pos.length / 3); pos.push(+m[1], +m[2], +m[3]); }
  return { pos, tri };
}
function parseObj(text: string) {
  const pos: number[] = [], tri: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'v') pos.push(+t[1], +t[2], +t[3]);
    else if (t[0] === 'f') {
      const idx = t.slice(1).map((x) => { const i = parseInt(x.split('/')[0], 10); return i < 0 ? pos.length / 3 + i : i - 1; });
      for (let i = 1; i + 1 < idx.length; i++) tri.push(idx[0], idx[i], idx[i + 1]);
    }
  }
  return { pos, tri };
}
function parsePly(text: string) {
  const lines = text.split(/\r?\n/);
  let nv = 0, nf = 0, i = 0;
  for (; i < lines.length; i++) { const l = lines[i].trim(); if (l.startsWith('element vertex')) nv = +l.split(/\s+/)[2]; if (l.startsWith('element face')) nf = +l.split(/\s+/)[2]; if (l === 'end_header') { i++; break; } }
  if (/format binary/.test(text.slice(0, 400))) throw new ForgeError('IMPORT.PLY_BINARY', 'only ASCII PLY is supported; export STL or OBJ instead');
  const pos: number[] = [], tri: number[] = [];
  for (let k = 0; k < nv; k++) { const t = lines[i + k].trim().split(/\s+/); pos.push(+t[0], +t[1], +t[2]); }
  for (let k = 0; k < nf; k++) { const t = lines[i + nv + k].trim().split(/\s+/).map(Number); for (let j = 2; j < t[0]; j++) tri.push(t[1], t[1 + j - 1], t[1 + j]); }
  return { pos, tri };
}
function parse3mf(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  const model = Object.keys(files).find((f) => /3dmodel\.model$/i.test(f));
  if (!model) throw new ForgeError('IMPORT.3MF', '3MF has no 3D/3dmodel.model');
  const xml = strFromU8(files[model]);
  const objects: { name?: string; pos: number[]; tri: number[] }[] = [];
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let m;
  while ((m = objRe.exec(xml))) {
    const pos: number[] = [], tri: number[] = [];
    const vRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g; let v;
    while ((v = vRe.exec(m[2]))) pos.push(+v[1], +v[2], +v[3]);
    const tRe = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/g; let t;
    while ((t = tRe.exec(m[2]))) tri.push(+t[1], +t[2], +t[3]);
    if (tri.length) objects.push({ name: /name="([^"]*)"/.exec(m[1])?.[1], pos, tri });
  }
  return objects;
}

function formatOf(name: string, bytes: Uint8Array, given?: string): string {
  if (given) return given.toLowerCase();
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext) return ext === 'stp' ? 'step' : ext;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return '3mf';
  const head = strFromU8(bytes.subarray(0, 200));
  if (/^ISO-10303/.test(head)) return 'step';
  if (/^ply/.test(head)) return 'ply';
  if (/^solid/.test(head) && /facet/.test(strFromU8(bytes.subarray(0, 2000)))) return 'stl';
  if (/^\s*(v|#|o|g|mtllib)\s/m.test(head)) return 'obj';
  return 'stl';
}

// ---------------------------------------------------------------- 2D
/** Flatten DXF entities (LWPOLYLINE, POLYLINE, LINE chains, CIRCLE, ARC, ELLIPSE, SPLINE) into closed loops. */
export function parseDxf(text: string, o: { layer?: string; tolerance?: number } = {}): Vec2[][] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i], 10), lines[i + 1]]);
  const loops: Vec2[][] = [];
  const segs: [Vec2, Vec2][] = [];
  const open: Vec2[][] = [];
  let i = pairs.findIndex((p) => p[0] === 2 && p[1] === 'ENTITIES');
  if (i < 0) i = 0;
  const arcPts = (cx: number, cy: number, r: number, a0: number, a1: number): Vec2[] => {
    while (a1 <= a0) a1 += 360;
    const n = Math.max(8, Math.ceil((a1 - a0) / 5));
    return Array.from({ length: n + 1 }, (_, k) => { const a = ((a0 + ((a1 - a0) * k) / n) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Vec2; });
  };
  while (i < pairs.length) {
    if (pairs[i][0] !== 0) { i++; continue; }
    const type = pairs[i][1];
    if (type === 'EOF' || type === 'ENDSEC') { if (type === 'EOF') break; i++; continue; }
    const ent: [number, string][] = [];
    let j = i + 1;
    while (j < pairs.length && pairs[j][0] !== 0) ent.push(pairs[j++]);
    const get = (c: number, d = 0) => { const p = ent.find((e) => e[0] === c); return p ? parseFloat(p[1]) : d; };
    const layer = ent.find((e) => e[0] === 8)?.[1];
    if (o.layer && layer !== o.layer) { i = j; continue; }
    if (type === 'LWPOLYLINE') {
      const pts: Vec2[] = []; let x: number | null = null;
      for (const [c, v] of ent) { if (c === 10) x = parseFloat(v); else if (c === 20 && x != null) { pts.push([x, parseFloat(v)]); x = null; } }
      ((get(70) & 1) ? loops : open).push(pts);
    } else if (type === 'POLYLINE') {
      const closed = (get(70) & 1) === 1; const pts: Vec2[] = [];
      while (j < pairs.length && pairs[j][1] !== 'SEQEND') {
        if (pairs[j][0] === 0 && pairs[j][1] === 'VERTEX') { let k = j + 1, x = 0, y = 0; while (k < pairs.length && pairs[k][0] !== 0) { if (pairs[k][0] === 10) x = +pairs[k][1]; if (pairs[k][0] === 20) y = +pairs[k][1]; k++; } pts.push([x, y]); j = k; } else j++;
      }
      (closed ? loops : open).push(pts);
    } else if (type === 'LINE') segs.push([[get(10), get(20)], [get(11), get(21)]]);
    else if (type === 'CIRCLE') loops.push(arcPts(get(10), get(20), get(40), 0, 360).slice(0, -1));
    else if (type === 'ARC') open.push(arcPts(get(10), get(20), get(40), get(50), get(51)));
    else if (type === 'ELLIPSE') {
      const cx = get(10), cy = get(20), mx = get(11), my = get(21), ratio = get(40, 1), t0 = get(41, 0), t1 = get(42, Math.PI * 2);
      const a = Math.hypot(mx, my), rot = Math.atan2(my, mx), n = 72, pts: Vec2[] = [];
      for (let k = 0; k <= n; k++) { const t = t0 + ((t1 - t0) * k) / n; const x = a * Math.cos(t), y = a * ratio * Math.sin(t); pts.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]); }
      (Math.abs(t1 - t0 - Math.PI * 2) < 1e-6 ? loops : open).push(Math.abs(t1 - t0 - Math.PI * 2) < 1e-6 ? pts.slice(0, -1) : pts);
    } else if (type === 'SPLINE') {
      const pts: Vec2[] = []; let x: number | null = null;
      const fit = ent.some((e) => e[0] === 11);
      for (const [c, v] of ent) { if (c === (fit ? 11 : 10)) x = parseFloat(v); else if (c === (fit ? 21 : 20) && x != null) { pts.push([x, parseFloat(v)]); x = null; } }
      const closed = (get(70) & 1) === 1;
      const smooth = catmullRom(pts, closed);
      (closed ? loops : open).push(smooth);
    }
    i = j;
  }
  // Chain open pieces (lines, arcs, open polylines) end to end into loops.
  const tol = o.tolerance ?? 1e-3;
  const pieces: Vec2[][] = [...open, ...segs.map((s) => [s[0], s[1]])];
  const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  while (pieces.length) {
    let chain = pieces.shift()!;
    let grew = true;
    while (grew && !near(chain[0], chain[chain.length - 1])) {
      grew = false;
      for (let k = 0; k < pieces.length; k++) {
        const p = pieces[k], end = chain[chain.length - 1];
        if (near(p[0], end)) chain = [...chain, ...p.slice(1)];
        else if (near(p[p.length - 1], end)) chain = [...chain, ...p.slice(0, -1).reverse()];
        else continue;
        pieces.splice(k, 1); grew = true; break;
      }
    }
    if (chain.length > 2 && near(chain[0], chain[chain.length - 1])) loops.push(chain.slice(0, -1));
  }
  return loops;
}

/** Parse SVG path data, rect, circle, ellipse, polygon and polyline into loops (y flipped so +y is up). */
export function parseSvg(text: string, o: { flipY?: boolean; scale?: number } = {}): Vec2[][] {
  const loops: Vec2[][] = [];
  const attr = (tag: string, n: string, d = 0) => { const m = new RegExp(`\\s${n}="([^"]*)"`).exec(tag); return m ? parseFloat(m[1]) : d; };
  const tags = text.match(/<(path|rect|circle|ellipse|polygon|polyline)\b[^>]*>/g) ?? [];
  for (const tag of tags) {
    const kind = /^<(\w+)/.exec(tag)![1];
    if (kind === 'rect') { const x = attr(tag, 'x'), y = attr(tag, 'y'), w = attr(tag, 'width'), h = attr(tag, 'height'); loops.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]); }
    else if (kind === 'circle' || kind === 'ellipse') {
      const cx = attr(tag, 'cx'), cy = attr(tag, 'cy'), rx = kind === 'circle' ? attr(tag, 'r') : attr(tag, 'rx'), ry = kind === 'circle' ? rx : attr(tag, 'ry');
      loops.push(Array.from({ length: 72 }, (_, k) => [cx + rx * Math.cos((k * Math.PI) / 36), cy + ry * Math.sin((k * Math.PI) / 36)] as Vec2));
    } else if (kind === 'polygon' || kind === 'polyline') {
      const nums = (/\spoints="([^"]*)"/.exec(tag)?.[1] ?? '').trim().split(/[\s,]+/).map(Number);
      const pts: Vec2[] = []; for (let k = 0; k + 1 < nums.length; k += 2) pts.push([nums[k], nums[k + 1]]);
      if (pts.length > 2) loops.push(pts);
    } else {
      const d = /\sd="([^"]*)"/.exec(tag)?.[1] ?? '';
      loops.push(...svgPath(d));
    }
  }
  const s = o.scale ?? 1, flip = o.flipY ?? true;
  return loops.map((l) => l.map(([x, y]) => [x * s, (flip ? -y : y) * s] as Vec2));
}
function svgPath(d: string): Vec2[][] {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const loops: Vec2[][] = [];
  let cur: Vec2[] = [], x = 0, y = 0, sx = 0, sy = 0, cmd = '', i = 0;
  let lc: Vec2 | null = null;
  const num = () => parseFloat(toks[i++]);
  const flush = () => { if (cur.length > 2) loops.push(cur); cur = []; };
  const cubic = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2) => { for (let k = 1; k <= 12; k++) { const t = k / 12, u = 1 - t; cur.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]); } };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === 'M') { flush(); x = ox + num(); y = oy + num(); sx = x; sy = y; cur.push([x, y]); cmd = rel ? 'l' : 'L'; lc = null; }
    else if (C === 'L') { x = ox + num(); y = oy + num(); cur.push([x, y]); lc = null; }
    else if (C === 'H') { x = (rel ? x : 0) + num(); cur.push([x, y]); lc = null; }
    else if (C === 'V') { y = (rel ? y : 0) + num(); cur.push([x, y]); lc = null; }
    else if (C === 'C') { const p1: Vec2 = [ox + num(), oy + num()], p2: Vec2 = [ox + num(), oy + num()], p3: Vec2 = [ox + num(), oy + num()]; cubic([x, y], p1, p2, p3); lc = p2; [x, y] = p3; }
    else if (C === 'S') { const p1: Vec2 = lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y]; const p2: Vec2 = [ox + num(), oy + num()], p3: Vec2 = [ox + num(), oy + num()]; cubic([x, y], p1, p2, p3); lc = p2; [x, y] = p3; }
    else if (C === 'Q') { const q: Vec2 = [ox + num(), oy + num()], p3: Vec2 = [ox + num(), oy + num()]; cubic([x, y], [x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y)], [p3[0] + (2 / 3) * (q[0] - p3[0]), p3[1] + (2 / 3) * (q[1] - p3[1])], p3); lc = null; [x, y] = p3; }
    else if (C === 'A') {
      const rx = num(), ry = num(); num(); const large = num(), sweep = num(); const ex = ox + num(), ey = oy + num();
      // Approximate the arc with a circle through the endpoints (rotation ignored).
      const r = Math.max(rx, ry, Math.hypot(ex - x, ey - y) / 2);
      const mx = (x + ex) / 2, my = (y + ey) / 2, dx = ex - x, dy = ey - y, dl = Math.hypot(dx, dy) || 1;
      const h = Math.sqrt(Math.max(0, r * r - (dl / 2) ** 2)) * (large === sweep ? -1 : 1);
      const cx = mx - (dy / dl) * h, cy = my + (dx / dl) * h;
      let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ey - cy, ex - cx);
      if (sweep && a1 < a0) a1 += Math.PI * 2; if (!sweep && a1 > a0) a1 -= Math.PI * 2;
      for (let k = 1; k <= 16; k++) { const a = a0 + ((a1 - a0) * k) / 16; cur.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      x = ex; y = ey; lc = null;
    } else if (C === 'Z') { x = sx; y = sy; flush(); lc = null; }
    else i++;
  }
  flush();
  return loops;
}

const fromPolys = (loops: Vec2[][]) => new Sketch(K().CrossSection.ofPolygons(loops as any, 'EvenOdd' as any));

// ---------------------------------------------------------------- the namespace
export const Import = {
  dxfSketch(src: any, o: { layer?: string; scale?: number; tolerance?: number } = {}): Sketch {
    const r = resolve(src);
    const loops = parseDxf(r.text(), o).map((l) => l.map(([x, y]) => [x * (o.scale ?? 1), y * (o.scale ?? 1)] as Vec2));
    if (!loops.length) throw new ForgeError('IMPORT.DXF_EMPTY', `no closed outlines found in ${r.name}`);
    return fromPolys(loops);
  },
  svgSketch(src: any, o: { scale?: number; flipY?: boolean } = {}): Sketch {
    const r = resolve(src);
    const loops = parseSvg(r.text(), o);
    if (!loops.length) throw new ForgeError('IMPORT.SVG_EMPTY', `no closed shapes found in ${r.name}`);
    return fromPolys(loops);
  },
  /** STL (binary or ASCII), OBJ, 3MF or ASCII PLY as a solid. Options: format, scale, hull, name. */
  mesh(src: any, o: { format?: string; scale?: number; hull?: boolean; name?: string } = {}): Shape {
    const r = resolve(src);
    const fmt = formatOf(r.name, r.bytes, o.format);
    const name = o.name ?? (r.name !== 'inline' ? r.name.replace(/^.*\//, '') : undefined);
    const build = (pos: number[], tri: number[]) => {
      if (o.hull) { const pts: [number, number, number][] = []; for (let k = 0; k < pos.length; k += 3) pts.push([pos[k] * (o.scale ?? 1), pos[k + 1] * (o.scale ?? 1), pos[k + 2] * (o.scale ?? 1)]); return new Shape(K().Manifold.hull(pts as any), { name }); }
      return meshShape(pos, tri, { scale: o.scale, name });
    };
    if (fmt === 'stl') { const { pos, tri } = parseStl(r.bytes); return build(pos, tri); }
    if (fmt === 'obj') { const { pos, tri } = parseObj(r.text()); return build(pos, tri); }
    if (fmt === 'ply') { const { pos, tri } = parsePly(r.text()); return build(pos, tri); }
    if (fmt === '3mf') {
      const objs = parse3mf(r.bytes);
      const shapes = objs.map((ob) => build(ob.pos, ob.tri));
      return shapes.length === 1 ? shapes[0] : new Shape(K().Manifold.union(shapes.map((s) => s.m)), { name });
    }
    if (fmt === 'step') return Import.step(src, o);
    throw new ForgeError('IMPORT.FORMAT', `unsupported mesh format "${fmt}" (use stl, obj, 3mf or ply)`);
  },
  /** STEP (AP203/AP214/AP242) solid, tessellated by OpenCascade. */
  step(src: any, o: { scale?: number; name?: string } = {}): Shape {
    const r = resolve(src);
    if (!stepReader.fn) throw new ForgeError('IMPORT.STEP_LOADING', 'the STEP reader is still loading; rebuild in a moment');
    const meshes = stepReader.fn(r.bytes);
    if (!meshes.length) throw new ForgeError('IMPORT.STEP_EMPTY', `no solids in ${r.name}`);
    const shapes = meshes.map((m, i) => {
      try { return meshShape(m.positions, m.indices, { scale: o.scale, name: m.name }); }
      catch { const pts: any[] = []; for (let k = 0; k < m.positions.length; k += 3) pts.push([m.positions[k], m.positions[k + 1], m.positions[k + 2]]); ctx().warnings.push(`STEP body ${i + 1} is not closed; imported as its hull`); return new Shape(K().Manifold.hull(pts)); }
    });
    const name = o.name ?? (r.name !== 'inline' ? r.name.replace(/^.*\//, '') : undefined);
    const s = shapes.length === 1 ? shapes[0] : new Shape(K().Manifold.union(shapes.map((x) => x.m)));
    return name ? s.named(name) : s;
  },
};

/** True when a project needs the STEP reader (a .step/.stp file, or a script calling Import.step). */
export function projectNeedsStep(files: Record<string, string>): boolean {
  return Object.entries(files).some(([k, v]) => /\.(step|stp)$/i.test(k) || (/\.js$/.test(k) && /Import\.step\s*\(/.test(v)));
}

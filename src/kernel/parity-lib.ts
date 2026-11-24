// ForgeCAD-shaped library objects: TangentLoop2D, laser FlatPart / LaserKit with joints, WoodBoard.
import { mat4, Mat4, toVec3, v3, Vec2, Vec3 } from './math';
import { Shape } from './shape';
import { ShapeGroup, group } from './ops';
import { Sketch, polygon, rect, union2d, stroke } from './sketch';
import { ForgeError } from './errors';
import { polylineCurve } from './curves';
import { sketchToSvg } from './output';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- TangentLoop2D
export interface LoopCircle { name?: string; center: Vec2; radius: number; side?: 'outside' | 'inside' }
function normCircle(c: any, i: number): LoopCircle {
  if (Array.isArray(c)) return { name: `c${i}`, center: [c[0], c[1]], radius: c[2] };
  const center: Vec2 = c.center ? [c.center[0], c.center[1]] : [c.x ?? 0, c.y ?? 0];
  return { name: c.name ?? `c${i}`, center, radius: c.radius ?? c.r ?? (c.diameter != null ? c.diameter / 2 : 1), side: c.side ?? (c.inside ? 'inside' : 'outside') };
}
/** Outer tangent from circle 1 to circle 2 for signed radii (positive: belt runs counter-clockwise around it). */
function tangent(c1: Vec2, r1: number, c2: Vec2, r2: number): { p1: Vec2; p2: Vec2; n: Vec2 } {
  const D: Vec2 = [c2[0] - c1[0], c2[1] - c1[1]], L = Math.hypot(D[0], D[1]);
  if (L < 1e-9) throw new ForgeError('TANGENT_LOOP.COINCIDENT', 'two loop circles share a center');
  const a = (r1 - r2) / L;
  if (Math.abs(a) > 1) throw new ForgeError('TANGENT_LOOP.OVERLAP', 'loop circles overlap so no tangent exists between them');
  const u: Vec2 = [D[0] / L, D[1] / L], w: Vec2 = [-u[1], u[0]], b = Math.sqrt(1 - a * a);
  for (const sgn of [1, -1]) {
    const n: Vec2 = [a * u[0] + sgn * b * w[0], a * u[1] + sgn * b * w[1]];
    const p1: Vec2 = [c1[0] + r1 * n[0], c1[1] + r1 * n[1]], p2: Vec2 = [c2[0] + r2 * n[0], c2[1] + r2 * n[1]];
    // Travel direction must be the CCW perpendicular of n (for positive radius).
    const d: Vec2 = [p2[0] - p1[0], p2[1] - p1[1]];
    if (d[0] * -n[1] + d[1] * n[0] > -1e-9) return { p1, p2, n };
  }
  throw new ForgeError('TANGENT_LOOP.NO_TANGENT', 'no tangent between loop circles');
}
export class TangentLoop2D extends Sketch {
  readonly circles: LoopCircle[];
  readonly mode: 'open' | 'crossed';
  readonly segments: ({ kind: 'line'; from: Vec2; to: Vec2; length: number } | { kind: 'arc'; circle: string; center: Vec2; radius: number; startDeg: number; sweepDeg: number; length: number })[];
  private readonly pts: Vec2[];
  constructor(circles: any[], o: { mode?: 'open' | 'crossed'; samplesPerTurn?: number } = {}) {
    const cs = circles.map(normCircle);
    if (cs.length < 2) throw new ForgeError('TANGENT_LOOP.ARITY', 'a tangent loop needs at least two circles');
    const mode = o.mode ?? 'open';
    const signed = cs.map((c, i) => (c.side === 'inside' ? -1 : 1) * (mode === 'crossed' && i % 2 ? -1 : 1) * c.radius);
    const n = cs.length, tans = cs.map((c, i) => tangent(c.center, signed[i], cs[(i + 1) % n].center, signed[(i + 1) % n]));
    const segs: TangentLoop2D['segments'] = [], pts: Vec2[] = [];
    const per = o.samplesPerTurn ?? 96;
    for (let i = 0; i < n; i++) {
      const inc = tans[(i - 1 + n) % n], out = tans[i], c = cs[i], r = signed[i];
      // arc on circle i from the incoming tangent's end to the outgoing tangent's start
      const a0 = Math.atan2(inc.n[1], inc.n[0]) + (r < 0 ? Math.PI : 0), a1 = Math.atan2(out.n[1], out.n[0]) + (r < 0 ? Math.PI : 0);
      let sweep = r > 0 ? a1 - a0 : a0 - a1;
      sweep = ((sweep % TAU) + TAU) % TAU;
      const dir = r > 0 ? 1 : -1, steps = Math.max(2, Math.ceil((sweep / TAU) * per));
      for (let k = 0; k <= steps; k++) { const a = a0 + dir * sweep * (k / steps); pts.push([c.center[0] + c.radius * Math.cos(a), c.center[1] + c.radius * Math.sin(a)]); }
      segs.push({ kind: 'arc', circle: c.name!, center: c.center, radius: c.radius, startDeg: (a0 * 180) / Math.PI, sweepDeg: (dir * sweep * 180) / Math.PI, length: Math.abs(sweep) * c.radius });
      segs.push({ kind: 'line', from: out.p1, to: out.p2, length: Math.hypot(out.p2[0] - out.p1[0], out.p2[1] - out.p1[1]) });
    }
    const clean = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-6);
    const region = mode === 'open' && signed.every((s) => s > 0) ? polygon(clean) : stroke([...clean, clean[0]], 0.01);
    super((region as any).cs, [], undefined);
    this.circles = cs; this.mode = mode; this.segments = segs; this.pts = clean;
  }
  get straightSpans() { return this.segments.filter((s) => s.kind === 'line'); }
  get wraps() { return this.segments.filter((s): s is Extract<TangentLoop2D['segments'][number], { kind: 'arc' }> => s.kind === 'arc').map((s) => ({ circle: s.circle, degrees: Math.abs(s.sweepDeg), length: s.length })); }
  get wrapByPulley(): Record<string, number> { return Object.fromEntries(this.wraps.map((w) => [w.circle, w.degrees])); }
  get length() { return this.segments.reduce((a, s) => a + s.length, 0); }
  /** The loop centerline as points (closed). */
  toPolyline(): Vec2[] { return this.pts.slice(); }
  /** The centerline as a closed 3D path on z = 0, usable as a joint or sweep path. */
  toJointPath(z = 0) { return polylineCurve(this.pts.map(([x, y]) => [x, y, z] as Vec3), true); }
  /** With a width: the belt band centred on the loop. Without: the filled loop. */
  toSketch(width?: number): Sketch { return width ? this.offsetBand(width) : new Sketch((this as any).cs); }
  toProfile(): Sketch { return polygon(this.pts); }
  /** A band of `thickness` centred on the loop line. */
  offsetBand(thickness: number): Sketch { const p = this.toProfile(); return p.offset(thickness / 2).subtract(p.offset(-thickness / 2)); }
}

// ---------------------------------------------------------------- laser flat parts
export interface EdgeInfo { name: string; start: Vec2; end: Vec2; length: number }
export interface JointRecord { type: 'finger' | 'tabSlot'; partA: string; edgeA: string; partB: string; edgeB: string; foldAngle: number; options: any }
let partCounter = 0;
export class FlatPart {
  readonly kind = 'flatPart';
  private readonly edgeMap = new Map<string, EdgeInfo>();
  private readonly adds: Sketch[] = [];
  private readonly subs: Sketch[] = [];
  private readonly jointList: JointRecord[] = [];
  readonly partNumber: string;
  constructor(readonly name: string, readonly base: Sketch, readonly thickness: number, edges: Record<string, any> = {}, readonly options: { qty?: number; quantity?: number; material?: string; color?: string; partNumber?: string } = {}) {
    for (const [k, e] of Object.entries(edges)) {
      const s: Vec2 = e.start ?? e[0], t: Vec2 = e.end ?? e[1];
      this.edgeMap.set(k, { name: k, start: [s[0], s[1]], end: [t[0], t[1]], length: Math.hypot(t[0] - s[0], t[1] - s[1]) });
    }
    this.partNumber = options.partNumber ?? `P${String(++partCounter).padStart(3, '0')}`;
  }
  get edges(): ReadonlyMap<string, EdgeInfo> { return this.edgeMap; }
  get joints(): readonly JointRecord[] { return this.jointList; }
  get quantity() { return this.options.qty ?? this.options.quantity ?? 1; }
  edge(name: string): EdgeInfo { const e = this.edgeMap.get(name); if (!e) throw new ForgeError('LASER.EDGE', `part "${this.name}" has no edge "${name}" (have: ${[...this.edgeMap.keys()].join(', ')})`); return e; }
  addGeometry(sketch: Sketch) { this.adds.push(sketch); return this; }
  subtractGeometry(sketch: Sketch) { this.subs.push(sketch); return this; }
  addJoint(record: JointRecord) { this.jointList.push(record); return this; }
  /** Inward in-plane normal of an edge (towards the part). */
  inward(e: EdgeInfo): Vec2 {
    const d: Vec2 = [(e.end[0] - e.start[0]) / e.length, (e.end[1] - e.start[1]) / e.length];
    const n: Vec2 = [-d[1], d[0]];
    const b = this.base.bounds(), c: Vec2 = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2], m: Vec2 = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2];
    return (c[0] - m[0]) * n[0] + (c[1] - m[1]) * n[1] >= 0 ? n : [-n[0], -n[1]];
  }
  /** Rectangle on an edge from `a` to `b` (0..1 along it), from `from` to `to` along the inward normal. */
  edgeRect(e: EdgeInfo, a: number, b: number, from: number, to: number): Sketch {
    const d: Vec2 = [(e.end[0] - e.start[0]) / e.length, (e.end[1] - e.start[1]) / e.length], n = this.inward(e);
    const P = (s: number, t: number): Vec2 => [e.start[0] + d[0] * s * e.length + n[0] * t, e.start[1] + d[1] * s * e.length + n[1] * t];
    return polygon([P(a, from), P(b, from), P(b, to), P(a, to)]);
  }
  /** The cut outline with joint fingers, tabs and slots, offset outward by kerf / 2. */
  profile(kerf = 0): Sketch {
    let s = this.base;
    const plus: Sketch[] = [...this.adds], minus: Sketch[] = [...this.subs];
    for (const j of this.jointList) {
      const mine = j.partA === this.name ? 'A' : 'B';
      const e = this.edge(mine === 'A' ? j.edgeA : j.edgeB);
      const other: number = mine === 'A' ? j.options.thicknessB : j.options.thicknessA;
      if (j.type === 'finger') {
        const n = j.options.fingers;
        for (let i = 0; i < n; i++) if ((i % 2 === 0) === (mine === 'B')) minus.push(this.edgeRect(e, i / n, (i + 1) / n, -1, other));
      } else {
        const n = j.options.tabs, w = j.options.tabWidth / e.length, c = j.options.clearance;
        for (let i = 0; i < n; i++) {
          const mid = (i + 0.5) / n;
          if (mine === 'A') plus.push(this.edgeRect(e, mid - w / 2, mid + w / 2, -other, 0.01));
          else { const inset = j.options.inset; minus.push(this.edgeRect(e, mid - w / 2 - c / e.length / 2, mid + w / 2 + c / e.length / 2, inset - c / 2, inset + other + c / 2)); }
        }
      }
    }
    if (plus.length) s = s.add(...plus);
    if (minus.length) s = s.subtract(...minus);
    return kerf ? s.offset(kerf / 2) : s;
  }
  solid(kerf = 0): Shape {
    let sh = this.profile(kerf).extrude(this.thickness).named(this.name).withMeta({ sheet: { thickness: this.thickness, material: this.options.material, kerf, outline: this.profile(0) }, manufacturing: { process: 'cut', method: 'laser', thickness: this.thickness, material: this.options.material }, partNumber: this.partNumber });
    if (this.options.color) sh = sh.color(this.options.color);
    return sh;
  }
}
function rectEdges(w: number, h: number) { return { bottom: [[-w / 2, -h / 2], [w / 2, -h / 2]], right: [[w / 2, -h / 2], [w / 2, h / 2]], top: [[w / 2, h / 2], [-w / 2, h / 2]], left: [[-w / 2, h / 2], [-w / 2, -h / 2]] }; }
export function laserPanel(name: string, width: number, height: number, thickness: number, o: any = {}) {
  let s = rect(width, height);
  if (o.cornerRadius) s = s.filletCorners(o.cornerRadius);
  return new FlatPart(name, s, thickness, rectEdges(width, height), o);
}
export function laserFlatPart(name: string, profile: Sketch, thickness: number, edges?: Record<string, any>, o: any = {}) {
  let e = edges;
  if (!e) { const b = profile.bounds(); const w = b.maxX - b.minX, h = b.maxY - b.minY; e = Object.fromEntries(Object.entries(rectEdges(w, h)).map(([k, v]) => [k, (v as Vec2[]).map((p) => [p[0] + (b.minX + b.maxX) / 2, p[1] + (b.minY + b.maxY) / 2])])); }
  return new FlatPart(name, profile, thickness, e, o);
}
export function laserJoint(type: 'finger' | 'tabSlot', a: FlatPart, ea: string, b: FlatPart, eb: string, o: any = {}): JointRecord {
  const A = a.edge(ea), B = b.edge(eb);
  if (Math.abs(A.length - B.length) > Math.max(0.5, 0.02 * A.length) && type === 'finger') throw new ForgeError('LASER.JOINT_LENGTH', `finger joint edges differ in length (${A.length.toFixed(2)} vs ${B.length.toFixed(2)})`);
  const options: any = { thicknessA: a.thickness, thicknessB: b.thickness, ...o };
  if (type === 'finger') { let n = o.fingers ?? Math.max(3, Math.round(A.length / (o.fingerWidth ?? a.thickness * 3))); if (n % 2 === 0) n += 1; options.fingers = n; }
  else { options.tabs = o.tabs ?? Math.max(1, Math.floor(A.length / (a.thickness * 8))); options.tabWidth = o.tabWidth ?? Math.min(A.length / (2 * options.tabs), a.thickness * 3); options.clearance = o.clearance ?? 0.1; options.inset = o.inset ?? 0; }
  const rec: JointRecord = { type, partA: a.name, edgeA: ea, partB: b.name, edgeB: eb, foldAngle: o.foldAngle ?? 90, options };
  a.addJoint(rec); b.addJoint(rec);
  return rec;
}

/** Fold flat parts into 3D by walking the joints from the first part (laid flat on XY). */
export function foldParts(parts: FlatPart[], joints: JointRecord[], o: { kerf?: number; explode?: number } = {}): ShapeGroup {
  const byName = new Map(parts.map((p) => [p.name, p]));
  const pose = new Map<string, Mat4>();
  if (!parts.length) return group([]);
  pose.set(parts[0].name, mat4.identity());
  let changed = true;
  while (changed) {
    changed = false;
    for (const j of joints) {
      for (const [from, fe, to, te] of [[j.partA, j.edgeA, j.partB, j.edgeB], [j.partB, j.edgeB, j.partA, j.edgeA]] as const) {
        if (!pose.has(from) || pose.has(to) || !byName.has(to)) continue;
        const P = byName.get(from)!, Q = byName.get(to)!, Mp = pose.get(from)!;
        const e = P.edge(fe), f = Q.edge(te);
        const A = mat4.apply(Mp, [e.start[0], e.start[1], 0]), B = mat4.apply(Mp, [e.end[0], e.end[1], 0]);
        const nP = P.inward(e), outW = v3.norm(mat4.applyDir(Mp, [-nP[0], -nP[1], 0])), upW = v3.norm(mat4.applyDir(Mp, [0, 0, 1]));
        const X = v3.norm(v3.sub(A, B));
        const ang = (j.foldAngle * Math.PI) / 180;
        const Y = v3.norm(v3.add(v3.scale(outW, Math.cos(ang)), v3.scale(upW, Math.sin(ang))));
        const Z = v3.cross(X, Y);
        const nQ = Q.inward(f), xl = v3.norm([f.end[0] - f.start[0], f.end[1] - f.start[1], 0]), yl: Vec3 = [nQ[0], nQ[1], 0], zl = v3.cross(xl, yl);
        const Tl = mat4.fromFrame(xl, yl, zl, [f.start[0], f.start[1], 0]), Tw = mat4.fromFrame(X, Y, Z, B);
        pose.set(to, mat4.mul(Tw, mat4.invert(Tl)));
        changed = true;
      }
    }
  }
  return group(parts.map((p) => ({ name: p.name, shape: p.solid(o.kerf ?? 0).transform(pose.get(p.name) ?? mat4.translation(0, 0, -200)) })));
}
export function laserInstructions(parts: FlatPart[], joints: JointRecord[], o: { title?: string } = {}) {
  const steps = joints.map((j, i) => ({ step: i + 1, title: `Join ${j.partA} (${j.edgeA}) to ${j.partB} (${j.edgeB})`, text: j.type === 'finger' ? `Mesh the fingers and fold to ${j.foldAngle}°.` : `Press the tabs of ${j.partA} into the slots of ${j.partB}.`, parts: [j.partA, j.partB], joint: j }));
  return { title: o.title ?? 'Assembly instructions', cutList: parts.map((p) => ({ part: p.name, partNumber: p.partNumber, quantity: p.quantity, thickness: p.thickness, material: p.options.material })), sheets: undefined as number | undefined, steps };
}

// ---------------------------------------------------------------- laser kits
export interface MaterialKerfEntry { material: string; thickness: number; kerf: number; laserType: 'co2' | 'fiber' | 'diode' }
export const COMMON_KERF_TABLE: MaterialKerfEntry[] = [
  ['plywood', 3, 0.15], ['plywood', 6, 0.2], ['mdf', 3, 0.18], ['mdf', 6, 0.22], ['acrylic', 2, 0.1], ['acrylic', 3, 0.12], ['acrylic', 5, 0.15],
  ['cardboard', 3, 0.25], ['felt', 3, 0.3], ['steel', 1, 0.15, 'fiber'], ['steel', 2, 0.2, 'fiber'], ['aluminum', 2, 0.2, 'fiber'],
].map(([material, thickness, kerf, laserType]) => ({ material, thickness, kerf, laserType: (laserType ?? 'co2') })) as MaterialKerfEntry[];
export function lookupKerfEntry(material: string, thickness?: number, laserType?: string): number {
  const m = material.toLowerCase();
  const rows = COMMON_KERF_TABLE.filter((r) => r.material === m && (!laserType || r.laserType === laserType));
  if (!rows.length) return 0.15;
  if (thickness == null) return rows[0].kerf;
  return rows.slice().sort((a, b) => Math.abs(a.thickness - thickness) - Math.abs(b.thickness - thickness))[0].kerf;
}
export class FlatLaserKit {
  readonly kind = 'laserKit';
  private readonly entries: { part: FlatPart; qty: number }[] = [];
  constructor(readonly o: { kerf?: number; material?: string; thickness?: number; sheetWidth?: number; sheetHeight?: number; spacing?: number; title?: string } = {}) {}
  get kerf() { return this.o.kerf ?? (this.o.material ? lookupKerfEntry(this.o.material, this.o.thickness ?? this.entries[0]?.part.thickness) : 0); }
  get parts() { return this.entries.map((e) => e.part); }
  get material() { return this.o.material; }
  get sheetWidth() { return this.o.sheetWidth ?? 600; }
  get sheetHeight() { return this.o.sheetHeight ?? 400; }
  addPart(part: FlatPart, overrides: { qty?: number } = {}) { this.entries.push({ part, qty: overrides.qty ?? part.quantity }); return this; }
  private joints() { const seen = new Set<JointRecord>(); for (const p of this.parts) for (const j of p.joints) seen.add(j); return [...seen]; }
  /** Shelf-pack every part copy onto sheets. */
  cutSheets() {
    const sp = this.o.spacing ?? 3, W = this.sheetWidth, H = this.sheetHeight, k = this.kerf;
    const items = this.entries.flatMap((e) => Array.from({ length: e.qty }, (_, i) => ({ name: e.qty > 1 ? `${e.part.name} ${i + 1}` : e.part.name, part: e.part.name, sk: e.part.profile(k) })))
      .map((it) => { const b = it.sk.bounds(); const rot = b.width < b.height && b.height <= W; return { ...it, sk: rot ? it.sk.rotate(90) : it.sk, rot }; })
      .sort((a, b) => b.sk.bounds().height - a.sk.bounds().height);
    const sheets: { index: number; width: number; height: number; placements: { name: string; part: string; x: number; y: number; rotated: boolean; sketch: Sketch }[] }[] = [];
    let cur = { index: 0, width: W, height: H, placements: [] as any[] }; sheets.push(cur);
    let x = 0, y = 0, rowH = 0;
    for (const it of items) {
      const b = it.sk.bounds();
      if (b.width > W || b.height > H) throw new ForgeError('LASER.PART_TOO_BIG', `part "${it.name}" (${b.width.toFixed(1)} x ${b.height.toFixed(1)}) does not fit the ${W} x ${H} sheet`);
      if (x + b.width > W) { x = 0; y += rowH + sp; rowH = 0; }
      if (y + b.height > H) { cur = { index: sheets.length, width: W, height: H, placements: [] }; sheets.push(cur); x = 0; y = 0; rowH = 0; }
      cur.placements.push({ name: it.name, part: it.part, x, y, rotated: it.rot, sketch: it.sk.translate(x - b.minX, y - b.minY) });
      x += b.width + sp; rowH = Math.max(rowH, b.height);
    }
    return sheets.map((s) => ({ ...s, svg: s.placements.length ? sketchToSvg(union2d(s.placements.map((p) => p.sketch)), { strokeWidth: 0.1 }) : '' }));
  }
  bom() { return this.entries.map((e) => ({ part: e.part.name, partNumber: e.part.partNumber, quantity: e.qty, thickness: e.part.thickness, material: e.part.options.material ?? this.material })); }
  partSvgs(): Record<string, string> { return Object.fromEntries(this.parts.map((p) => [p.name, sketchToSvg(p.profile(this.kerf), { strokeWidth: 0.1 })])); }
  /** All parts side by side with their names, as one SVG. */
  inventorySvg(): string {
    let x = 0; const placed: string[] = [], labels: string[] = []; let H = 0;
    for (const p of this.parts) { const s = p.profile(0), b = s.bounds(); const sv = sketchToSvg(s.translate(x - b.minX, -b.minY), { strokeWidth: 0.2 }); placed.push(sv.replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g, '')); labels.push(`<text x="${x}" y="${-4}" font-size="6" font-family="sans-serif">${p.name} ×${this.entries.find((e) => e.part === p)!.qty}</text>`); x += b.width + 10; H = Math.max(H, b.height); }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-5 -12 ${x + 10} ${H + 20}">${labels.join('')}${placed.join('')}</svg>`;
  }
  assemblyPreview(o: any = {}) { return foldParts(this.parts, this.joints(), { kerf: 0, ...o }); }
  assemblyInstructions(o: any = {}) { const r = laserInstructions(this.parts, this.joints(), { title: this.o.title, ...o }); r.sheets = this.cutSheets().length; return r; }
  formatInstructions(o: any = {}) { return formatFlatInstructions(this.assemblyInstructions(o)); }
}
export function formatFlatInstructions(r: ReturnType<typeof laserInstructions>) {
  return [`# ${r.title}`, '', ...(r.sheets != null ? [`Sheets to cut: ${r.sheets}`, ''] : []), '## Cut list', ...r.cutList.map((c) => `- ${c.quantity} x ${c.part} (${c.partNumber}, ${c.thickness} mm${c.material ? ` ${c.material}` : ''})`), '', '## Steps', ...r.steps.map((s) => `${s.step}. ${s.title}. ${s.text}`)].join('\n');
}

// ---------------------------------------------------------------- wood boards
export interface WoodInfo { width: number; height: number; thickness: number; grain: 'x' | 'y' | 'z'; species: string; material: any }
const SPECIES_COLOR: Record<string, string> = { walnut: '#5b3a29', oak: '#b08a5a', maple: '#e0c79a', cherry: '#a0522d', birch: '#e3cfa4', pine: '#c9a36b', plywood: '#d9b98a', mdf: '#a68b6a' };
const SPECIES_DENSITY: Record<string, number> = { walnut: 640, oak: 750, maple: 705, cherry: 560, birch: 670, pine: 500, plywood: 600, mdf: 750 };
/** A board: a Shape that also remembers its stock size, grain and species through cuts and moves. */
export class WoodBoard extends Shape {
  declare readonly wood: WoodInfo;
  static from(s: Shape, info: WoodInfo): WoodBoard {
    const b = Object.create(WoodBoard.prototype);
    Object.assign(b, s);
    Object.defineProperty(b, 'wood', { value: info, enumerable: false });
    return b;
  }
  get shape(): Shape { return new Shape(this.m, { faces: this.faceLabels, color: this.colorValue, material: this.materialProps, connectors: this.connectors, name: this.name, meta: this.meta }); }
  get width() { return this.wood.width; }
  get height() { return this.wood.height; }
  get thickness() { return this.wood.thickness; }
  get grain() { return this.wood.grain; }
  get species() { return this.wood.species; }
  /** No argument: the board's wood material. With props: Shape.material(props) (appearance). */
  material(props?: any): any { return props === undefined ? this.wood.material : this.re(Shape.prototype.material.call(this.shape, props)); }
  get woodMaterial() { return this.wood.material; }
  private re(s: Shape) { return WoodBoard.from(s, this.wood); }
  cut(cutter: Shape) { return this.re(this.shape.subtract(cutter)); }
  translate(x: any, y?: any, z?: any) { return this.re(this.shape.translate(x, y, z)); }
  rotate(axis: Vec3, deg: number, o?: any) { return this.re((this.shape as any).rotate(axis, deg, o)); }
  rotateX(deg: number) { return this.re(this.shape.rotateX(deg)); }
  rotateY(deg: number) { return this.re(this.shape.rotateY(deg)); }
  rotateZ(deg: number) { return this.re(this.shape.rotateZ(deg)); }
  mirror(normal: Vec3) { return this.re(this.shape.mirror(normal)); }
  color(value: string) { return this.re(this.shape.color(value)); }
}
// WoodBoard.material is a getter for the wood material; keep Shape.material(props) reachable as a method via appearance().
export function woodBoard(base: (w: number, h: number, t: number) => Shape, width: number, height: number, thickness: number, o: { species?: string; grain?: 'x' | 'y' | 'z'; color?: string } = {}) {
  const species = o.species ?? 'pine';
  const material = { kind: 'woodMaterial', species, densityKgM3: SPECIES_DENSITY[species] ?? 600 };
  const s = base(width, height, thickness).color(o.color ?? SPECIES_COLOR[species] ?? '#c9a36b').withMeta({ wood: { species, grain: o.grain ?? 'x', width, height, thickness }, physicalMaterial: { id: `wood-${species}`, name: species, densityKgM3: material.densityKgM3 } });
  return WoodBoard.from(s, { width, height, thickness, grain: o.grain ?? 'x', species, material });
}
const thinAxis = (s: Shape) => { const z = s.boundingBox().size; return z.indexOf(Math.min(...z)); };
/** Board-on-board dado: cut a groove in `host` where `guest` enters it. */
export function woodDado(host: Shape, guest: Shape, o: { clearance?: number } = {}) {
  const c = o.clearance ?? 0;
  const overlap = host.intersect(guest);
  if (overlap.isEmpty()) throw new ForgeError('WOOD.DADO_NO_OVERLAP', 'the guest board does not enter the host board; move it into the host by the dado depth');
  const cutter = c ? guest.scaleAround(guest.boundingBox().center, guest.boundingBox().size.map((d) => (d + 2 * c) / d) as Vec3) : guest;
  const out = host.subtract(cutter).withMeta({ joinery: [...(host.meta.joinery ?? []), { kind: 'dado', depth: Math.min(...overlap.boundingBox().size) }] });
  return host instanceof WoodBoard ? WoodBoard.from(out, host.wood) : out;
}
/** Board-on-board mortise and tenon: the tenon board's overlap with the mortise board becomes a tenon (cheeks removed). */
export function woodMortiseAndTenon(mortiseBoard: Shape, tenonBoard: Shape, o: { thicknessRatio?: number; clearance?: number; shoulder?: number } = {}) {
  const overlap = mortiseBoard.intersect(tenonBoard);
  if (overlap.isEmpty()) throw new ForgeError('WOOD.TENON_NO_OVERLAP', 'the tenon board does not enter the mortise board');
  const ob = overlap.boundingBox(), ax = thinAxis(tenonBoard), sz = ob.size.slice() as Vec3;
  sz[ax] = tenonBoard.boundingBox().size[ax] * (o.thicknessRatio ?? 1 / 3);
  const core = overlap.scaleAround(ob.center, sz.map((d, i) => d / ob.size[i]) as Vec3);
  const cheeks = overlap.subtract(core);
  const c = o.clearance ?? 0.2;
  const cutter = core.scaleAround(ob.center, core.boundingBox().size.map((d) => (d + 2 * c) / d) as Vec3);
  const tenon = tenonBoard.subtract(cheeks), mortise = mortiseBoard.subtract(cutter);
  const wrap = (s: Shape, ref: Shape) => (ref instanceof WoodBoard ? WoodBoard.from(s, ref.wood) : s);
  return { mortise: wrap(mortise, mortiseBoard), tenon: wrap(tenon, tenonBoard), mortiseBoard: wrap(mortise, mortiseBoard), tenonBoard: wrap(tenon, tenonBoard), tenonSize: core.boundingBox().size };
}
export { toVec3 };

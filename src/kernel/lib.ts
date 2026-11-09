// Part library: tubes, fasteners, gears, extrusions, pipes, belts.
import { K } from './wasm';
import { mat4, toVec3, v3, Vec2, Vec3 } from './math';
import { Shape } from './shape';
import { Sketch, polygon, circle2d, rect, DEFAULT_SEGMENTS, union2d } from './sketch';
import { box, cylinder, union, group, ShapeGroup, circularPattern } from './ops';
import { Curve, sweep, tubeAlong } from './curves';
import { connector } from './assembly';
import { metric } from './shape';
import { ForgeError } from './errors';

export function tube(ox: number, oy: number, oz: number, wall: number): Shape {
  return box(ox, oy, oz).subtract(box(ox - 2 * wall, oy - 2 * wall, oz + 2).translate(0, 0, -1));
}
export function pipe(height: number, outerRadius: number, wall: number, segments?: number): Shape {
  return cylinder(height, outerRadius, undefined, segments).subtract(cylinder(height + 2, outerRadius - wall, undefined, segments).translate(0, 0, -1));
}
export function bracket(width: number, height: number, depth: number, thick: number, holeDia?: number): Shape {
  let b = box(width, thick, height).translate(0, depth / 2 - thick / 2, 0).add(box(width, depth, thick));
  if (holeDia) {
    const h = cylinder(thick * 3, holeDia / 2).translate(0, -thick, -thick);
    b = b.subtract(h.translate(-width / 4, 0, 0), h.translate(width / 4, 0, 0));
    const v = cylinder(thick * 3, holeDia / 2).rotateX(90).translate(0, depth / 2 + thick, height * 0.6);
    b = b.subtract(v.translate(-width / 4, 0, 0), v.translate(width / 4, 0, 0));
  }
  return b;
}
export function holePattern(rows: number, cols: number, sx: number, sy: number, dia: number, depth: number): Shape {
  const holes: Shape[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) holes.push(cylinder(depth, dia / 2).translate((c - (cols - 1) / 2) * sx, (r - (rows - 1) / 2) * sy, 0));
  return union(holes);
}

export function explode(items: any, o: { amount?: number; mode?: 'radial' | 'axial'; byName?: Record<string, Vec3> } = {}): ShapeGroup {
  const g = items instanceof ShapeGroup ? items : group(...(Array.isArray(items) ? items : [items]));
  const center = g.toShape().center();
  const amt = o.amount ?? 20;
  return new ShapeGroup(g.children.map((c, i) => {
    const s = c.item as Shape;
    let d: Vec3;
    if (o.byName?.[c.name]) d = toVec3(o.byName[c.name]);
    else if (o.mode === 'axial') d = [0, 0, i * amt];
    else { const dir = v3.sub(s.center(), center); d = v3.len(dir) < 1e-6 ? [0, 0, 0] : v3.scale(v3.norm(dir), amt); }
    return { ...c, item: s.translate(d[0], d[1], d[2]) };
  }));
}

// ---------------------------------------------------------------- threads and fasteners
export function thread(diameter: number, pitch: number, length: number, o: { depth?: number; segments?: number; internal?: boolean } = {}): Shape {
  const depth = o.depth ?? pitch * 0.6134;
  const r = diameter / 2;
  const seg = o.segments ?? 48;
  const core = K().CrossSection.circle(r - depth, seg);
  // thread profile: 60° triangle swept along a helix, then unioned with the core
  const turns = length / pitch + 1;
  const tri = polygon([[0, -pitch * 0.45], [depth + 0.05, -pitch * 0.05], [depth + 0.05, pitch * 0.05], [0, pitch * 0.45]]);
  const helix = Curve.Helix.path({ radius: r - depth, pitch, turns: turns, samplesPerTurn: seg });
  const ridge = sweep(tri, helix, { up: [0, 0, 1] });
  const coreShape = new Shape(core.extrude(length));
  return coreShape.add(ridge.translate(0, 0, -pitch / 2)).intersect(cylinder(length, r + 0.01, undefined, seg));
}

const HEX_AF: Record<string, number> = { M2: 4, M2_5: 5, M3: 5.5, M4: 7, M5: 8, M6: 10, M8: 13, M10: 16, M12: 18, M16: 24, M20: 30 };
const SOCKET: Record<string, [number, number, number]> = { M2: [3.8, 2, 1.5], M2_5: [4.5, 2.5, 2], M3: [5.5, 3, 2.5], M4: [7, 4, 3], M5: [8.5, 5, 4], M6: [10, 6, 5], M8: [13, 8, 6], M10: [16, 10, 8], M12: [18, 12, 10], M16: [24, 16, 14], M20: [30, 20, 17] };

function sizeKey(d: number | string): string {
  if (typeof d === 'string') return d.toUpperCase().replace('.', '_');
  return 'M' + String(d).replace('.', '_');
}
export function hexagon(af: number): Sketch {
  const r = af / Math.sqrt(3);
  const pts: Vec2[] = [];
  for (let i = 0; i < 6; i++) pts.push([r * Math.cos((i * Math.PI) / 3), r * Math.sin((i * Math.PI) / 3)]);
  return polygon(pts);
}
export function bolt(diameter: number | string, length: number, o: { head?: 'socket' | 'hex' | 'button' | 'flat'; threaded?: boolean; color?: string } = {}): Shape {
  const key = sizeKey(diameter);
  const d = typeof diameter === 'number' ? diameter : metric(key).diameter;
  const head = o.head ?? 'socket';
  let h: Shape;
  if (head === 'hex') h = hexagon(HEX_AF[key] ?? d * 1.6).extrude(d * 0.7);
  else if (head === 'button') h = circle2d((SOCKET[key]?.[0] ?? d * 1.75) / 2).revolve !== undefined ? new Shape(K().Manifold.sphere(d * 0.95, 32)).trimByPlane([0, 0, 1], 0).scale([1, 1, 0.55]) : box(1, 1, 1);
  else if (head === 'flat') h = cylinder(d * 0.6, d, d * 2);
  else {
    const [hd, hh, socket] = SOCKET[key] ?? [d * 1.75, d, d * 0.8];
    h = cylinder(hh, hd / 2).subtract(hexagon(socket).extrude(hh * 0.6).translate(0, 0, hh * 0.4 + 0.01));
  }
  const shank = o.threaded ? thread(d, metric(key).pitch, length).mirror([0, 0, 1]).translate(0, 0, 0) : cylinder(length, d / 2).translate(0, 0, -length);
  const shaft = o.threaded ? shank.translate(0, 0, -length / 2 - shank.boundingBox().center[2]) : shank;
  return h.add(shaft).color(o.color ?? '#6b7075').withConnectors({
    head: connector('head', { origin: [0, 0, 0], axis: [0, 0, -1], up: [1, 0, 0] }),
    tip: connector('tip', { origin: [0, 0, -length], axis: [0, 0, -1], up: [1, 0, 0] }),
  }).withMeta({ fastener: { kind: 'bolt', size: key, length } });
}
export function nut(diameter: number | string, o: { boreDiameter?: number; height?: number } = {}): Shape {
  const key = sizeKey(diameter);
  const d = typeof diameter === 'number' ? diameter : metric(key).diameter;
  const af = HEX_AF[key] ?? d * 1.6;
  const hgt = o.height ?? d * 0.8;
  return hexagon(af).extrude(hgt).subtract(cylinder(hgt + 2, (o.boreDiameter ?? d + 0.2) / 2).translate(0, 0, -1)).color('#6b7075')
    .withConnectors({ bore: connector('bore', { origin: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0] }) }).withMeta({ fastener: { kind: 'nut', size: key } });
}
export function washer(size: number | string, o: { standard?: string; segments?: number } = {}): Shape {
  const key = sizeKey(size);
  const d = typeof size === 'number' ? size : metric(key).diameter;
  return pipe(d * 0.18, d, d * 0.47, o.segments).color('#9aa0a6').withMeta({ fastener: { kind: 'washer', size: key } });
}
export function fastenerSet(size: number | string, boltLength: number, o: any = {}) {
  const key = sizeKey(size);
  const m = metric(key);
  return { bolt: bolt(size, boltLength, o), nut: nut(size, o), washers: [washer(size), washer(size)], clearanceHole: m.normal, tapDrill: m.tapDrill };
}
export function boltPattern(o: { size: string | number; positions: any[] }) {
  const m = metric(sizeKey(o.size));
  return {
    positions: o.positions,
    cut(shape: Shape, depth: number, opts: { from?: 'top' | 'bottom' } = {}) {
      const top = shape.boundingBox().max[2], bottom = shape.boundingBox().min[2];
      const z = opts.from === 'bottom' ? bottom - 0.01 : top - depth;
      const holes = o.positions.map((p: any) => cylinder(depth + 0.02, m.normal / 2).translate(p.x ?? p[0], p.y ?? p[1], z));
      return shape.subtract(holes);
    },
  };
}

// ---------------------------------------------------------------- pipes
export function pipeRoute(points: Vec3[], radius: number, o: { bendRadius?: number; wall?: number; segments?: number } = {}): Shape {
  return tubeAlong(points.map((p) => toVec3(p)), radius, o.bendRadius ?? radius * 2, o.wall ?? 0, o.segments ?? 24);
}
export function elbow(pipeRadius: number, bendRadius: number, angle = 90, o: { wall?: number; segments?: number } = {}): Shape {
  const k = K();
  let cs = k.CrossSection.circle(pipeRadius, o.segments ?? 24);
  if (o.wall) cs = cs.subtract(k.CrossSection.circle(pipeRadius - o.wall, o.segments ?? 24));
  return new Shape(k.Manifold.revolve(cs.translate([bendRadius, 0]), 64, angle)).rotateX(90);
}

// ---------------------------------------------------------------- belts
export function tangentLoop2d(circles: { x: number; y: number; r: number }[], o: { mode?: 'open' | 'crossed' } = {}) {
  const pts: Vec2[] = [];
  for (const c of circles) for (let i = 0; i < 64; i++) pts.push([c.x + c.r * Math.cos((i / 64) * 2 * Math.PI), c.y + c.r * Math.sin((i / 64) * 2 * Math.PI)]);
  return new Sketch(K().CrossSection.ofPolygons([pts] as any).hull());
}
export function beltDrive(o: { pulleys: Record<string, { center: Vec2; teeth?: number; pitchRadius?: number }>; pitch?: number; beltWidth: number; beltThickness?: number }) {
  const pitch = o.pitch ?? 2;
  const circles = Object.entries(o.pulleys).map(([name, p]) => ({ name, x: p.center[0], y: p.center[1], r: p.pitchRadius ?? ((p.teeth ?? 20) * pitch) / (2 * Math.PI) }));
  const outer = tangentLoop2d(circles.map((c) => ({ ...c, r: c.r + (o.beltThickness ?? 1.5) / 2 })));
  const inner = tangentLoop2d(circles.map((c) => ({ ...c, r: c.r - (o.beltThickness ?? 1.5) / 2 })));
  const belt = outer.subtract(inner).extrude(o.beltWidth).translate(0, 0, -o.beltWidth / 2).color('#1f1f1f');
  const pr = (n: string) => circles.find((c) => c.name === n)!.r;
  const first = circles[0].name;
  let length = 0;
  const loop = tangentLoop2d(circles).toPolygons()[0];
  for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; length += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return { belt, route: loop, length, teeth: length / pitch, ratio: (name: string) => pr(name) / pr(first), closure: Math.abs(length / pitch - Math.round(length / pitch)) };
}

// ---------------------------------------------------------------- aluminium extrusions
export function tSlotProfile(o: { size?: number; slot?: number; core?: number } = {}): Sketch {
  const s = o.size ?? 20, slot = o.slot ?? 6.2, core = o.core ?? 4.2;
  let p = rect(s, s);
  const opening = rect(slot, s * 0.32).translate(0, s / 2 - s * 0.16 + 0.01);
  const cavity = rect(s * 0.55, s * 0.18).translate(0, s / 2 - s * 0.32);
  let cut = union2d(opening, cavity);
  const cuts = [0, 90, 180, 270].map((a) => cut.rotateAround(a, [0, 0]));
  p = p.subtract(...cuts).subtract(circle2d(core / 2));
  return p;
}
export function tSlotExtrusion(length: number, o: any = {}): Shape { return tSlotProfile(o).extrude(length).color('#c0c4c8').material({ metalness: 0.7, roughness: 0.4 }); }
export const profile2020BSlot6Profile = (o: any = {}) => tSlotProfile({ size: 20, slot: 6.2, core: 4.2, ...o });
export const profile2020BSlot6 = (length: number, o: any = {}) => tSlotExtrusion(length, { size: 20, slot: 6.2, core: 4.2, ...o });

// ---------------------------------------------------------------- gears
function involutePoint(rb: number, t: number): Vec2 { return [rb * (Math.cos(t) + t * Math.sin(t)), rb * (Math.sin(t) - t * Math.cos(t))]; }

/** Involute spur gear outline (external) as a closed polygon. */
export function spurGearProfile(o: { module: number; teeth: number; pressureAngleDeg?: number; backlash?: number; clearance?: number; addendum?: number; dedendum?: number; segmentsPerTooth?: number }): Sketch {
  const m = o.module, z = o.teeth;
  const pa = ((o.pressureAngleDeg ?? 20) * Math.PI) / 180;
  const rp = (m * z) / 2, rb = rp * Math.cos(pa);
  const ra = rp + (o.addendum ?? m), rf = Math.max(rp - (o.dedendum ?? 1.25 * m) - (o.clearance ?? 0), 0.1);
  const n = o.segmentsPerTooth ?? 10;
  const tMax = Math.sqrt(Math.max(0, (ra / rb) ** 2 - 1));
  const tPitch = Math.sqrt(Math.max(0, (rp / rb) ** 2 - 1));
  const invAtPitch = Math.atan2(involutePoint(rb, tPitch)[1], involutePoint(rb, tPitch)[0]);
  const halfTooth = Math.PI / (2 * z) - (o.backlash ?? 0) / (2 * rp);
  const pts: Vec2[] = [];
  for (let i = 0; i < z; i++) {
    const c = (i * 2 * Math.PI) / z;
    const flank = (sign: number) => {
      const out: Vec2[] = [];
      const tMin = rf > rb ? Math.sqrt((rf / rb) ** 2 - 1) : 0;
      for (let k = 0; k <= n; k++) {
        const t = tMin + ((tMax - tMin) * k) / n;
        const p = involutePoint(rb, t);
        const ang = Math.atan2(p[1], p[0]);
        const r = Math.hypot(p[0], p[1]);
        const a = c + sign * (halfTooth + invAtPitch - ang);
        out.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      return out;
    };
    const right = flank(-1), left = flank(1).reverse();
    const r0 = right[0];
    const ang0 = Math.atan2(r0[1], r0[0]);
    pts.push([rf * Math.cos(ang0), rf * Math.sin(ang0)]);
    pts.push(...right, ...left);
    const l1 = left[left.length - 1];
    const ang1 = Math.atan2(l1[1], l1[0]);
    pts.push([rf * Math.cos(ang1), rf * Math.sin(ang1)]);
  }
  return polygon(pts);
}

export function spurGear(o: { module: number; teeth: number; faceWidth: number; pressureAngleDeg?: number; backlash?: number; boreDiameter?: number; helixAngleDeg?: number; [k: string]: any }): Shape {
  let prof = spurGearProfile(o);
  if (o.boreDiameter) prof = prof.subtract(circle2d(o.boreDiameter / 2));
  const twist = o.helixAngleDeg ? ((o.faceWidth * Math.tan((o.helixAngleDeg * Math.PI) / 180)) / ((o.module * o.teeth) / 2)) * (180 / Math.PI) : 0;
  return prof.extrude(o.faceWidth, { twist }).withConnectors({ bore: connector('bore', { origin: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0] }) })
    .withMeta({ gear: { kind: 'spur', module: o.module, teeth: o.teeth, pitchDiameter: o.module * o.teeth } });
}
export function ringGear(o: { module: number; teeth: number; faceWidth: number; rimWidth?: number; outerDiameter?: number; pressureAngleDeg?: number; backlash?: number }): Shape {
  const od = o.outerDiameter ?? o.module * o.teeth + 2 * (o.rimWidth ?? o.module * 3);
  const cutter = spurGearProfile({ ...o, addendum: o.module * 1.25, dedendum: o.module, backlash: -(o.backlash ?? 0) });
  return circle2d(od / 2, 96).subtract(cutter).extrude(o.faceWidth).withConnectors({ bore: connector('bore', { origin: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0] }) })
    .withMeta({ gear: { kind: 'ring', module: o.module, teeth: o.teeth } });
}
export function rackGear(o: { module: number; teeth: number; faceWidth: number; height?: number; pressureAngleDeg?: number }): Shape {
  const m = o.module, p = Math.PI * m, pa = ((o.pressureAngleDeg ?? 20) * Math.PI) / 180;
  const h = o.height ?? m * 4;
  const pts: Vec2[] = [[0, -h]];
  const ad = m, de = 1.25 * m, tanp = Math.tan(pa);
  for (let i = 0; i < o.teeth; i++) {
    const x = i * p;
    pts.push([x, -de], [x + p / 4 - ad * tanp, -de + 0], [x + p / 4 - ad * tanp + (ad + de) * tanp - de * tanp, ad], [x + (3 * p) / 4 - (ad) * tanp, ad], [x + (3 * p) / 4 + de * tanp, -de]);
  }
  pts.push([o.teeth * p, -de], [o.teeth * p, -h]);
  return polygon(pts).extrude(o.faceWidth).translate(-(o.teeth * p) / 2, 0, 0)
    .withConnectors({ teeth: connector('teeth', { origin: [0, 0, 0], axis: [1, 0, 0], up: [0, 1, 0] }) }).withMeta({ gear: { kind: 'rack', module: m, teeth: o.teeth } });
}
export function bevelGear(o: { module: number; teeth: number; faceWidth: number; pitchAngleDeg?: number; boreDiameter?: number; [k: string]: any }): Shape {
  const pitchAngle = o.pitchAngleDeg ?? 45;
  const rp = (o.module * o.teeth) / 2;
  const coneDist = rp / Math.sin((pitchAngle * Math.PI) / 180);
  const scaleTop = Math.max(0.05, 1 - o.faceWidth / coneDist);
  let prof = spurGearProfile(o);
  let g = prof.extrude(o.faceWidth * Math.cos((pitchAngle * Math.PI) / 180), { scale: scaleTop });
  if (o.boreDiameter) g = g.subtract(cylinder(o.faceWidth * 4, o.boreDiameter / 2).translate(0, 0, -o.faceWidth));
  const apexZ = rp / Math.tan((pitchAngle * Math.PI) / 180);
  return g.withConnectors({
    bore: connector('bore', { origin: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0] }),
    apex: connector('apex', { origin: [0, 0, apexZ], axis: [0, 0, 1], up: [1, 0, 0] }),
  }).withMeta({ gear: { kind: 'bevel', module: o.module, teeth: o.teeth, pitchAngleDeg: pitchAngle } });
}
export function faceGear(o: { module: number; teeth: number; faceWidth: number; side?: 'top' | 'bottom'; toothHeight?: number; boreDiameter?: number }): Shape {
  const rp = (o.module * o.teeth) / 2;
  const th = o.toothHeight ?? o.module * 2.25;
  const base = cylinder(o.module * 3, rp + o.faceWidth / 2, undefined, 96);
  const tooth = box(o.faceWidth, o.module * Math.PI * 0.45, th).translate(rp, 0, o.module * 3);
  let g = base.add(circularPattern(tooth, o.teeth));
  if (o.boreDiameter) g = g.subtract(cylinder(100, o.boreDiameter / 2).translate(0, 0, -50));
  if (o.side === 'bottom') g = g.mirror([0, 0, 1]);
  return g.withConnectors({ bore: connector('bore', { origin: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0] }) }).withMeta({ gear: { kind: 'face', module: o.module, teeth: o.teeth } });
}
export function sectorGear(o: { module: number; teethOnFullCircle: number; toothCount: number; firstTooth?: number; faceWidth: number; body?: 'disk' | 'sector' }): Shape {
  const full = spurGearProfile({ module: o.module, teeth: o.teethOnFullCircle });
  const step = 360 / o.teethOnFullCircle;
  const a0 = (o.firstTooth ?? 0) * step - step / 2, a1 = a0 + o.toothCount * step;
  const R = o.module * o.teethOnFullCircle;
  const wedgePts: Vec2[] = [[0, 0]];
  for (let a = a0; a <= a1 + 1e-6; a += 2) wedgePts.push([R * Math.cos((a * Math.PI) / 180), R * Math.sin((a * Math.PI) / 180)]);
  const rf = (o.module * o.teethOnFullCircle) / 2 - 1.25 * o.module;
  const body = o.body === 'disk' ? circle2d(rf) : circle2d(o.module * 3);
  return full.intersect(polygon(wedgePts)).add(body).extrude(o.faceWidth).withMeta({ gear: { kind: 'sector', module: o.module, teeth: o.teethOnFullCircle } });
}
export function gearPair(o: { module: number; teethA: number; teethB: number; faceWidth: number; [k: string]: any }) {
  const a = spurGear({ ...o, teeth: o.teethA });
  const centerDistance = (o.module * (o.teethA + o.teethB)) / 2;
  const phase = o.teethB % 2 === 0 ? 180 / o.teethB : 0;
  const b = spurGear({ ...o, teeth: o.teethB }).rotateZ(phase).translate(centerDistance, 0, 0);
  return { a, b, centerDistance, ratio: o.teethB / o.teethA, group: group({ name: 'Gear A', shape: a }, { name: 'Gear B', shape: b }) };
}
export function bevelGearPair(o: { module: number; teethA: number; teethB: number; faceWidth: number; shaftAngleDeg?: number }) {
  const sigma = ((o.shaftAngleDeg ?? 90) * Math.PI) / 180;
  const d1 = Math.atan(Math.sin(sigma) / (o.teethB / o.teethA + Math.cos(sigma))) * (180 / Math.PI);
  const d2 = (o.shaftAngleDeg ?? 90) - d1;
  const a = bevelGear({ ...o, teeth: o.teethA, pitchAngleDeg: d1 });
  const b = bevelGear({ ...o, teeth: o.teethB, pitchAngleDeg: d2 });
  return { a, b, ratio: o.teethB / o.teethA, pitchAnglesDeg: [d1, d2] };
}
export function faceGearPair(o: { module: number; teethA: number; teethB: number; faceWidth: number }) {
  return { pinion: spurGear({ ...o, teeth: o.teethA }), face: faceGear({ ...o, teeth: o.teethB }), ratio: o.teethB / o.teethA };
}
export const gearRatio = (a: number, b: number, o: { internal?: boolean } = {}) => (o.internal ? b / a : -b / a);
export const rackRatio = (module: number, pinionTeeth: number) => (Math.PI * module * pinionTeeth) / 360; // mm per degree
export const planetaryRatio = (sun: number, ring: number) => 1 + ring / sun;

export const gearBodies = {
  disk: (o: { radius: number; thickness: number; bore?: number }) => { let s = cylinder(o.thickness, o.radius); if (o.bore) s = s.subtract(cylinder(o.thickness + 2, o.bore / 2).translate(0, 0, -1)); return s; },
  diskWithHub: (o: { radius: number; thickness: number; hubRadius: number; hubHeight: number; bore?: number }) => {
    let s = cylinder(o.thickness, o.radius).add(cylinder(o.hubHeight, o.hubRadius));
    if (o.bore) s = s.subtract(cylinder(o.hubHeight + 2, o.bore / 2).translate(0, 0, -1));
    return s;
  },
  spoked: (o: { radius: number; thickness: number; spokes?: number; rim?: number; hubRadius?: number; bore?: number }) => {
    const n = o.spokes ?? 5;
    const rim = o.rim ?? o.radius * 0.15;
    let s = cylinder(o.thickness, o.radius).subtract(cylinder(o.thickness + 2, o.radius - rim).translate(0, 0, -1));
    s = s.add(cylinder(o.thickness, o.hubRadius ?? o.radius * 0.25));
    const spoke = box(o.radius - rim / 2, o.radius * 0.12, o.thickness).translate((o.radius - rim / 2) / 2, 0, 0);
    s = s.add(circularPattern(spoke, n));
    if (o.bore) s = s.subtract(cylinder(o.thickness + 2, o.bore / 2).translate(0, 0, -1));
    return s;
  },
  fromProfile: (sk: Sketch, thickness: number) => sk.extrude(thickness),
};

class DriveWheelBuilder {
  private regions: { kind: string; from: number; to: number; opts: any }[] = [];
  constructor(private o: any) {}
  addSpurTeethBetween(fromDeg: number, toDeg: number, opts: any = {}) { this.regions.push({ kind: 'teeth', from: fromDeg, to: toDeg, opts }); return this; }
  addSolidArcBetween(fromDeg: number, toDeg: number, opts: any = {}) { this.regions.push({ kind: 'solid', from: fromDeg, to: toDeg, opts }); return this; }
  addShapeRegion(shape: Shape) { this.regions.push({ kind: 'shape', from: 0, to: 0, opts: { shape } }); return this; }
  build(): Shape {
    const m = this.o.module ?? 1, z = this.o.teeth ?? 30, w = this.o.faceWidth ?? 5;
    const R = m * z;
    const wedge = (a0: number, a1: number) => { const pts: Vec2[] = [[0, 0]]; for (let a = a0; a <= a1 + 1e-6; a += 2) pts.push([R * Math.cos((a * Math.PI) / 180), R * Math.sin((a * Math.PI) / 180)]); return polygon(pts); };
    const full = spurGearProfile({ module: m, teeth: z });
    const rf = (m * z) / 2 - 1.25 * m;
    let sk = circle2d(rf);
    const extra: Shape[] = [];
    for (const r of this.regions) {
      if (r.kind === 'teeth') sk = sk.add(full.intersect(wedge(r.from, r.to)));
      else if (r.kind === 'solid') sk = sk.add(circle2d((m * z) / 2).intersect(wedge(r.from, r.to)));
      else extra.push(r.opts.shape);
    }
    let s = sk.extrude(w);
    if (this.o.boreDiameter) s = s.subtract(cylinder(w + 2, this.o.boreDiameter / 2).translate(0, 0, -1));
    return (extra.length ? s.add(extra) : s).withMeta({ driveWheel: { module: m, teeth: z, regions: this.regions.map(({ opts, ...r }) => r) } });
  }
}
export function driveWheel(o: any = {}) { return new DriveWheelBuilder(o); }
export function readDriveWheelMeta(s: Shape) { return s.meta.driveWheel ?? null; }

export { ForgeError, mat4, DEFAULT_SEGMENTS };

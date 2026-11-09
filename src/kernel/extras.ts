// Helpers that round out the modelling API: point maths, transforms, connector kinds, references,
// metadata attachers, slicing statics, route builder, optics, joinery, the `lib` namespace and
// extra Shape / ShapeGroup / Assembly methods.
import { ForgeError } from './errors';
import { mat4, Mat4, toVec2, toVec3, v3, Vec2, Vec3 } from './math';
import { Connector, connectorFrame, mateTransform, normConnector, Shape } from './shape';
import { ShapeGroup, box, union } from './ops';
import { Sketch, polygon, stroke } from './sketch';
import { Assembly, connector as baseConnector } from './assembly';
import { loft } from './curves';
import { filletPolyline3 } from './curves';
import * as lib from './lib';
import { ctx } from './context';

// ---------------------------------------------------------------- points
const p3 = (p: any): Vec3 => toVec3(Array.isArray(p) && p.length === 2 ? [p[0], p[1], 0] : p);
export const Points = {
  distance: (a: any, b: any) => v3.dist(p3(a), p3(b)),
  midpoint: (a: any, b: any): Vec3 => v3.lerp(p3(a), p3(b), 0.5),
  lerp: (a: any, b: any, t: number): Vec3 => v3.lerp(p3(a), p3(b), t),
  direction: (a: any, b: any): Vec3 => v3.norm(v3.sub(p3(b), p3(a))),
  offset: (p: any, dir: any, distance = 1): Vec3 => v3.add(p3(p), v3.scale(v3.norm(p3(dir)), distance)),
  polar: (radius: number, angleDeg: number, z = 0): Vec3 => [radius * Math.cos((angleDeg * Math.PI) / 180), radius * Math.sin((angleDeg * Math.PI) / 180), z],
};

// ---------------------------------------------------------------- transforms
function frameMatrix(f: any): Mat4 {
  if (Array.isArray(f) && f.length === 16) return f;
  if (f?.matrix) return f.matrix;
  if (f?.axis && f?.up && f?.origin) return connectorFrame(normConnector(f));
  const o = toVec3(f?.origin ?? [0, 0, 0]);
  const z = v3.norm(toVec3(f?.z ?? f?.normal ?? f?.axis ?? [0, 0, 1]));
  let x = f?.x ? toVec3(f.x) : v3.perp(z);
  x = v3.norm(v3.sub(x, v3.scale(z, v3.dot(x, z))));
  return mat4.fromFrame(x, v3.cross(z, x), z, o);
}
/** Rotation about `axis` through `pivot` (degrees). */
function rotationAxis(axis: any, deg: number, pivot: any = [0, 0, 0]): Mat4 {
  const p = toVec3(pivot);
  return mat4.mul(mat4.translation(p[0], p[1], p[2]), mat4.mul(mat4.axisAngle(v3.norm(toVec3(axis)), deg), mat4.translation(-p[0], -p[1], -p[2])));
}
/** Rotation about `axis` through `pivot` that turns the point `from` towards the point `to`. */
function rotateAroundTo(axis: any, pivot: any, from: any, to: any): Mat4 {
  const a = v3.norm(toVec3(axis)), p = toVec3(pivot);
  const flat = (q: Vec3) => { const d = v3.sub(toVec3(q), p); return v3.sub(d, v3.scale(a, v3.dot(d, a))); };
  const u = flat(from), w = flat(to);
  if (v3.len(u) < 1e-9 || v3.len(w) < 1e-9) return mat4.identity();
  const ang = Math.atan2(v3.dot(a, v3.cross(u, w)), v3.dot(u, w)) * 180 / Math.PI;
  return rotationAxis(a, ang, p);
}
export const TransformExtras = {
  compose: (...ms: any[]) => ms.flat().map(frameMatrix).reduce((acc: Mat4, m: Mat4) => mat4.mul(m, acc), mat4.identity()),
  fromFrame: (f: any) => frameMatrix(f),
  rotationAxis,
  rotateAroundTo,
};

// ---------------------------------------------------------------- connectors
export const connector: any = Object.assign((a: any, b?: any) => baseConnector(a, b), {
  male: (name: string, o: any = {}) => baseConnector(name, { ...o, kind: 'male', type: o.type ?? 'male' }),
  female: (name: string, o: any = {}) => baseConnector(name, { ...o, kind: 'female', type: o.type ?? 'female' }),
});

/** Names of the 27 bounding-box anchors (centre, faces, edges and corners). */
export const ANCHOR3D_NAMES: string[] = (() => {
  const out: string[] = [];
  for (const z of ['bottom', '', 'top']) for (const y of ['front', '', 'back']) for (const x of ['left', '', 'right']) {
    const n = [z, y, x].filter(Boolean).join('-');
    out.push(n || 'center');
  }
  return out;
})();
export function anchor3d(s: { boundingBox(): any }, name: string): Vec3 {
  const b = s.boundingBox();
  const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
  const pick = (lo: number, hi: number, l: string, h: string) => (name.includes(l) ? lo : name.includes(h) ? hi : (lo + hi) / 2);
  return [pick(x0, x1, 'left', 'right'), pick(y0, y1, 'front', 'back'), pick(z0, z1, 'bottom', 'top')];
}
export const SHEET_METAL_EDGES = ['top', 'bottom', 'left', 'right'] as const;

// ---------------------------------------------------------------- shared method bodies
function connectorNames(this: any): string[] { return Object.keys(this.connectors ?? {}).filter((k) => this.connectors[k].kind !== 'reference'); }
function connectorsByType(this: any, type: string): Connector[] {
  return Object.values(this.connectors ?? {}).filter((c: any) => c.kind === type || c.type === type) as Connector[];
}
function connectorOf(o: any, name: string): Connector {
  const c = o.connectors?.[name];
  if (!c) throw new ForgeError('CONNECTOR.NOT_FOUND', `no connector "${name}" (have: ${Object.keys(o.connectors ?? {}).join(', ') || 'none'})`);
  return c;
}
function connectorDistance(this: any, a: string, b: string): number { return v3.dist(connectorOf(this, a).origin, connectorOf(this, b).origin); }
function connectorMeasurements(this: any) {
  const names = connectorNames.call(this);
  const out: { a: string; b: string; distance: number; angle: number }[] = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const A = connectorOf(this, names[i]), B = connectorOf(this, names[j]);
    out.push({ a: names[i], b: names[j], distance: v3.dist(A.origin, B.origin), angle: Math.acos(Math.max(-1, Math.min(1, v3.dot(A.axis, B.axis)))) * 180 / Math.PI });
  }
  return out;
}
function referenceNames(this: any): string[] { return [...new Set([...Object.keys(this.meta?.references ?? {}), ...Object.keys(this.connectors ?? {})])]; }
function referencePoint(this: any, name: string): Vec3 {
  const r = this.meta?.references?.[name] ?? this.connectors?.[name]?.origin;
  if (r) return toVec3(r);
  if (ANCHOR3D_NAMES.includes(name)) return anchor3d(this, name);
  throw new ForgeError('REFERENCE.NOT_FOUND', `no reference "${name}" (have: ${referenceNames.call(this).join(', ') || 'none'}; anchors like "top-front-left" also work)`);
}
function metaAdder(key: string, merge = false) {
  return function (this: any, value: any) {
    const prev = this.meta?.[key];
    const v = merge && Array.isArray(prev) ? [...prev, value] : value;
    return this.withMeta({ [key]: v });
  };
}
function withPhysicalMaterial(this: any, mat: any) {
  const m = typeof mat === 'string' ? { id: mat, name: mat } : mat;
  let out = this.withMeta({ physicalMaterial: m });
  const ap = m?.appearance;
  if (ap?.color && out.color) out = out.color(ap.color);
  return out;
}

// ---------------------------------------------------------------- Shape methods
const S = Shape.prototype as any;
Object.assign(S, {
  clone(this: Shape) { return this.derive(this.m); },
  connectorNames, connectorsByType, connectorDistance, connectorMeasurements, referenceNames, referencePoint,
  ref(this: Shape, name: string) { return referencePoint.call(this, name); },
  numBodies(this: Shape) { return this.m.decompose().length; },
  getMesh(this: Shape) { const t = this.mesh; return { positions: t.positions, indices: t.indices, normals: (t as any).normals, numTri: this.numTri(), numVert: this.numVert() }; },
  geometryInfo(this: Shape) {
    const b = this.boundingBox();
    return { volume: this.volume(), surfaceArea: this.surfaceArea(), bodies: this.m.decompose().length, genus: this.genus(), triangles: this.numTri(), vertices: this.numVert(), bounds: { min: b.min, max: b.max, size: b.size }, centroid: this.centroid(), faces: this.faceNames() };
  },
  withManufacturing: metaAdder('manufacturing'),
  manufacturing(this: Shape) { return this.meta.manufacturing ?? null; },
  withPhysicalMaterial,
  physicalMaterial(this: Shape) { return this.meta.physicalMaterial ?? null; },
  withAssemblyStep(this: Shape, step: any) { return this.withMeta({ assemblyStep: typeof step === 'number' ? { order: step } : step }); },
  withInstructionPage(this: Shape, page: any) { return this.withMeta({ instructionPages: [...(this.meta.instructionPages ?? []), page] }); },
  withDrawing(this: Shape, o: any = {}) { return this.withMeta({ drawing: { ...(this.meta.drawing ?? {}), ...o } }); },
  withDatum(this: Shape, name: string, d: any) {
    const datum = Array.isArray(d) && typeof d[0] === 'number' ? { kind: 'point', point: toVec3(d) } : d;
    let out = this.withMeta({ datums: { ...(this.meta.datums ?? {}), [name]: datum } });
    if (datum.kind === 'point' || datum.point || datum.origin) out = out.withReferences({ points: { [name]: toVec3(datum.point ?? datum.origin) } });
    return out;
  },
  /** Move so this part's `bottom` face sits flush in a pocket/hole of `target`, recessed by `depth`. */
  seatInto(this: Shape, target: Shape, o: { face?: string; selfFace?: string; depth?: number; offset?: Vec3 } = {}) {
    const placed = this.attachTo(target, o.face ?? 'top', o.selfFace ?? 'bottom', o.offset ?? [0, 0, 0]);
    const n = target.face(o.face ?? 'top').normal;
    const d = o.depth ?? 0;
    return placed.translate(-n[0] * d, -n[1] * d, -n[2] * d);
  },
  /** Put this part over `target` so its `bottom` face rests on target's `top` (a cap or cover). */
  seatOver(this: Shape, target: Shape, o: { face?: string; selfFace?: string; offset?: Vec3; gap?: number } = {}) {
    const placed = this.attachTo(target, o.face ?? 'top', o.selfFace ?? 'bottom', o.offset ?? [0, 0, 0]);
    const n = target.face(o.face ?? 'top').normal, g = o.gap ?? 0;
    return placed.translate(n[0] * g, n[1] * g, n[2] * g);
  },
  /** Split by a plane-like surface ({origin, normal}, a face, or a Surface sheet). Returns [front, back]. */
  splitBySurface(this: Shape, surf: any): [Shape, Shape] {
    if (surf?.toCutter) { const c = surf.toCutter(this); return [this.intersect(c), this.subtract(c)]; }
    const n = v3.norm(toVec3(surf?.normal ?? [0, 0, 1])), o = toVec3(surf?.origin ?? surf?.center ?? surf?.point ?? [0, 0, 0]);
    return this.splitByPlane(n, v3.dot(n, o));
  },
  rotateAroundTo(this: Shape, axis: any, pivot: any, from: any, to: any) { return this.transform(rotateAroundTo(axis, pivot, from, to)); },
});

// Shape statics: sections.
function frameSlice(shape: Shape, frame: Mat4): Sketch {
  const inv = mat4.invert(frame);
  const local = shape.transform(inv);
  return new Sketch(local.m.slice(0), [], frame);
}
Object.assign(Shape as any, {
  slicePerpendicularToX: (s: Shape, x = 0) => frameSlice(s, mat4.fromFrame([0, 1, 0], [0, 0, 1], [1, 0, 0], [x, 0, 0])),
  slicePerpendicularToY: (s: Shape, y = 0) => frameSlice(s, mat4.fromFrame([0, 0, 1], [1, 0, 0], [0, 1, 0], [0, y, 0])),
  slicePerpendicularToZ: (s: Shape, z = 0) => frameSlice(s, mat4.identity().map((v, i) => (i === 14 ? z : v))),
  sliceThrough: (s: Shape, plane: { origin?: Vec3; normal?: Vec3; x?: Vec3 }) => frameSlice(s, frameMatrix({ origin: plane.origin, z: plane.normal ?? [0, 0, 1], x: plane.x })),
  sliceOnFrame: (s: Shape, frame: any) => frameSlice(s, frameMatrix(frame)),
  /** Loft through sketches stacked at heights: fromSlices([{ z, sketch }, ...]) or (sketches, heights). */
  fromSlices: (slices: any[], heights?: number[]) => {
    const list = heights ? slices.map((sk, i) => ({ sketch: sk, z: heights[i] })) : slices.map((s: any, i: number) => (s instanceof Sketch ? { sketch: s, z: i } : { sketch: s.sketch ?? s.profile, z: s.z ?? s.height ?? i }));
    return loft(list.map((l) => l.sketch), list.map((l) => l.z));
  },
});

// ---------------------------------------------------------------- ShapeGroup methods
const G = ShapeGroup.prototype as any;
Object.assign(G, {
  childNames(this: ShapeGroup) { return this.names(); },
  childName(this: ShapeGroup, i: number) { return this.children[i]?.name; },
  clone(this: ShapeGroup) { return this.with({ children: this.children.map((c) => ({ ...c })) }); },
  isEmpty(this: ShapeGroup) { return this.shapes().every((s) => s.isEmpty()); },
  withMeta(this: ShapeGroup, meta: any) { return this.with({ meta: { ...this.meta, ...meta } }); },
  withConnectors(this: ShapeGroup, conns: Record<string, any>) {
    const out = { ...this.connectors };
    for (const [k, c] of Object.entries(conns)) out[k] = normConnector(c, k);
    return this.with({ connectors: out });
  },
  connector(this: ShapeGroup, name: string) { return connectorOf(this, name); },
  getConnectors(this: ShapeGroup) { return this.connectors; },
  connectorNames, connectorsByType, connectorDistance, connectorMeasurements, referenceNames, referencePoint,
  /** Connector names of every child, as "child.connector" (ports the group exposes). */
  portNames(this: ShapeGroup) {
    return [...Object.keys(this.connectors), ...this.children.flatMap((c) => Object.keys((c.item as any).connectors ?? {}).map((k) => `${c.name}.${k}`))];
  },
  withReferences(this: any, refs: any) { return this.withMeta({ references: { ...(this.meta.references ?? {}), ...(refs.points ?? refs) } }); },
  placeReference(this: ShapeGroup, ref: string, target: Vec3, offset: Vec3 = [0, 0, 0]) {
    const p = referencePoint.call(this, ref), t = toVec3(target), o = toVec3(offset);
    return this.translate(t[0] - p[0] + o[0], t[1] - p[1] + o[1], t[2] - p[2] + o[2]);
  },
  matchTo(this: ShapeGroup, mine: string, target: any, opts: { flip?: boolean; offset?: number } = {}) {
    const a = connectorOf(this, mine);
    const tgt: Connector = Array.isArray(target) ? { origin: toVec3(target), axis: [0, 0, 1], up: [1, 0, 0] } : normConnector(target);
    return this.transform(mateTransform(a, tgt, opts.flip ?? true, opts.offset ?? 0));
  },
  scale(this: any, v: number | Vec3) { return this.scaleAround(this.boundingBox().center, v); },
  scaleAround(this: ShapeGroup, pivot: Vec3, v: number | Vec3) {
    const p = toVec3(pivot), s = typeof v === 'number' ? [v, v, v] : toVec3(v);
    return this.transform(mat4.mul(mat4.translation(p[0], p[1], p[2]), mat4.mul(mat4.scaling(s[0], s[1], s[2]), mat4.translation(-p[0], -p[1], -p[2]))));
  },
  mirror(this: ShapeGroup, normal: Vec3) { return this.mirrorThrough(this.boundingBox().center, normal); },
  pointAlong(this: ShapeGroup, dir: Vec3) { return this.transform(mat4.rotationBetween([0, 0, 1], v3.norm(toVec3(dir)))); },
  rotateAroundTo(this: ShapeGroup, axis: any, pivot: any, from: any, to: any) { return this.transform(rotateAroundTo(axis, pivot, from, to)); },
  /** Place the group on a face of `shape`: its local XY plane on the face, Z along the face normal. */
  onFace(this: ShapeGroup, shape: Shape, face: string, o: { u?: number; v?: number; protrude?: number } = {}) {
    const f = shape.face(face);
    const origin = v3.add(v3.add(v3.add(f.center, v3.scale(f.uAxis as Vec3, o.u ?? 0)), v3.scale(f.vAxis as Vec3, o.v ?? 0)), v3.scale(f.normal, o.protrude ?? 0));
    return this.transform(mat4.fromFrame(f.uAxis as Vec3, f.vAxis as Vec3, f.normal, origin));
  },
  withManufacturing(this: any, m: any) { return this.withMeta({ manufacturing: m }); },
  manufacturing(this: ShapeGroup) { return this.meta.manufacturing ?? null; },
  withPhysicalMaterial(this: any, m: any) { return this.withMeta({ physicalMaterial: typeof m === 'string' ? { id: m, name: m } : m }); },
  physicalMaterial(this: ShapeGroup) { return this.meta.physicalMaterial ?? null; },
  withAssemblyStep(this: any, step: any) { return this.withMeta({ assemblyStep: typeof step === 'number' ? { order: step } : step }); },
  withInstructionPage(this: any, page: any) { return this.withMeta({ instructionPages: [...(this.meta.instructionPages ?? []), page] }); },
  volume(this: ShapeGroup) { return this.shapes().reduce((a, s) => a + s.volume(), 0); },
});

// ---------------------------------------------------------------- Assembly.addJoint
/**
 * addJoint(name, type, parent, child, { origin, axis, up, childOrigin, min, max, default, ... })
 * Adds a joint without pre-declared connectors: the frame is given in each part's own coordinates.
 * `parentConnector` / `childConnector` may name existing connectors instead.
 */
(Assembly.prototype as any).addJoint = function (this: Assembly, name: string, type: string, parent: string, child: string, o: any = {}) {
  const axis = v3.norm(toVec3(o.axis ?? [0, 0, 1])), up = o.up ? toVec3(o.up) : v3.perp(axis);
  const pc = o.parentConnector ?? `__j_${name}_p`, cc = o.childConnector ?? `__j_${name}_c`;
  if (!o.parentConnector) this.withConnectors(parent, { [pc]: { origin: o.origin ?? o.parentOrigin ?? [0, 0, 0], axis, up } });
  if (!o.childConnector) this.withConnectors(child, { [cc]: { origin: o.childOrigin ?? [0, 0, 0], axis: o.childAxis ?? v3.scale(axis, -1), up: o.childUp ?? up } });
  const { origin, axis: _a, up: _u, childOrigin, childAxis, childUp, parentConnector, childConnector, ...rest } = o;
  return this.connect(`${parent}.${pc}`, `${child}.${cc}`, { ...rest, type, as: name });
};

// ---------------------------------------------------------------- route builder (2D turtle)
export class RouteBuilder {
  private pts: Vec2[];
  private heading: number;
  private closed = false;
  constructor(start: any = [0, 0], o: { heading?: number } = {}) { this.pts = [toVec2(start)]; this.heading = o.heading ?? 0; }
  private get last(): Vec2 { return this.pts[this.pts.length - 1]; }
  private to(p: Vec2) { this.pts.push(p); return this; }
  private go(dx: number, dy: number) { const l = this.last; this.heading = Math.atan2(dy, dx) * 180 / Math.PI; return this.to([l[0] + dx, l[1] + dy]); }
  up(d: number) { return this.go(0, d); }
  down(d: number) { return this.go(0, -d); }
  right(d: number) { return this.go(d, 0); }
  left(d: number) { return this.go(-d, 0); }
  line(dx: number, dy: number) { return this.go(dx, dy); }
  lineTo(x: number, y: number) { const l = this.last; return this.go(x - l[0], y - l[1]); }
  lineAt(angleDeg: number, length: number) { const a = angleDeg * Math.PI / 180; return this.go(Math.cos(a) * length, Math.sin(a) * length); }
  forward(length: number) { return this.lineAt(this.heading, length); }
  toward(target: any, length?: number) {
    const t = toVec2(target), l = this.last, d = Math.hypot(t[0] - l[0], t[1] - l[1]) || 1;
    const k = (length ?? d) / d;
    return this.go((t[0] - l[0]) * k, (t[1] - l[1]) * k);
  }
  private arc(radius: number, deg: number, dir: 1 | -1) {
    const h = this.heading * Math.PI / 180, l = this.last;
    const c: Vec2 = [l[0] - dir * Math.sin(h) * radius, l[1] + dir * Math.cos(h) * radius];
    const a0 = Math.atan2(l[1] - c[1], l[0] - c[0]);
    const n = Math.max(4, Math.ceil(Math.abs(deg) / 5));
    for (let i = 1; i <= n; i++) { const a = a0 + dir * (deg * Math.PI / 180) * (i / n); this.pts.push([c[0] + radius * Math.cos(a), c[1] + radius * Math.sin(a)]); }
    this.heading += dir * deg;
    return this;
  }
  arcLeft(radius: number, deg = 90) { return this.arc(radius, deg, 1); }
  arcRight(radius: number, deg = 90) { return this.arc(radius, deg, -1); }
  close() { this.closed = true; return this; }
  get start(): Vec2 { return this.pts[0]; }
  get end(): Vec2 { return this.last; }
  points() { return [...this.pts]; }
  /** Finish: returns the polyline with helpers to stroke, fill or lift it into 3D. */
  done() {
    const pts = [...this.pts], closed = this.closed;
    return {
      points: pts, closed, start: pts[0], end: pts[pts.length - 1],
      length: pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), closed ? Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) : 0),
      stroke: (width: number) => stroke(closed ? [...pts, pts[0]] : pts, width),
      toSketch: (width?: number) => (closed && !width ? polygon(pts) : stroke(closed ? [...pts, pts[0]] : pts, width ?? 1)),
      to3d: (z = 0): Vec3[] => pts.map((p) => [p[0], p[1], z]),
    };
  }
}
export const route: any = Object.assign((start?: any, o?: any) => new RouteBuilder(start, o), {
  line: (points: any[]) => points.map((p) => p3(p)),
  fillet: (points: any[], radius: number) => filletPolyline3(points.map((p) => p3(p)), radius),
});

// ---------------------------------------------------------------- optics
export const Optics = {
  /** Thin-lens equation 1/f = 1/do + 1/di. */
  thinLens(o: { focalLength: number; objectDistance: number; objectHeight?: number }) {
    const { focalLength: f, objectDistance: d } = o;
    const di = Math.abs(d - f) < 1e-12 ? Infinity : (f * d) / (d - f);
    const m = -di / d;
    return { imageDistance: di, magnification: m, imageHeight: o.objectHeight != null ? o.objectHeight * m : undefined, real: di > 0, power: 1000 / f };
  },
  camera(o: { position?: Vec3; target?: Vec3; up?: Vec3; fov?: number; focalLength?: number; sensorWidth?: number; name?: string } = {}) {
    const sensor = o.sensorWidth ?? 36;
    const fov = o.fov ?? (o.focalLength ? (2 * Math.atan(sensor / 2 / o.focalLength) * 180) / Math.PI : 45);
    const cam = { kind: 'camera', name: o.name ?? 'camera', position: toVec3(o.position ?? [200, -200, 160]), target: toVec3(o.target ?? [0, 0, 0]), up: toVec3(o.up ?? [0, 0, 1]), fov };
    const c = ctx() as any;
    if (c) (c.cameras ??= []).push(cam);
    return cam;
  },
  /** A person's eye view: eye height above `standOn`, looking at `target`. */
  eyeCamera(o: { at?: Vec3; eyeHeight?: number; target?: Vec3; fov?: number } = {}) {
    const at = toVec3(o.at ?? [0, -1500, 0]);
    return Optics.camera({ position: [at[0], at[1], at[2] + (o.eyeHeight ?? 1600)], target: o.target ?? [0, 0, 800], fov: o.fov ?? 60, name: 'eye' });
  },
  currentCamera() {
    const c = ctx() as any;
    return c?.cameras?.[c.cameras.length - 1] ?? { kind: 'camera', name: 'default', position: [200, -200, 160], target: [0, 0, 0], up: [0, 0, 1], fov: 45 };
  },
};

// ---------------------------------------------------------------- sim presets
export const SimReady = {
  /** Neutral prop settings for robotics scenes: plastic-like density, moderate friction, little bounce. */
  propRoboticsNeutral: (o: any = {}) => ({ profile: 'prop-robotics-neutral', densityKgM3: 1100, staticFriction: 0.6, dynamicFriction: 0.5, restitution: 0.05, collider: 'hull', motion: 'dynamic', ...o }),
};

// ---------------------------------------------------------------- wood joinery
export const woodJoinery = {
  /** Cut a dado (groove across the grain) into `face` of a board. */
  dado(shape: Shape, face: string, o: { width: number; depth: number; offset?: number; along?: 'u' | 'v' }) {
    const len = 4 * Math.max(...shape.boundingBox().size);
    const r = (w: number, h: number) => polygon([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]);
    const groove = o.along === 'v' ? r(o.width, len).translate(o.offset ?? 0, 0) : r(len, o.width).translate(0, o.offset ?? 0);
    return shape.cutout(groove.onFace(shape, face), { depth: o.depth }).withMeta({ joinery: [...(shape.meta.joinery ?? []), { kind: 'dado', face, ...o }] });
  },
  /** Cut a rabbet (step) along the edge where `face` meets `edgeFace`. */
  rabbet(shape: Shape, face: string, edgeFace: string, o: { width: number; depth: number }) {
    const f = shape.face(face), e = shape.face(edgeFace);
    const big = 4 * Math.max(...shape.boundingBox().size);
    const n = v3.norm(f.normal), m = v3.norm(e.normal), side = v3.norm(v3.cross(n, m));
    const origin = v3.add(v3.add(v3.scale(n, v3.dot(n, f.center) - o.depth), v3.scale(m, v3.dot(m, e.center))), v3.scale(side, v3.dot(side, shape.center())));
    const cutter = box(big, o.width * 2, o.depth * 2).transform(mat4.fromFrame(side, m, n, origin));
    return shape.subtract(cutter).withMeta({ joinery: [...(shape.meta.joinery ?? []), { kind: 'rabbet', face, edgeFace, ...o }] });
  },
  /** Mortise in `a` on `aFace` and a matching tenon on `b` at `bFace`. Returns both parts. */
  mortiseAndTenon(a: Shape, aFace: string, b: Shape, bFace: string, o: { width: number; thickness: number; length: number; clearance?: number }) {
    const c = o.clearance ?? 0.2;
    const tenon = polygon([[-o.width / 2, -o.thickness / 2], [o.width / 2, -o.thickness / 2], [o.width / 2, o.thickness / 2], [-o.width / 2, o.thickness / 2]]);
    const tenoned = b.add(tenon.onFace(b, bFace).extrude(o.length));
    const mortised = a.cutout(polygon([[-(o.width + c) / 2, -(o.thickness + c) / 2], [(o.width + c) / 2, -(o.thickness + c) / 2], [(o.width + c) / 2, (o.thickness + c) / 2], [-(o.width + c) / 2, (o.thickness + c) / 2]]).onFace(a, aFace), { depth: o.length + c });
    return { mortised: mortised.withMeta({ joinery: [...(a.meta.joinery ?? []), { kind: 'mortise', face: aFace, ...o }] }), tenoned: tenoned.withMeta({ joinery: [...(b.meta.joinery ?? []), { kind: 'tenon', face: bFace, ...o }] }), mortise: mortised, tenon: tenoned };
  },
};

// ---------------------------------------------------------------- lib namespace
export const libNamespace = {
  tube: lib.tube, pipe: lib.pipe, explode: lib.explode, bracket: lib.bracket, holePattern: lib.holePattern, thread: lib.thread,
  bolt: lib.bolt, nut: lib.nut, washer: lib.washer, fastenerSet: lib.fastenerSet, boltPattern: lib.boltPattern,
  pipeRoute: lib.pipeRoute, elbow: lib.elbow, beltDrive: lib.beltDrive, tangentLoop2d: lib.tangentLoop2d,
  tSlotProfile: lib.tSlotProfile, tSlotExtrusion: lib.tSlotExtrusion, profile2020BSlot6Profile: lib.profile2020BSlot6Profile, profile2020BSlot6: lib.profile2020BSlot6,
  spurGear: lib.spurGear, spurGearProfile: lib.spurGearProfile, bevelGear: lib.bevelGear, faceGear: lib.faceGear, ringGear: lib.ringGear, rackGear: lib.rackGear,
  gearPair: lib.gearPair, bevelGearPair: lib.bevelGearPair, faceGearPair: lib.faceGearPair, gearRatio: lib.gearRatio, rackRatio: lib.rackRatio,
  planetaryRatio: lib.planetaryRatio, sectorGear: lib.sectorGear, gearBodies: lib.gearBodies, driveWheel: lib.driveWheel, readDriveWheelMeta: lib.readDriveWheelMeta,
  hexagon: lib.hexagon,
};

export { union };

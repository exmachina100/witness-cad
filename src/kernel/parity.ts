// ForgeCAD-compatible object model for the values the core and sketch calls return:
// transform objects, shape references, split results, 2D geometry classes and parameter values.
import { mat4, Mat4, toVec3, v3, Vec2, Vec3 } from './math';
import { Shape } from './shape';
import { ShapeGroup } from './ops';
import { Sketch, polygon, rect, circle2d, stroke, spline2d, catmullRom } from './sketch';
import { ForgeError } from './errors';
import { Curve, polylineCurve } from './curves';

// ---------------------------------------------------------------- Transform objects
/** A 4x4 column-major matrix that is still an array (so every existing API accepts it) with ForgeCAD's instance methods. */
export class TransformMatrix extends Array<number> {
  static get [Symbol.species]() { return Array; }
  static wrap(m: ArrayLike<number>): TransformMatrix {
    const t = Array.from(m) as any;
    Object.setPrototypeOf(t, TransformMatrix.prototype);
    return t;
  }
  /** this then other: the matrix product this · other (other is applied first to points). */
  mul(other: ArrayLike<number>) { return TransformMatrix.wrap(mat4.mul(this as any, Array.from(other) as Mat4)); }
  /** Follow this transform with a translation. */
  translate(x: number | Vec3, y = 0, z = 0) { const t = Array.isArray(x) ? x : [x, y, z]; return TransformMatrix.wrap(mat4.mul(mat4.translation(t[0], t[1], t[2]), this as any)); }
  /** Follow this transform with a rotation about `axis` (through `pivot`). */
  rotateAxis(axis: Vec3, deg: number, pivot?: Vec3) { return TransformMatrix.wrap(mat4.mul(rotAbout(toVec3(axis), deg, pivot), this as any)); }
  rotateX(deg: number, pivot?: Vec3) { return this.rotateAxis([1, 0, 0], deg, pivot); }
  rotateY(deg: number, pivot?: Vec3) { return this.rotateAxis([0, 1, 0], deg, pivot); }
  rotateZ(deg: number, pivot?: Vec3) { return this.rotateAxis([0, 0, 1], deg, pivot); }
  inverse() { return TransformMatrix.wrap(mat4.invert(this as any)); }
  point(p: Vec3) { return mat4.apply(this as any, toVec3(p)); }
  vector(v: Vec3) { return mat4.applyDir(this as any, toVec3(v)); }
  toArray() { return Array.from(this); }
}
export function rotAbout(axis: Vec3, deg: number, pivot?: Vec3): Mat4 {
  const r = mat4.axisAngle(v3.norm(axis), deg);
  if (!pivot) return r;
  const p = toVec3(pivot);
  return mat4.mul(mat4.translation(p[0], p[1], p[2]), mat4.mul(r, mat4.translation(-p[0], -p[1], -p[2])));
}
/** Wrap every 16-number array a Transform.* call returns. */
export function wrapTransformNamespace<T extends Record<string, any>>(ns: T): T {
  const out: any = {};
  for (const [k, f] of Object.entries(ns)) {
    out[k] = typeof f === 'function' ? (...a: any[]) => { const r = f(...a); return Array.isArray(r) && r.length === 16 && typeof r[0] === 'number' ? TransformMatrix.wrap(r) : r; } : f;
  }
  return out;
}

// ---------------------------------------------------------------- shape references
type RefKind = 'point' | 'face' | 'faces' | 'edge' | 'edges' | 'missing';
/**
 * shape.ref(path): a lazy reference to a point, face or edges of a shape.
 * It is also an array: for points (and faces) it holds the point (face center), so `shape.ref('top-front-left')` still reads as [x, y, z].
 */
export class ShapeRef extends Array<number> {
  static get [Symbol.species]() { return Array; }
  declare path: string;
  declare private _owner: any;
  declare private _cache: { kind: RefKind; value: any; message?: string };
  static make(owner: any, path: string): ShapeRef {
    const r = [] as any;
    Object.setPrototypeOf(r, ShapeRef.prototype);
    Object.defineProperty(r, 'path', { value: path, enumerable: false });
    Object.defineProperty(r, '_owner', { value: owner, enumerable: false });
    Object.defineProperty(r, '_cache', { value: resolveRef(owner, path), enumerable: false, writable: true });
    const c = r._cache;
    const pt = c.kind === 'point' ? c.value : c.kind === 'face' ? c.value.center : null;
    if (pt) r.push(pt[0], pt[1], pt[2]);
    return r;
  }
  get kind(): RefKind { return this._cache.kind; }
  get cardinality(): 'one' | 'many' | 'none' { return this.kind === 'missing' ? 'none' : this.kind === 'faces' || this.kind === 'edges' ? 'many' : 'one'; }
  status() { return { ok: this.kind !== 'missing', kind: this.kind, path: this.path, ...(this._cache.message ? { message: this._cache.message } : {}) }; }
  resolve() { if (this.kind === 'missing') throw new ForgeError('REFERENCE.NOT_FOUND', this._cache.message ?? `nothing at "${this.path}"`); return this._cache.value; }
  faces(): any[] { return this.kind === 'face' ? [this._cache.value] : this.kind === 'faces' ? this._cache.value : []; }
  face() { const f = this.faces(); if (f.length !== 1) throw new ForgeError('REFERENCE.CARDINALITY', `"${this.path}" is ${f.length} face(s), not one`); return f[0]; }
  edges(): any[] { return this.kind === 'edge' ? [this._cache.value] : this.kind === 'edges' ? this._cache.value : []; }
  edge() { const e = this.edges(); if (e.length !== 1) throw new ForgeError('REFERENCE.CARDINALITY', `"${this.path}" is ${e.length} edge(s), not one`); return e[0]; }
  points(): Vec3[] {
    if (this.kind === 'point') return [this._cache.value];
    if (this.kind === 'face' || this.kind === 'faces') return this.faces().map((f) => f.center);
    return this.edges().flatMap((e) => [e.start, e.end]);
  }
  point(): Vec3 { const p = this.points(); if (this.kind !== 'point' && this.kind !== 'face') throw new ForgeError('REFERENCE.CARDINALITY', `"${this.path}" is not a single point`); return p[0]; }
  toJSON() { return { path: this.path, kind: this.kind, ...(this.length ? { point: Array.from(this) } : {}) }; }
}
function resolveRef(owner: any, path: string): { kind: RefKind; value: any; message?: string } {
  const refs = owner.meta?.references ?? {};
  try {
    if (refs[path]) return { kind: 'point', value: toVec3(refs[path]) };
    if (owner.connectors?.[path]) return { kind: 'point', value: toVec3(owner.connectors[path].origin) };
    if (owner instanceof Shape) {
      const sep = path.includes('|') ? '|' : path.includes(' & ') ? ' & ' : null;
      if (sep) { const [a, b] = path.split(sep).map((s) => s.trim()); const e = owner.edgesBetween(a, b); return e.length === 1 ? { kind: 'edge', value: e[0] } : { kind: 'edges', value: e }; }
      const m = /^(?:edges:|edgesOf:)(.+)$/.exec(path) ?? /^(.+)\.edges$/.exec(path);
      if (m) return { kind: 'edges', value: owner.edgesOf(m[1]) };
      if (path === 'faces' || path === '*') return { kind: 'faces', value: owner.faces() };
      if (owner.faceNames().includes(path)) return { kind: 'face', value: owner.face(path) };
    }
    return { kind: 'point', value: (owner as any).referencePoint(path) };
  } catch (e: any) {
    return { kind: 'missing', value: null, message: e?.message ?? String(e) };
  }
}

/** [inside, outside] that also answers inside() / outside(). */
export function splitResult(inside: Shape, outside: Shape) {
  const r: any = [inside, outside];
  r.inside = () => inside; r.outside = () => outside;
  Object.defineProperty(r, 'pieces', { get: () => [inside, outside].filter((s) => !s.isEmpty()), enumerable: false });
  return r as [Shape, Shape] & { inside(): Shape; outside(): Shape; pieces: Shape[] };
}
/** [positive, negative] that also answers positive() / negative(). */
export function surfaceSplitResult(pos: Shape, neg: Shape) {
  const r: any = [pos, neg];
  r.positive = () => pos; r.negative = () => neg;
  return r as [Shape, Shape] & { positive(): Shape; negative(): Shape };
}

/** Install the ForgeCAD-shaped Shape methods (called once by globals, after every other module patched Shape). */
export function installCoreParity() {
const S = Shape.prototype as any;
  const origSplit = S.split, origSplitBySurface = S.splitBySurface;
  Object.assign(S, {
    ref(this: Shape, path: string) { return ShapeRef.make(this, path); },
    split(this: Shape, cutter: Shape) { const [a, b] = origSplit.call(this, cutter); return splitResult(a, b); },
    splitBy(this: Shape, cutter: Shape) { const [a, b] = origSplit.call(this, cutter); return splitResult(a, b); },
    splitBySurface(this: Shape, surf: any) { const [a, b] = origSplitBySurface.call(this, surf); return surfaceSplitResult(a, b); },
    /** Keep the side of a surface (a Surface sheet, a face or { origin, normal }) its normal points to. */
    trimBySurface(this: Shape, surf: any) { return origSplitBySurface.call(this, surf)[0]; },
    /** rotateAround(axis, angleDeg, pivot) or rotateAround(angleDeg, pivot) (about Z). */
    rotateAround(this: Shape, a: any, b: any, c?: any) {
      return typeof a === 'number' ? this.transform(rotAbout([0, 0, 1], a, toVec3(b ?? [0, 0, 0]))) : this.transform(rotAbout(toVec3(a), b, toVec3(c ?? [0, 0, 0])));
    },
    /** Place this shape on a face of `parent`: local XY on the face, local Z along the face normal. */
    onFace(this: Shape, parent: Shape, face: string, o: { u?: number; v?: number; protrude?: number } = {}) {
      const f = parent.face(face);
      const origin = v3.add(v3.add(v3.add(f.center, v3.scale(f.uAxis as Vec3, o.u ?? 0)), v3.scale(f.vAxis as Vec3, o.v ?? 0)), v3.scale(f.normal, o.protrude ?? 0));
      return this.transform(mat4.fromFrame(f.uAxis as Vec3, f.vAxis as Vec3, f.normal, origin));
    },
  });
  (ShapeGroup.prototype as any).ref = function (this: any, path: string) { return ShapeRef.make(this, path); };
  
  
}
// Sketch: expose the cross-section backend under ForgeCAD's name.
Object.defineProperty(Sketch.prototype, 'cross', { configurable: true, get(this: any) { return this.cs; } });

// ---------------------------------------------------------------- 2D geometry classes
const P2 = (p: any): Vec2 => (p instanceof Point2D ? [p.x, p.y] : Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]);
export class Point2D {
  readonly kind = 'point2d';
  constructor(readonly x: number, readonly y: number) {}
  static from(p: any) { const [x, y] = P2(p); return new Point2D(x, y); }
  distanceTo(o: any) { const [x, y] = P2(o); return Math.hypot(x - this.x, y - this.y); }
  translate(dx: number, dy: number) { return new Point2D(this.x + dx, this.y + dy); }
  toArray(): Vec2 { return [this.x, this.y]; }
  get 0() { return this.x; }
  get 1() { return this.y; }
}
export class Line2D {
  readonly kind = 'line2d';
  readonly start: Point2D; readonly end: Point2D;
  constructor(start: any, end: any) { this.start = Point2D.from(start); this.end = Point2D.from(end); }
  get length() { return this.start.distanceTo(this.end); }
  get midpoint() { return new Point2D((this.start.x + this.end.x) / 2, (this.start.y + this.end.y) / 2); }
  get angle() { return (Math.atan2(this.end.y - this.start.y, this.end.x - this.start.x) * 180) / Math.PI; }
  get direction(): Vec2 { const L = this.length || 1; return [(this.end.x - this.start.x) / L, (this.end.y - this.start.y) / L]; }
  /** Parallel copy offset to the left by `distance`. */
  parallel(distance: number) { const [dx, dy] = this.direction; const n: Vec2 = [-dy * distance, dx * distance]; return new Line2D(this.start.translate(n[0], n[1]), this.end.translate(n[0], n[1])); }
  private hit(o: Line2D, seg: boolean) {
    const [x1, y1, x2, y2] = [this.start.x, this.start.y, this.end.x, this.end.y], [x3, y3, x4, y4] = [o.start.x, o.start.y, o.end.x, o.end.y];
    const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(d) < 1e-12) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d, u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;
    if (seg && (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9)) return null;
    return new Point2D(x1 + t * (x2 - x1), y1 + t * (y2 - y1));
  }
  intersect(o: Line2D) { return this.hit(o, false); }
  intersectSegment(o: Line2D) { return this.hit(o, true); }
  translate(dx: number, dy: number) { return new Line2D(this.start.translate(dx, dy), this.end.translate(dx, dy)); }
  toSketch(width = 1) { return stroke([this.start.toArray(), this.end.toArray()], width); }
  static fromCoordinates(x1: number, y1: number, x2: number, y2: number) { return new Line2D([x1, y1], [x2, y2]); }
  static fromPointAndAngle(origin: any, angleDeg: number, length: number) { const o = Point2D.from(origin), a = (angleDeg * Math.PI) / 180; return new Line2D(o, [o.x + length * Math.cos(a), o.y + length * Math.sin(a)]); }
  static fromPointAndDirection(origin: any, dir: Vec2, length: number) { const o = Point2D.from(origin), L = Math.hypot(dir[0], dir[1]) || 1; return new Line2D(o, [o.x + (dir[0] / L) * length, o.y + (dir[1] / L) * length]); }
}
export class Circle2D {
  readonly kind = 'circle2d';
  readonly center: Point2D;
  constructor(center: any, readonly radius: number) { this.center = Point2D.from(center); }
  get diameter() { return this.radius * 2; }
  get circumference() { return 2 * Math.PI * this.radius; }
  get area() { return Math.PI * this.radius * this.radius; }
  toSketch(segments?: number) { return circle2d(this.radius, segments).translate(this.center.x, this.center.y); }
  /** A cylinder with faces top, bottom and side. */
  extrude(height: number) { return this.toSketch().extrude(height); }
  translate(dx: number, dy: number) { return new Circle2D(this.center.translate(dx, dy), this.radius); }
  static fromCenterAndRadius(center: any, r: number) { return new Circle2D(center, r); }
  static fromDiameter(center: any, d: number) { return new Circle2D(center, d / 2); }
}
type RectSide = 'top' | 'bottom' | 'left' | 'right';
export class Rectangle2D {
  readonly kind = 'rectangle2d';
  /** Corners in order bottom-left, bottom-right, top-right, top-left (any rotation). */
  constructor(readonly corners: [Point2D, Point2D, Point2D, Point2D]) {}
  get width() { return this.corners[0].distanceTo(this.corners[1]); }
  get height() { return this.corners[1].distanceTo(this.corners[2]); }
  get center() { const c = this.corners; return new Point2D((c[0].x + c[2].x) / 2, (c[0].y + c[2].y) / 2); }
  side(name: RectSide) { const [bl, br, tr, tl] = this.corners; return name === 'bottom' ? new Line2D(bl, br) : name === 'right' ? new Line2D(br, tr) : name === 'top' ? new Line2D(tr, tl) : new Line2D(tl, bl); }
  vertex(name: 'bottom-left' | 'bottom-right' | 'top-right' | 'top-left') { const i = ['bottom-left', 'bottom-right', 'top-right', 'top-left'].indexOf(name); if (i < 0) throw new ForgeError('RECT.VERTEX', `no vertex "${name}"`); return this.corners[i]; }
  diagonals(): [Line2D, Line2D] { const [bl, br, tr, tl] = this.corners; return [new Line2D(bl, tr), new Line2D(br, tl)]; }
  translate(dx: number, dy: number) { return new Rectangle2D(this.corners.map((p) => p.translate(dx, dy)) as any); }
  toSketch() { return polygon(this.corners.map((p) => p.toArray())); }
  /** Extrude upward (or downward with up = false) into a box with faces top, bottom and side-*. */
  extrude(height: number, up = true) {
    const s = this.toSketch().extrude(height);
    return up ? s : s.translate(0, 0, -height);
  }
  static fromDimensions(x: number, y: number, width: number, height: number) { return new Rectangle2D([new Point2D(x, y), new Point2D(x + width, y), new Point2D(x + width, y + height), new Point2D(x, y + height)]); }
  static fromCenterAndDimensions(center: any, width: number, height: number) { const c = Point2D.from(center); return Rectangle2D.fromDimensions(c.x - width / 2, c.y - height / 2, width, height); }
  static from2Corners(p1: any, p2: any) { const a = Point2D.from(p1), b = Point2D.from(p2); return Rectangle2D.fromDimensions(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); }
  /** p1 → p2 is one side; p3 sets the height on that side's left or right. */
  static from3Points(p1: any, p2: any, p3: any) {
    const a = Point2D.from(p1), b = Point2D.from(p2), c = Point2D.from(p3);
    const L = new Line2D(a, b), [dx, dy] = L.direction;
    const h = (c.x - a.x) * -dy + (c.y - a.y) * dx;
    const n: Vec2 = [-dy * h, dx * h];
    const pts = [a, b, b.translate(n[0], n[1]), a.translate(n[0], n[1])];
    return new Rectangle2D((h >= 0 ? pts : [pts[3], pts[2], pts[1], pts[0]]) as any);
  }
}

// ---------------------------------------------------------------- parameter values
const xy = (p: any): Vec2 => [p.x ?? p[0], p.y ?? p[1]];
export class Path2DParamValue {
  readonly kind = 'path2dParam';
  constructor(private readonly pts: any[], readonly closed: boolean) {}
  points(): Vec2[] { return this.pts.map(xy); }
  toPolyline(): Vec2[] { return this.points(); }
  toSketch() { return this.closed ? polygon(this.points()) : stroke(this.points(), 1); }
  toStroke(width: number, join: 'Round' | 'Square' = 'Round') { const p = this.points(); return stroke(this.closed ? [...p, p[0]] : p, width, join); }
}
export class Spline2DParamValue {
  readonly kind = 'spline2dParam';
  constructor(private readonly pts: any[], readonly closed: boolean, readonly degree: number) {}
  points(): Vec2[] { return this.pts.map(xy); }
  /** Control nodes with their continuity (smooth unless the point says otherwise). */
  nodes() { return this.pts.map((p: any) => ({ point: xy(p), continuity: p.continuity ?? (p.corner ? 'corner' : 'smooth') })); }
  toPolyline(samples = 16): Vec2[] { return this.degree <= 1 ? this.points() : catmullRom(this.points(), this.closed, 0.5, samples); }
  toSketch(o: any = {}) { return spline2d(this.points(), { closed: this.closed, ...o }); }
  private place(map: (p: Vec2) => Vec3, o: { samples?: number } = {}) { return polylineCurve(this.toPolyline(o.samples ?? 16).map(map), this.closed); }
  toCurveOnXY(z = 0, o: any = {}) { return this.place(([a, b]) => [a, b, z], o); }
  toCurveOnXZ(y = 0, o: any = {}) { return this.place(([a, b]) => [a, y, b], o); }
  toCurveOnYZ(x = 0, o: any = {}) { return this.place(([a, b]) => [x, a, b], o); }
  private segments(map: (p: Vec2) => Vec3, o: { samples?: number } = {}) {
    const pts = this.points(), n = this.closed ? pts.length : pts.length - 1, out: any[] = [];
    const poly = this.toPolyline(o.samples ?? 16), per = Math.max(1, Math.round((poly.length - 1) / Math.max(1, n)));
    for (let i = 0; i < n; i++) out.push(polylineCurve(poly.slice(i * per, Math.min(poly.length, (i + 1) * per + 1)).map(map)));
    return out;
  }
  toCurveSegmentsOnXY(z = 0, o: any = {}) { return this.segments(([a, b]) => [a, b, z], o); }
  toCurveSegmentsOnXZ(y = 0, o: any = {}) { return this.segments(([a, b]) => [a, y, b], o); }
  toCurveSegmentsOnYZ(x = 0, o: any = {}) { return this.segments(([a, b]) => [x, a, b], o); }
  toPathOnXY(z = 0, o: any = {}) { return this.toCurveOnXY(z, o); }
  toPathOnYZ(x = 0, o: any = {}) { return this.toCurveOnYZ(x, o); }
}
export class Placement2DParamValue {
  readonly kind = 'placement2dParam';
  constructor(private readonly list: any[]) {}
  items() { return this.list.map((it) => ({ id: it.id, label: it.label, x: it.x ?? it.at?.[0] ?? it.center?.[0] ?? 0, y: it.y ?? it.at?.[1] ?? it.center?.[1] ?? 0, angle: it.angle ?? 0, zone: it.zone, locked: !!it.locked, footprint: it.footprint })); }
  item(id: string) { const it = this.items().find((i) => i.id === id); if (!it) throw new ForgeError('PARAM.PLACEMENT_ITEM', `no placement item "${id}"`); return it; }
}

export { Curve };

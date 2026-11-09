// Shape: an immutable solid backed by a Manifold mesh, with colour, material, face labels and connectors.
import type { Manifold } from 'manifold-3d';
import { K } from './wasm';
import { mat4, Mat4, toVec3, v3, Vec3 } from './math';
import { ForgeError } from './errors';
import { featureEdges, toTriMesh, triArea, triCentroid, triNormal, TriMesh, vert } from './mesh';
import { DEFAULT_SEGMENTS, Sketch } from './sketch';
import { roundedSum } from './ops';

export interface FaceLabel {
  name: string;
  type: 'plane' | 'cylinder';
  normal: Vec3; // plane normal, or cylinder axis
  point: Vec3; // point on plane, or point on axis
  radius?: number;
}

export interface FaceRef {
  kind: 'face';
  name: string;
  normal: Vec3;
  center: Vec3;
  uAxis: Vec3;
  vAxis: Vec3;
  area: number;
  size: [number, number];
  planar: boolean;
  radius?: number;
  owner?: Shape;
}

export interface EdgeSegment { kind: 'edge'; start: Vec3; end: Vec3; length: number; convex: boolean; n1: Vec3; n2: Vec3 }

export interface Connector {
  name?: string;
  origin: Vec3;
  axis: Vec3;
  up: Vec3;
  kind?: string;
  [k: string]: any;
}

export interface ShapeMaterialProps {
  metalness?: number; roughness?: number; emissive?: string; emissiveIntensity?: number; opacity?: number;
  wireframe?: boolean; clearcoat?: number; clearcoatRoughness?: number; transmission?: number; ior?: number;
  thickness?: number; specularIntensity?: number; specularColor?: string; reflectivity?: number; [k: string]: any;
}

interface ShapeInit {
  faces?: FaceLabel[];
  color?: string;
  material?: ShapeMaterialProps;
  connectors?: Record<string, Connector>;
  name?: string;
  recipe?: any;
  meta?: Record<string, any>;
}

/** Every manifold created during a run, so the runtime can free WASM memory afterwards. */
export const allocations: { list: Manifold[] | null } = { list: null };

export class Shape {
  readonly m: Manifold;
  readonly faceLabels: FaceLabel[];
  readonly colorValue?: string;
  readonly materialProps?: ShapeMaterialProps;
  readonly connectors: Record<string, Connector>;
  readonly name?: string;
  readonly recipe?: any;
  readonly meta: Record<string, any>;
  readonly kind = 'shape';
  private _mesh?: TriMesh;

  constructor(m: Manifold, init: ShapeInit = {}) {
    this.m = m;
    allocations.list?.push(m);
    this.faceLabels = init.faces ?? [];
    this.colorValue = init.color;
    this.materialProps = init.material;
    this.connectors = init.connectors ?? {};
    this.name = init.name;
    this.recipe = init.recipe;
    this.meta = init.meta ?? {};
  }

  /** Copy with a new manifold; transform labels/connectors with `xf` when given. */
  derive(m: Manifold, xf?: Mat4, extra: Partial<ShapeInit> = {}): Shape {
    const faces = xf ? this.faceLabels.map((f) => xfFace(f, xf)) : this.faceLabels;
    const connectors: Record<string, Connector> = {};
    for (const [k, c] of Object.entries(this.connectors)) connectors[k] = xf ? xfConnector(c, xf) : c;
    return new Shape(m, {
      faces, color: this.colorValue, material: this.materialProps, connectors, name: this.name,
      recipe: xf ? (this.recipe ? { ...this.recipe, xf: mat4.mul(xf, this.recipe.xf ?? mat4.identity()) } : undefined) : undefined,
      meta: this.meta, ...extra,
    });
  }

  get mesh(): TriMesh {
    if (!this._mesh) this._mesh = toTriMesh(this.m);
    return this._mesh;
  }

  // ------------------------------------------------------------ appearance
  color(value?: string): Shape { return this.derive(this.m, undefined, { color: value, recipe: this.recipe }); }
  getColor() { return this.colorValue; }
  material(props: ShapeMaterialProps): Shape { return this.derive(this.m, undefined, { material: { ...(this.materialProps ?? {}), ...props }, recipe: this.recipe }); }
  named(name: string): Shape { return this.derive(this.m, undefined, { name, recipe: this.recipe }); }
  withMeta(meta: Record<string, any>): Shape { return this.derive(this.m, undefined, { meta: { ...this.meta, ...meta }, recipe: this.recipe }); }

  // ------------------------------------------------------------ transforms
  transform(m: Mat4 | { matrix: Mat4 } | any): Shape {
    const mm: Mat4 = Array.isArray(m) ? m : m?.matrix ?? m?.toMatrix?.() ?? mat4.identity();
    return this.derive(this.m.transform(mm as any), mm);
  }
  translate(x: number | Vec3 = 0, y = 0, z = 0): Shape {
    const [dx, dy, dz] = Array.isArray(x) ? x : [x, y, z];
    return this.transform(mat4.translation(dx, dy, dz));
  }
  translatePolar(radius: number, angleDeg: number, z = 0): Shape {
    const a = (angleDeg * Math.PI) / 180;
    return this.translate(radius * Math.cos(a), radius * Math.sin(a), z);
  }
  rotate(axisOrAngles: Vec3 | 'x' | 'y' | 'z', angleDeg?: number, opts: { pivot?: Vec3 } = {}): Shape {
    if (angleDeg === undefined && Array.isArray(axisOrAngles)) {
      // Euler XYZ degrees form: rotate([rx, ry, rz])
      const [rx, ry, rz] = axisOrAngles;
      return this.rotateX(rx).rotateY(ry).rotateZ(rz);
    }
    const axis: Vec3 = axisOrAngles === 'x' ? [1, 0, 0] : axisOrAngles === 'y' ? [0, 1, 0] : axisOrAngles === 'z' ? [0, 0, 1] : toVec3(axisOrAngles);
    const p = toVec3(opts.pivot ?? [0, 0, 0]);
    const m = mat4.mul(mat4.translation(p[0], p[1], p[2]), mat4.mul(mat4.axisAngle(axis, angleDeg ?? 0), mat4.translation(-p[0], -p[1], -p[2])));
    return this.transform(m);
  }
  rotateX(deg: number, o: { pivot?: Vec3 } = {}) { return this.rotate([1, 0, 0], deg, o); }
  rotateY(deg: number, o: { pivot?: Vec3 } = {}) { return this.rotate([0, 1, 0], deg, o); }
  rotateZ(deg: number, o: { pivot?: Vec3 } = {}) { return this.rotate([0, 0, 1], deg, o); }
  scale(v: number | Vec3): Shape { return this.scaleAround(this.center(), v); }
  scaleAround(pivot: Vec3, v: number | Vec3): Shape {
    const [sx, sy, sz] = typeof v === 'number' ? [v, v, v] : toVec3(v);
    const p = toVec3(pivot);
    return this.transform(mat4.mul(mat4.translation(p[0], p[1], p[2]), mat4.mul(mat4.scaling(sx, sy, sz), mat4.translation(-p[0], -p[1], -p[2]))));
  }
  mirror(normal: Vec3): Shape { return this.mirrorThrough(this.center(), normal); }
  mirrorThrough(point: Vec3, normal: Vec3): Shape {
    const n = v3.norm(toVec3(normal));
    const p = toVec3(point);
    const r = [
      1 - 2 * n[0] * n[0], -2 * n[0] * n[1], -2 * n[0] * n[2], 0,
      -2 * n[1] * n[0], 1 - 2 * n[1] * n[1], -2 * n[1] * n[2], 0,
      -2 * n[2] * n[0], -2 * n[2] * n[1], 1 - 2 * n[2] * n[2], 0,
      0, 0, 0, 1,
    ];
    return this.transform(mat4.mul(mat4.translation(p[0], p[1], p[2]), mat4.mul(r, mat4.translation(-p[0], -p[1], -p[2]))));
  }
  pointAlong(direction: Vec3): Shape { return this.transform(mat4.rotationBetween([0, 0, 1], toVec3(direction))); }
  placeOnFrame(frame: any, opts: { offset?: Vec3 } = {}): Shape {
    const m: Mat4 = Array.isArray(frame) ? frame : frameToMatrix(frame);
    const o = toVec3(opts.offset ?? [0, 0, 0]);
    return this.transform(mat4.mul(m, mat4.translation(o[0], o[1], o[2])));
  }

  // ------------------------------------------------------------ booleans
  add(...others: any[]): Shape { const o = flatShapes(others); return o.length ? this.derive(K().Manifold.union([this.m, ...o.map((s) => s.m)])) : this; }
  union(...others: any[]) { return this.add(...others); }
  subtract(...others: any[]): Shape { const o = flatShapes(others); return o.length ? this.derive(K().Manifold.difference([this.m, ...o.map((s) => s.m)])) : this; }
  intersect(...others: any[]): Shape { const o = flatShapes(others); return o.length ? this.derive(K().Manifold.intersection([this.m, ...o.map((s) => s.m)])) : this; }
  split(cutter: Shape): [Shape, Shape] { const [a, b] = this.m.split(cutter.m); return [this.derive(a), this.derive(b)]; }
  splitBy(cutter: Shape) { const [inside, outside] = this.split(cutter); return { inside, outside, pieces: [inside, outside].filter((s) => !s.isEmpty()) }; }
  splitByPlane(normal: Vec3, originOffset = 0): [Shape, Shape] { const [a, b] = this.m.splitByPlane(toVec3(normal), originOffset); return [this.derive(a), this.derive(b)]; }
  trimByPlane(normal: Vec3, originOffset = 0): Shape { return this.derive(this.m.trimByPlane(toVec3(normal), originOffset)); }
  hull(): Shape { return this.derive(this.m.hull()); }
  decompose(): Shape[] { return this.m.decompose().map((m) => this.derive(m)); }

  // ------------------------------------------------------------ measurement
  boundingBox() {
    const b = this.m.boundingBox();
    const min = [b.min[0], b.min[1], b.min[2]] as Vec3, max = [b.max[0], b.max[1], b.max[2]] as Vec3;
    return { min, max, size: v3.sub(max, min), center: v3.scale(v3.add(min, max), 0.5) };
  }
  bounds() { return this.boundingBox(); }
  center(): Vec3 { return this.boundingBox().center; }
  volume() { return this.m.volume(); }
  surfaceArea() { return this.m.surfaceArea(); }
  isEmpty() { return this.m.isEmpty(); }
  numTri() { return this.m.numTri(); }
  numVert() { return this.m.numVert(); }
  genus() { return this.m.genus(); }
  centroid(): Vec3 {
    // volume centroid via signed tetrahedra
    const me = this.mesh;
    let vol = 0; const c: Vec3 = [0, 0, 0];
    for (let t = 0; t < me.indices.length / 3; t++) {
      const a = vert(me, me.indices[t * 3]), b = vert(me, me.indices[t * 3 + 1]), d = vert(me, me.indices[t * 3 + 2]);
      const v = v3.dot(a, v3.cross(b, d)) / 6;
      vol += v;
      for (let k = 0; k < 3; k++) c[k] += (v * (a[k] + b[k] + d[k])) / 4;
    }
    return vol ? v3.scale(c, 1 / vol) : this.center();
  }
  minGap(other: Shape, searchLength = 100) { return this.m.minGap(other.m, searchLength); }

  // ------------------------------------------------------------ topology
  as(name: string): Shape {
    return this.derive(this.m, undefined, { faces: this.faceLabels.map((f) => ({ ...f, name: `${name}.${f.name}` })), recipe: this.recipe });
  }
  prefixLabels(p: string) { return this.derive(this.m, undefined, { faces: this.faceLabels.map((f) => ({ ...f, name: p + f.name })), recipe: this.recipe }); }
  renameLabel(from: string, to: string) { return this.derive(this.m, undefined, { faces: this.faceLabels.map((f) => (f.name === from ? { ...f, name: to } : f)), recipe: this.recipe }); }
  dropLabels(...names: string[]) { return this.derive(this.m, undefined, { faces: this.faceLabels.filter((f) => !names.includes(f.name)), recipe: this.recipe }); }
  labelFace(name: string, face: FaceRef | string): Shape {
    const f = typeof face === 'string' ? this.face(face) : face;
    return this.derive(this.m, undefined, { faces: [...this.faceLabels, { name, type: 'plane', normal: f.normal, point: f.center }], recipe: this.recipe });
  }
  faceNames(): string[] {
    const names = new Set(this.faceLabels.map((f) => f.name));
    for (const d of Object.keys(DIRS)) names.add(d);
    return [...names];
  }
  edgeNames(): string[] {
    const n = this.faceLabels.map((f) => f.name);
    const out: string[] = [];
    for (let i = 0; i < n.length; i++) for (let j = i + 1; j < n.length; j++) if (this.edgesBetween(n[i], n[j]).length) out.push(`${n[i]}|${n[j]}`);
    return out;
  }

  /** Resolve a face by label, direction name (top/bottom/front/back/left/right) or FaceRef. */
  face(selector: string | FaceRef): FaceRef {
    if (typeof selector !== 'string') return selector;
    const matches = this.faceLabels.filter((f) => f.name === selector || f.name.endsWith('.' + selector));
    if (matches.length > 1) {
      const exact = matches.filter((f) => f.name === selector);
      if (exact.length !== 1) throw new ForgeError('NameNotUnique', `face "${selector}" matches ${matches.length} faces`);
      return this.resolveLabel(exact[0]);
    }
    if (matches.length === 1) return this.resolveLabel(matches[0]);
    const dir = DIRS[selector];
    if (dir) return this.extremeFace(selector, dir);
    throw new ForgeError('NameNotFound', `no face named "${selector}". Known: ${this.faceNames().join(', ')}`);
  }
  faces(...selectors: any[]): FaceRef[] {
    if (!selectors.length) return this.faceNames().map((n) => { try { return this.face(n); } catch { return null; } }).filter(Boolean) as FaceRef[];
    return selectors.flat().map((s) => this.face(s));
  }
  faceBetween(a: string | FaceRef, b: string | FaceRef): FaceRef {
    const fa = this.face(a), fb = this.face(b);
    const n = v3.norm(v3.cross(fa.normal, fb.normal));
    const mid = v3.scale(v3.add(fa.center, fb.center), 0.5);
    const cand = this.planarFaceNear(n, mid) ?? this.planarFaceNear(v3.scale(n, -1), mid);
    if (!cand) throw new ForgeError('NameNotFound', 'no face between the given faces');
    return cand;
  }

  private resolveLabel(f: FaceLabel): FaceRef {
    if (f.type === 'cylinder') {
      const axis = v3.norm(f.normal);
      const u = v3.perp(axis);
      return { kind: 'face', name: f.name, normal: axis, center: f.point, uAxis: u, vAxis: v3.cross(axis, u), area: 0, size: [0, 0], planar: false, radius: f.radius, owner: this };
    }
    return this.planarFace(f.name, f.normal, f.point) ?? this.fallbackFace(f.name, f.normal, f.point);
  }

  private fallbackFace(name: string, n: Vec3, p: Vec3): FaceRef {
    const u = Math.abs(n[2]) > 0.9 ? [1, 0, 0] as Vec3 : v3.norm(v3.cross([0, 0, 1], n));
    return { kind: 'face', name, normal: n, center: p, uAxis: u, vAxis: v3.cross(n, u), area: 0, size: [0, 0], planar: true, owner: this };
  }

  /** Collect the coplanar triangles matching a plane and summarise them. */
  private planarFace(name: string, normal: Vec3, point: Vec3, tol = 1e-3): FaceRef | null {
    const me = this.mesh;
    const n = v3.norm(normal);
    const d = v3.dot(n, point);
    let area = 0; const c: Vec3 = [0, 0, 0];
    const tris: number[] = [];
    for (let t = 0; t < me.indices.length / 3; t++) {
      const tn = triNormal(me, t);
      if (v3.dot(tn, n) < 0.999) continue;
      const tc = triCentroid(me, t);
      if (Math.abs(v3.dot(tc, n) - d) > tol * Math.max(1, Math.abs(d))) continue;
      const a = triArea(me, t);
      area += a;
      c[0] += tc[0] * a; c[1] += tc[1] * a; c[2] += tc[2] * a;
      tris.push(t);
    }
    if (!area) return null;
    const center = v3.scale(c, 1 / area);
    const u: Vec3 = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : v3.norm(v3.cross([0, 0, 1], n));
    const v = v3.cross(n, u);
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (const t of tris) for (let k = 0; k < 3; k++) {
      const p = v3.sub(vert(me, me.indices[t * 3 + k]), center);
      const pu = v3.dot(p, u), pv = v3.dot(p, v);
      umin = Math.min(umin, pu); umax = Math.max(umax, pu); vmin = Math.min(vmin, pv); vmax = Math.max(vmax, pv);
    }
    // Centre the frame on the face's bounding rectangle rather than its area centroid.
    const cc = v3.add(center, v3.add(v3.scale(u, (umin + umax) / 2), v3.scale(v, (vmin + vmax) / 2)));
    return { kind: 'face', name, normal: n, center: cc, uAxis: u, vAxis: v, area, size: [umax - umin, vmax - vmin], planar: true, owner: this };
  }

  private planarFaceNear(normal: Vec3, near: Vec3): FaceRef | null {
    const me = this.mesh;
    let best: Vec3 | null = null, bd = Infinity;
    for (let t = 0; t < me.indices.length / 3; t++) {
      if (v3.dot(triNormal(me, t), normal) < 0.999) continue;
      const c = triCentroid(me, t);
      const dd = v3.dist(c, near);
      if (dd < bd) { bd = dd; best = c; }
    }
    return best ? this.planarFace('face', normal, best) : null;
  }

  private extremeFace(name: string, dir: Vec3): FaceRef {
    const me = this.mesh;
    let best = -Infinity, bp: Vec3 | null = null;
    for (let t = 0; t < me.indices.length / 3; t++) {
      if (v3.dot(triNormal(me, t), dir) < 0.999) continue;
      const c = triCentroid(me, t);
      const d = v3.dot(c, dir);
      if (d > best + 1e-6) { best = d; bp = c; }
    }
    if (!bp) {
      const bb = this.boundingBox();
      const p = v3.add(bb.center, [dir[0] * bb.size[0] / 2, dir[1] * bb.size[1] / 2, dir[2] * bb.size[2] / 2]);
      return this.fallbackFace(name, dir, p);
    }
    return this.planarFace(name, dir, bp)!;
  }

  private triInFace(t: number, f: FaceRef): boolean {
    const me = this.mesh;
    const tn = triNormal(me, t);
    const tc = triCentroid(me, t);
    if (f.planar) return v3.dot(tn, f.normal) > 0.999 && Math.abs(v3.dot(v3.sub(tc, f.center), f.normal)) < 1e-3 * Math.max(1, v3.len(f.center));
    // cylinder side: normal perpendicular to axis and at radius
    const rel = v3.sub(tc, f.center);
    const radial = v3.sub(rel, v3.scale(f.normal, v3.dot(rel, f.normal)));
    return Math.abs(v3.dot(tn, f.normal)) < 0.2 && (f.radius == null || Math.abs(v3.len(radial) - f.radius) < f.radius * 0.1);
  }

  edgesOf(selector: string | FaceRef, opts: { exclude?: any[]; convex?: boolean; concave?: boolean; minLength?: number } = {}): EdgeSegment[] {
    const f = this.face(selector);
    const excl = (opts.exclude ?? []).map((e) => this.face(e));
    return featureEdges(this.mesh).filter((e) => {
      const in1 = this.triInFace(e.t1, f), in2 = this.triInFace(e.t2, f);
      if (in1 === in2) return false;
      const other = in1 ? e.t2 : e.t1;
      if (excl.some((x) => this.triInFace(other, x))) return false;
      if (opts.convex && !e.convex) return false;
      if (opts.concave && e.convex) return false;
      if (opts.minLength && v3.dist(e.a, e.b) < opts.minLength) return false;
      return true;
    }).map(toSeg);
  }
  edgesBetween(a: string | FaceRef, b: string | FaceRef, _opts: { touching?: boolean } = {}): EdgeSegment[] {
    const fa = this.face(a), fb = this.face(b);
    return featureEdges(this.mesh).filter((e) => (this.triInFace(e.t1, fa) && this.triInFace(e.t2, fb)) || (this.triInFace(e.t1, fb) && this.triInFace(e.t2, fa))).map(toSeg);
  }
  edges(opts: { convex?: boolean; concave?: boolean; minAngle?: number } = {}): EdgeSegment[] {
    return featureEdges(this.mesh, opts.minAngle ?? 20).filter((e) => (opts.convex ? e.convex : opts.concave ? !e.convex : true)).map(toSeg);
  }

  // ------------------------------------------------------------ connectors
  withConnectors(conns: Record<string, any>): Shape {
    const out = { ...this.connectors };
    for (const [k, c] of Object.entries(conns)) out[k] = normConnector(c, k);
    return this.derive(this.m, undefined, { connectors: out, recipe: this.recipe });
  }
  connector(name: string): Connector {
    const c = this.connectors[name];
    if (!c) throw new ForgeError('CONNECTOR.NOT_FOUND', `no connector "${name}" (have: ${Object.keys(this.connectors).join(', ') || 'none'})`);
    return c;
  }
  getConnectors() { return this.connectors; }
  /** Move this shape so that its connector `mine` coincides with `target` (connector or point), axes opposed. */
  matchTo(mine: string, target: Connector | Vec3, opts: { flip?: boolean; offset?: number } = {}): Shape {
    const a = this.connector(mine);
    const tgt: Connector = Array.isArray(target) ? { origin: target, axis: [0, 0, 1], up: [1, 0, 0] } : normConnector(target);
    const m = mateTransform(a, tgt, opts.flip ?? true, opts.offset ?? 0);
    return this.transform(m);
  }
  attachTo(target: Shape, targetFace: string | FaceRef = 'top', selfFace: string | FaceRef = 'bottom', offset: Vec3 = [0, 0, 0]): Shape {
    const tf = target.face(targetFace), sf = this.face(selfFace);
    const rot = mat4.rotationBetween(sf.normal, v3.scale(tf.normal, -1));
    const rotated = this.transform(rot);
    const sc = mat4.apply(rot, sf.center);
    const o = toVec3(offset);
    return rotated.translate(tf.center[0] - sc[0] + o[0], tf.center[1] - sc[1] + o[1], tf.center[2] - sc[2] + o[2]);
  }
  placeReference(ref: string, target: Vec3, offset: Vec3 = [0, 0, 0]): Shape {
    const p = this.connectors[ref]?.origin ?? (this.meta.references?.[ref] as Vec3);
    if (!p) throw new ForgeError('REFERENCE.NOT_FOUND', `no reference "${ref}"`);
    const t = toVec3(target), o = toVec3(offset);
    return this.translate(t[0] - p[0] + o[0], t[1] - p[1] + o[1], t[2] - p[2] + o[2]);
  }
  withReferences(refs: { points?: Record<string, Vec3> }): Shape {
    return this.withMeta({ references: { ...(this.meta.references ?? {}), ...(refs.points ?? refs) } });
  }

  // ------------------------------------------------------------ features
  shell(thickness: number, opts: { openFaces?: (string | FaceRef)[] } = {}): Shape {
    let inner = offsetInward(this, thickness);
    for (const of of opts.openFaces ?? []) {
      const f = this.face(of);
      const step = v3.scale(f.normal, thickness * 1.01 + 1e-3);
      inner = inner.add(inner.translate(step[0], step[1], step[2]));
    }
    return this.derive(this.m.subtract(inner.m));
  }
  pocket(face: string | FaceRef, depth: number, opts: { inset?: number; scale?: number; join?: 'Square' | 'Round' | 'Miter' } = {}): Shape {
    const f = this.face(face);
    let prof = faceProfile(this, f);
    if (opts.inset) prof = prof.offset(-opts.inset, opts.join ?? 'Round');
    if (opts.scale && opts.scale !== 1) prof = prof.scaleAround([0, 0], opts.scale);
    const frame = mat4.fromFrame(f.uAxis, f.vAxis, f.normal, f.center);
    const cut = new Shape(prof.cs.extrude(depth + 0.01).translate([0, 0, -depth])).transform(frame);
    return this.derive(this.m.subtract(cut.m));
  }
  boss(face: string | FaceRef, height: number, opts: { inset?: number; sketch?: Sketch } = {}): Shape {
    const f = this.face(face);
    let prof = opts.sketch ?? faceProfile(this, f);
    if (opts.inset) prof = prof.offset(-opts.inset);
    const frame = mat4.fromFrame(f.uAxis, f.vAxis, f.normal, f.center);
    const add = new Shape(prof.cs.extrude(height + 0.01).translate([0, 0, -0.01])).transform(frame);
    return this.derive(this.m.add(add.m));
  }
  hole(faceOrRef: string | FaceRef, opts: any = {}): Shape {
    const f = this.face(faceOrRef);
    const pos = opts.position ? toVec3(opts.position) : v3.add(f.center, v3.add(v3.scale(f.uAxis, opts.u ?? 0), v3.scale(f.vAxis, opts.v ?? 0)));
    const dia = holeDiameter(opts);
    const bb = this.boundingBox();
    const through = v3.len(bb.size) * 2 + 2;
    let depth: number = opts.depth ?? through;
    if (opts.upToFace) {
      const uf = this.face(opts.upToFace);
      depth = Math.abs(v3.dot(v3.sub(pos, uf.center), f.normal));
    }
    const k = K();
    const seg = DEFAULT_SEGMENTS.value;
    const parts: Manifold[] = [k.Manifold.cylinder(depth + 0.01, dia / 2, dia / 2, seg).translate([0, 0, -depth])];
    if (opts.counterbore) {
      const cb = opts.counterbore;
      parts.push(k.Manifold.cylinder(cb.depth + 0.01, cb.diameter / 2, cb.diameter / 2, seg).translate([0, 0, -cb.depth]));
      parts.push(k.Manifold.cylinder(1, cb.diameter / 2, cb.diameter / 2, seg));
    }
    if (opts.countersink) {
      const cs = opts.countersink;
      const ang = ((cs.angleDeg ?? 90) * Math.PI) / 360;
      const h = (cs.diameter / 2 - dia / 2) / Math.tan(ang);
      parts.push(k.Manifold.cylinder(h, dia / 2, cs.diameter / 2, seg).translate([0, 0, -h]));
      parts.push(k.Manifold.cylinder(1, cs.diameter / 2, cs.diameter / 2, seg));
    }
    // a little clearance above the face so the cut is clean
    parts.push(k.Manifold.cylinder(0.5, dia / 2, dia / 2, seg));
    const frame = mat4.fromFrame(f.uAxis, f.vAxis, f.normal, pos);
    const cutter = k.Manifold.union(parts).transform(frame as any);
    allocations.list?.push(cutter);
    const out = this.derive(this.m.subtract(cutter));
    out.meta.holes = [...(this.meta.holes ?? []), { position: pos, axis: v3.scale(f.normal, -1), diameter: dia, depth, thread: opts.thread }];
    return out;
  }
  cutout(sketch: Sketch, opts: { depth?: number; upToFace?: any; extent?: any; taperScale?: number | [number, number] } = {}): Shape {
    if (!sketch.placement) throw new ForgeError('CUTOUT.NOT_PLACED', 'cutout needs a sketch placed with Sketch.onFace');
    const bb = this.boundingBox();
    let depth = opts.depth ?? opts.extent?.forward?.depth ?? v3.len(bb.size) * 2 + 2;
    if (opts.extent?.forward?.through) depth = v3.len(bb.size) * 2 + 2;
    if (opts.upToFace) {
      const uf = this.face(opts.upToFace);
      const o: Vec3 = [sketch.placement[12], sketch.placement[13], sketch.placement[14]];
      const n: Vec3 = [sketch.placement[8], sketch.placement[9], sketch.placement[10]];
      depth = Math.abs(v3.dot(v3.sub(o, uf.center), n));
    }
    const ts = opts.taperScale ?? 1;
    const st: [number, number] = typeof ts === 'number' ? [ts, ts] : ts;
    const m = sketch.cs.extrude(depth + 0.02, 0, 0, st).mirror([0, 0, 1]).translate([0, 0, 0.01]).transform(sketch.placement as any);
    allocations.list?.push(m);
    return this.derive(this.m.subtract(m));
  }
  thicken(t: number): Shape { return this.derive(this.m.add(offsetOutward(this, t).m)); }

  // ------------------------------------------------------------ freeform helpers
  smoothOut(minSharpAngle = 60, minSmoothness = 0) { return this.derive(this.m.smoothOut(minSharpAngle, minSmoothness).refine(3)); }
  refine(n: number) { return this.derive(this.m.refine(n)); }
  simplify(tol?: number) { return this.derive(this.m.simplify(tol)); }
  warp(fn: (v: number[]) => void) { return this.derive(this.m.warp(fn as any)); }
  slice(height = 0): Sketch { return new Sketch(this.m.slice(height)); }
  project(): Sketch { return new Sketch(this.m.project()); }

  toString() { const b = this.boundingBox(); return `Shape(${b.size.map((v) => v.toFixed(2)).join(' x ')})`; }
}

// ---------------------------------------------------------------- helpers

export const DIRS: Record<string, Vec3> = {
  top: [0, 0, 1], bottom: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1], '+y': [0, 1, 0], '-y': [0, -1, 0], '+x': [1, 0, 0], '-x': [-1, 0, 0],
};

function toSeg(e: { a: Vec3; b: Vec3; convex: boolean; n1: Vec3; n2: Vec3 }): EdgeSegment {
  return { kind: 'edge', start: e.a, end: e.b, length: v3.dist(e.a, e.b), convex: e.convex, n1: e.n1, n2: e.n2 };
}

export function xfFace(f: FaceLabel, m: Mat4): FaceLabel {
  const nm = mat4.invert(m);
  // normals transform by inverse transpose
  const n = f.normal;
  const nn: Vec3 = f.type === 'cylinder' ? v3.norm(mat4.applyDir(m, n)) : v3.norm([nm[0] * n[0] + nm[1] * n[1] + nm[2] * n[2], nm[4] * n[0] + nm[5] * n[1] + nm[6] * n[2], nm[8] * n[0] + nm[9] * n[1] + nm[10] * n[2]]);
  return { ...f, normal: nn, point: mat4.apply(m, f.point) };
}

export function xfConnector(c: Connector, m: Mat4): Connector {
  return { ...c, origin: mat4.apply(m, c.origin), axis: v3.norm(mat4.applyDir(m, c.axis)), up: v3.norm(mat4.applyDir(m, c.up)) };
}

export function normConnector(c: any, name?: string): Connector {
  if (!c) throw new ForgeError('CONNECTOR.INVALID', 'connector is undefined');
  const axis = v3.norm(toVec3(c.axis ?? [0, 0, 1]));
  let up = toVec3(c.up ?? v3.perp(axis));
  // make up orthogonal to axis
  up = v3.sub(up, v3.scale(axis, v3.dot(up, axis)));
  if (v3.len(up) < 1e-9) up = v3.perp(axis);
  return { ...c, name: c.name ?? name, origin: toVec3(c.origin ?? [0, 0, 0]), axis, up: v3.norm(up) };
}

/** Frame matrix of a connector: x = up, z = axis. */
export function connectorFrame(c: Connector): Mat4 {
  const z = v3.norm(c.axis), x = v3.norm(c.up), y = v3.cross(z, x);
  return mat4.fromFrame(x, y, z, c.origin);
}

/** Transform that moves connector `a` (in its body) onto connector `b`. */
export function mateTransform(a: Connector, b: Connector, flip: boolean, offset = 0): Mat4 {
  const fa = connectorFrame(a);
  let fb = connectorFrame(b);
  if (flip) fb = mat4.mul(fb, mat4.axisAngle([1, 0, 0], 180));
  if (offset) fb = mat4.mul(fb, mat4.translation(0, 0, -offset));
  return mat4.mul(fb, mat4.invert(fa));
}

function frameToMatrix(f: any): Mat4 {
  if (f.matrix) return f.matrix;
  const o = toVec3(f.origin ?? [0, 0, 0]);
  const z = v3.norm(toVec3(f.z ?? f.normal ?? f.axis ?? [0, 0, 1]));
  const x = f.x ? v3.norm(toVec3(f.x)) : v3.perp(z);
  return mat4.fromFrame(x, v3.cross(z, x), z, o);
}

export function flatShapes(items: any[]): Shape[] {
  const out: Shape[] = [];
  for (const it of items) {
    if (it == null) continue;
    if (Array.isArray(it)) out.push(...flatShapes(it));
    else if (it instanceof Shape) out.push(it);
    else if (it.toShape) out.push(it.toShape());
    else if (it.kind === 'group') out.push(...flatShapes(it.shapes()));
    else throw new ForgeError('BOOLEAN.BAD_OPERAND', `expected a Shape, got ${typeof it}`);
  }
  return out;
}

/** 2D outline of a planar face, expressed in the face's own (u, v) frame. */
export function faceProfile(shape: Shape, face: string | FaceRef): Sketch {
  const f = shape.face(face);
  const me = shape.mesh;
  const k = K();
  const tris: [number, number][][] = [];
  for (let t = 0; t < me.indices.length / 3; t++) {
    const tn = triNormal(me, t);
    if (v3.dot(tn, f.normal) < 0.999) continue;
    const tc = triCentroid(me, t);
    if (Math.abs(v3.dot(v3.sub(tc, f.center), f.normal)) > 1e-3 * Math.max(1, v3.len(f.center))) continue;
    const tri: [number, number][] = [];
    for (let i = 0; i < 3; i++) {
      const p = v3.sub(vert(me, me.indices[t * 3 + i]), f.center);
      tri.push([v3.dot(p, f.uAxis), v3.dot(p, f.vAxis)]);
    }
    tris.push(tri);
  }
  if (!tris.length) throw new ForgeError('FACE.NOT_PLANAR', `face "${f.name}" has no planar area`);
  // Slightly grow each triangle so shared edges weld, then shrink back.
  const cs = k.CrossSection.ofPolygons(tris as any, 'NonZero' as any).offset(1e-4, 'Miter' as any).offset(-1e-4, 'Miter' as any);
  return new Sketch(cs);
}

function offsetInward(s: Shape, t: number): Shape {
  const r = s.recipe;
  const k = K();
  if (r?.kind === 'box') {
    const [w, d, h] = r.size;
    const m = k.Manifold.cube([w - 2 * t, d - 2 * t, h - 2 * t], true).translate([0, 0, h / 2]).transform((r.xf ?? mat4.identity()) as any);
    return new Shape(m);
  }
  if (r?.kind === 'cylinder') {
    const m = k.Manifold.cylinder(r.h - 2 * t, Math.max(0.001, r.r - t), Math.max(0.001, r.rTop - t), r.seg).translate([0, 0, t]).transform((r.xf ?? mat4.identity()) as any);
    return new Shape(m);
  }
  if (r?.kind === 'extrude' && r.simple) {
    const sk: Sketch = r.sketch;
    const inner = sk.cs.offset(-t, 'Miter' as any, 2);
    const h = Math.abs(r.height);
    let m = inner.extrude(h - 2 * t).translate([0, 0, r.center ? -h / 2 + t : t]);
    if (r.height < 0) m = m.mirror([0, 0, 1]);
    if (sk.placement) m = m.transform(sk.placement as any);
    if (r.xf) m = m.transform(r.xf as any);
    return new Shape(m);
  }
  // General case: morphological erosion with a low-poly sphere.
  const ball = k.Manifold.sphere(t, 12);
  return new Shape(s.m.minkowskiDifference(ball));
}

function offsetOutward(s: Shape, t: number): Shape {
  return new Shape(roundedSum(s.m, t, 12));
}

// ISO metric thread data: [major diameter, pitch, tap drill, close, normal, loose clearance]
export const METRIC: Record<string, [number, number, number, number, number, number]> = {
  M2: [2, 0.4, 1.6, 2.2, 2.4, 2.6], M2_5: [2.5, 0.45, 2.05, 2.7, 2.9, 3.1], M3: [3, 0.5, 2.5, 3.2, 3.4, 3.6],
  M4: [4, 0.7, 3.3, 4.3, 4.5, 4.8], M5: [5, 0.8, 4.2, 5.3, 5.5, 5.8], M6: [6, 1, 5, 6.4, 6.6, 7],
  M8: [8, 1.25, 6.8, 8.4, 9, 10], M10: [10, 1.5, 8.5, 10.5, 11, 12], M12: [12, 1.75, 10.2, 13, 13.5, 14.5],
  M16: [16, 2, 14, 17, 17.5, 18.5], M20: [20, 2.5, 17.5, 21, 22, 24],
};
export function metric(designation: string) {
  const key = designation.toUpperCase().replace('.', '_').replace(/X.*$/, '');
  const row = METRIC[key];
  if (!row) throw new ForgeError('HOLE.UNKNOWN_SIZE', `unknown metric size "${designation}"`);
  return { diameter: row[0], pitch: row[1], tapDrill: row[2], close: row[3], normal: row[4], loose: row[5] };
}
function holeDiameter(o: any): number {
  if (o.diameter) return o.diameter;
  if (o.thread) return metric(typeof o.thread === 'string' ? o.thread : o.thread.designation).tapDrill;
  if (o.clearance) return metric(o.clearance)[(o.clearanceClass ?? 'normal') as 'close' | 'normal' | 'loose'];
  if (o.fit) return metric(o.fit).diameter;
  throw new ForgeError('HOLE.NO_SIZE', 'hole needs diameter, thread, clearance or fit');
}

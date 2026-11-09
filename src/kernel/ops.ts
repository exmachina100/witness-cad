// Global modelling operations: primitives, booleans, edge features, patterns and groups.
import type { Manifold } from 'manifold-3d';
import { K } from './wasm';
import { mat4, toVec3, v3, Vec3 } from './math';
import { allocations, EdgeSegment, flatShapes, Shape } from './shape';
import { DEFAULT_SEGMENTS, Sketch } from './sketch';
import { ForgeError } from './errors';
import { featureEdges } from './mesh';

// ---------------------------------------------------------------- primitives
export function box(w: number, d: number, h: number): Shape {
  if (!(w > 0 && d > 0 && h > 0)) throw new ForgeError('BOX.SIZE', `box dimensions must be positive (got ${w}, ${d}, ${h})`);
  const m = K().Manifold.cube([w, d, h], true).translate([0, 0, h / 2]);
  return new Shape(m, {
    faces: [
      { name: 'top', type: 'plane', normal: [0, 0, 1], point: [0, 0, h] },
      { name: 'bottom', type: 'plane', normal: [0, 0, -1], point: [0, 0, 0] },
      { name: 'front', type: 'plane', normal: [0, -1, 0], point: [0, -d / 2, h / 2] },
      { name: 'back', type: 'plane', normal: [0, 1, 0], point: [0, d / 2, h / 2] },
      { name: 'left', type: 'plane', normal: [-1, 0, 0], point: [-w / 2, 0, h / 2] },
      { name: 'right', type: 'plane', normal: [1, 0, 0], point: [w / 2, 0, h / 2] },
    ],
    recipe: { kind: 'box', size: [w, d, h] },
  });
}

export function roundedBox(w: number, d: number, h: number, r: number): Shape {
  r = Math.min(r, w / 2, d / 2, h / 2) * 0.999;
  if (r <= 0) return box(w, d, h);
  const k = K();
  const core = k.Manifold.cube([w - 2 * r, d - 2 * r, h - 2 * r], true);
  const m = core.minkowskiSum(k.Manifold.sphere(r, DEFAULT_SEGMENTS.value)).translate([0, 0, h / 2]);
  allocations.list?.push(core);
  return new Shape(m, { faces: box(w, d, h).faceLabels });
}

export function cylinder(height: number, radius: number, radiusTop?: number, segments?: number): Shape {
  const rt = radiusTop ?? radius;
  const seg = segments ?? DEFAULT_SEGMENTS.value;
  const m = K().Manifold.cylinder(height, radius, rt, seg);
  return new Shape(m, {
    faces: [
      { name: 'top', type: 'plane', normal: [0, 0, 1], point: [0, 0, height] },
      { name: 'bottom', type: 'plane', normal: [0, 0, -1], point: [0, 0, 0] },
      { name: 'side', type: 'cylinder', normal: [0, 0, 1], point: [0, 0, height / 2], radius: (radius + rt) / 2 },
    ],
    recipe: { kind: 'cylinder', h: height, r: radius, rTop: rt, seg },
  });
}

export function cone(height: number, radius: number, radiusTop = 0, segments?: number) { return cylinder(height, radius, radiusTop, segments); }

export function sphere(radius: number, segments?: number): Shape {
  return new Shape(K().Manifold.sphere(radius, segments ?? DEFAULT_SEGMENTS.value), { recipe: { kind: 'sphere', r: radius } });
}

export function torus(major: number, minor: number, segments?: number): Shape {
  const k = K();
  const seg = segments ?? DEFAULT_SEGMENTS.value;
  const cs = k.CrossSection.circle(minor, Math.max(12, Math.round(seg / 2))).translate([major, 0]);
  return new Shape(k.Manifold.revolve(cs, seg));
}

export function wedge(w: number, d: number, h: number): Shape {
  const k = K();
  const cs = k.CrossSection.ofPolygons([[[-d / 2, 0], [d / 2, 0], [-d / 2, h]]] as any);
  return new Shape(cs.extrude(w).translate([0, 0, -w / 2]).rotate([90, 0, 90]));
}

export function polyhedron(vertices: Vec3[], faces: number[][]): Shape {
  const tris: number[] = [];
  for (const f of faces) for (let i = 1; i + 1 < f.length; i++) tris.push(f[0], f[i], f[i + 1]);
  const k = K();
  const mesh = new k.Mesh({ numProp: 3, vertProperties: new Float32Array(vertices.flat()), triVerts: new Uint32Array(tris) });
  mesh.merge();
  return new Shape(new k.Manifold(mesh));
}

export function hull(...items: any[]): Shape {
  const pts: any[] = [];
  for (const it of items.flat()) pts.push(it instanceof Shape ? it.m : toVec3(it));
  return new Shape(K().Manifold.hull(pts));
}

export function hullPoints(points: Vec3[]): Shape { return new Shape(K().Manifold.hull(points.map((p) => toVec3(p)) as any)); }

// ---------------------------------------------------------------- booleans
export function union(...inputs: any[]): Shape {
  const s = flatShapes(inputs);
  if (!s.length) throw new ForgeError('UNION.EMPTY', 'union needs at least one shape');
  return s[0].add(...s.slice(1));
}
export function difference(...inputs: any[]): Shape {
  const s = flatShapes(inputs);
  if (!s.length) throw new ForgeError('DIFFERENCE.EMPTY', 'difference needs at least one shape');
  return s[0].subtract(...s.slice(1));
}
export function intersection(...inputs: any[]): Shape {
  const s = flatShapes(inputs);
  if (s.length < 2) throw new ForgeError('INTERSECTION.ARITY', 'intersection needs at least two shapes');
  return s[0].intersect(...s.slice(1));
}

// ---------------------------------------------------------------- edge features
function resolveEdges(shape: Shape, edges: any): EdgeSegment[] {
  if (edges == null) return shape.edges({});
  if (typeof edges === 'string') {
    if (edges === 'all') return shape.edges({});
    if (edges === 'convex') return shape.edges({ convex: true });
    if (edges === 'concave') return shape.edges({ concave: true });
    if (edges.includes('|')) { const [a, b] = edges.split('|'); return shape.edgesBetween(a, b); }
    return shape.edgesOf(edges);
  }
  if (Array.isArray(edges)) return edges.flatMap((e) => (e?.kind === 'edge' ? [e] : resolveEdges(shape, e)));
  if (edges.kind === 'edge') return [edges];
  if (edges.kind === 'face' || edges.name) return shape.edgesOf(edges);
  throw new ForgeError('FILLET.BAD_EDGES', 'unrecognised edge selector');
}

/** Builds the material to remove (convex edge) or add (concave edge) for one straight edge. */
function edgeTool(e: EdgeSegment, r: number, mode: 'fillet' | 'chamfer', seg: number): { cut?: Manifold; fill?: Manifold } | null {
  const k = K();
  const dir = v3.norm(v3.sub(e.end, e.start));
  const len = e.length;
  if (len < 1e-6) return null;
  const n1 = e.n1, n2 = e.n2;
  const cosT = v3.dot(n1, n2);
  if (cosT > 0.9999) return null;
  // Tangent directions within each face, pointing away from the edge.
  const sgn = e.convex ? 1 : -1;
  const u1 = v3.norm(v3.sub(v3.scale(n2, -sgn), v3.scale(n1, v3.dot(v3.scale(n2, -sgn), n1))));
  const u2 = v3.norm(v3.sub(v3.scale(n1, -sgn), v3.scale(n2, v3.dot(v3.scale(n1, -sgn), n2))));
  // Local frame: x along u1-ish, z along edge.
  const ext = Math.min(r * 0.05, len * 0.01) + 1e-3;
  const z = dir;
  const x = v3.norm(v3.sub(u1, v3.scale(z, v3.dot(u1, z))));
  const y = v3.cross(z, x);
  const frame = mat4.fromFrame(x, y, z, v3.sub(e.start, v3.scale(z, ext)));
  const to2 = (p: Vec3): [number, number] => [v3.dot(p, x), v3.dot(p, y)];
  // interior half-angle
  const theta = Math.acos(Math.max(-1, Math.min(1, -cosT))); // angle between faces measured inside material
  const half = theta / 2;
  let poly: [number, number][];
  let tool: Manifold;
  const L = mode === 'fillet' ? r / Math.tan(half) : r;
  const p1 = to2(v3.scale(u1, L)), p2 = to2(v3.scale(u2, L));
  // wedge region between the edge and the two tangent points (pushed slightly outside the solid)
  const pad = 1e-3 * Math.max(1, r);
  const outward = to2(v3.norm(v3.add(n1, n2)));
  const o: [number, number] = [outward[0] * pad * sgn, outward[1] * pad * sgn];
  poly = [[o[0], o[1]], [p1[0] + o[0], p1[1] + o[1]], [p2[0] + o[0], p2[1] + o[1]]];
  // ensure CCW
  const area = (poly[1][0] - poly[0][0]) * (poly[2][1] - poly[0][1]) - (poly[2][0] - poly[0][0]) * (poly[1][1] - poly[0][1]);
  if (area < 0) poly = [poly[0], poly[2], poly[1]];
  let cs = k.CrossSection.ofPolygons([poly] as any);
  if (mode === 'fillet') {
    const bis = v3.norm(v3.add(u1, u2));
    const cd = r / Math.sin(half);
    const c = to2(v3.scale(bis, cd));
    cs = cs.subtract(k.CrossSection.circle(r, seg).translate(c));
  }
  tool = cs.extrude(len + 2 * ext).transform(frame as any);
  allocations.list?.push(tool);
  return e.convex ? { cut: tool } : { fill: tool };
}

function applyEdgeTools(shape: Shape, size: number, edges: any, mode: 'fillet' | 'chamfer', options: any): Shape {
  if (!(size > 0)) return shape;
  const segs = resolveEdges(shape, edges);
  if (!segs.length) return shape;
  const seg = typeof options === 'object' && options?.segments ? options.segments : Math.max(16, DEFAULT_SEGMENTS.value / 2);
  const cuts: Manifold[] = [], fills: Manifold[] = [];
  for (const e of segs) {
    const t = edgeTool(e, size, mode, seg);
    if (t?.cut) cuts.push(t.cut);
    if (t?.fill) fills.push(t.fill);
  }
  const k = K();
  let m = shape.m;
  if (cuts.length) m = m.subtract(k.Manifold.union(cuts));
  if (fills.length) m = m.add(k.Manifold.union(fills));
  return shape.derive(m);
}

export function fillet(shape: Shape, radius: number, edges?: any, options?: any): Shape {
  if (typeof options === 'number') options = { segments: options };
  // Whole-solid rounding of convex shapes: Minkowski of an eroded core gives true spherical corners.
  if (edges == null && isConvex(shape)) {
    const k = K();
    const ball = k.Manifold.sphere(radius, options?.segments ?? Math.max(16, DEFAULT_SEGMENTS.value / 2));
    const core = shape.m.minkowskiDifference(ball);
    if (!core.isEmpty()) return shape.derive(core.minkowskiSum(ball));
  }
  return applyEdgeTools(shape, radius, edges, 'fillet', options);
}
export function chamfer(shape: Shape, size: number, edges?: any, options?: any): Shape {
  return applyEdgeTools(shape, size, edges, 'chamfer', options);
}

function isConvex(s: Shape): boolean {
  const hv = s.m.hull().volume();
  return hv > 0 && Math.abs(hv - s.volume()) / hv < 1e-4;
}

export function draft(shape: Shape, angleDeg: number, pull: Vec3 = [0, 0, 1], neutral = 0): Shape {
  const n = v3.norm(toVec3(pull));
  const t = Math.tan((angleDeg * Math.PI) / 180);
  const c = shape.center();
  return shape.derive(shape.m.warp((v: any) => {
    const h = v[0] * n[0] + v[1] * n[1] + v[2] * n[2] - neutral;
    const p: Vec3 = [v[0] - c[0], v[1] - c[1], v[2] - c[2]];
    const radial = v3.sub(p, v3.scale(n, v3.dot(p, n)));
    const rl = v3.len(radial);
    if (rl < 1e-9) return;
    const shrink = Math.max(0, rl - h * t) / rl;
    const np = v3.add(v3.scale(radial, shrink - 1), [v[0], v[1], v[2]]);
    v[0] = np[0]; v[1] = np[1]; v[2] = np[2];
  }));
}

export function offsetSolid(shape: Shape, thickness: number): Shape {
  const ball = K().Manifold.sphere(Math.abs(thickness), 16);
  return shape.derive(thickness >= 0 ? shape.m.minkowskiSum(ball) : shape.m.minkowskiDifference(ball));
}

// ---------------------------------------------------------------- patterns
export function linearPattern(shape: Shape, count: number, dx: number, dy = 0, dz = 0): Shape {
  const parts: Shape[] = [];
  for (let i = 0; i < count; i++) parts.push(shape.translate(dx * i, dy * i, dz * i));
  return union(parts);
}
export function circularPattern(shape: Shape, count: number, cx: any = 0, cy = 0): Shape {
  const o = typeof cx === 'object' && cx !== null ? cx : { centerX: cx, centerY: cy };
  const axis = toVec3(o.axis ?? [0, 0, 1]);
  const origin = o.origin ? toVec3(o.origin) : ([o.centerX ?? 0, o.centerY ?? 0, 0] as Vec3);
  const parts: Shape[] = [];
  const total = o.angle ?? 360;
  const step = total >= 360 ? 360 / count : total / Math.max(1, count - 1);
  for (let i = 0; i < count; i++) parts.push(shape.rotate(axis, (o.startDeg ?? 0) + step * i, { pivot: origin }));
  return union(parts);
}
export function mirrorCopy(shape: Shape, normal: Vec3): Shape {
  return union(shape, shape.mirrorThrough([0, 0, 0], normal));
}
export function circularLayout(count: number, radius: number, o: { startDeg?: number; centerX?: number; centerY?: number } = {}) {
  const out: any[] = [];
  for (let i = 0; i < count; i++) {
    const a = (((o.startDeg ?? 0) + (360 * i) / count) * Math.PI) / 180;
    out.push({ x: (o.centerX ?? 0) + radius * Math.cos(a), y: (o.centerY ?? 0) + radius * Math.sin(a), angle: (o.startDeg ?? 0) + (360 * i) / count });
  }
  return out;
}
export function polygonVertices(sides: number, radius: number, o: { startDeg?: number; centerX?: number; centerY?: number } = {}) {
  return circularLayout(sides, radius, { startDeg: o.startDeg ?? 90, centerX: o.centerX, centerY: o.centerY });
}

// ---------------------------------------------------------------- groups
export interface GroupChild { name: string; item: Shape | Sketch | ShapeGroup; tags?: string[] }

export class ShapeGroup {
  readonly kind = 'group';
  readonly children: GroupChild[];
  constructor(children: GroupChild[]) { this.children = children; }
  private map(fn: (s: any) => any): ShapeGroup { return new ShapeGroup(this.children.map((c) => ({ ...c, item: fn(c.item) }))); }
  translate(x: any, y = 0, z = 0) { return this.map((s) => s.translate(x, y, z)); }
  rotate(a: any, d?: number, o?: any) { return this.map((s) => (s instanceof Sketch ? s.rotate(d ?? a) : s.rotate(a, d, o))); }
  rotateX(d: number, o?: any) { return this.map((s) => s.rotateX(d, o)); }
  rotateY(d: number, o?: any) { return this.map((s) => s.rotateY(d, o)); }
  rotateZ(d: number, o?: any) { return this.map((s) => s.rotateZ(d, o)); }
  transform(m: any) { return this.map((s) => s.transform(m)); }
  mirrorThrough(p: Vec3, n: Vec3) { return this.map((s) => s.mirrorThrough(p, n)); }
  color(c: string) { return this.map((s) => s.color(c)); }
  child(name: string) { const c = this.children.find((x) => x.name === name); if (!c) throw new ForgeError('GROUP.NO_CHILD', `no child "${name}"`); return c.item; }
  names() { return this.children.map((c) => c.name); }
  shapes(): Shape[] { return this.children.flatMap((c) => (c.item instanceof Shape ? [c.item] : c.item instanceof ShapeGroup ? c.item.shapes() : [])); }
  toShape(): Shape { return union(this.shapes()); }
  boundingBox() { return this.toShape().boundingBox(); }
}

export function group(...items: any[]): ShapeGroup {
  const children: GroupChild[] = [];
  let i = 0;
  for (const it of items.flat()) {
    i++;
    if (it instanceof Shape || it instanceof Sketch || it instanceof ShapeGroup) children.push({ name: (it as any).name ?? `item ${i}`, item: it });
    else if (it && typeof it === 'object' && (it.shape || it.sketch || it.group)) children.push({ name: it.name ?? `item ${i}`, item: it.shape ?? it.sketch ?? it.group, tags: it.tags });
    else if (it != null) throw new ForgeError('GROUP.BAD_ITEM', 'group items must be shapes, sketches, groups or {name, shape}');
  }
  return new ShapeGroup(children);
}

// ---------------------------------------------------------------- sections
export function intersectWithPlane(shape: Shape, plane: any): Sketch {
  const { normal, offset } = planeOf(plane);
  const m = shape.m.transform(mat4.rotationBetween(normal, [0, 0, 1]) as any);
  return new Sketch(m.slice(offset));
}
export function projectToPlane(shape: Shape, plane: any): Sketch {
  const { normal } = planeOf(plane);
  return new Sketch(shape.m.transform(mat4.rotationBetween(normal, [0, 0, 1]) as any).project());
}
function planeOf(p: any): { normal: Vec3; offset: number } {
  if (typeof p === 'string') {
    const map: Record<string, Vec3> = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
    return { normal: map[p.toUpperCase()] ?? [0, 0, 1], offset: 0 };
  }
  if (p?.kind === 'face') return { normal: p.normal, offset: v3.dot(p.normal, p.center) };
  return { normal: v3.norm(toVec3(p?.normal ?? [0, 0, 1])), offset: p?.offset ?? 0 };
}

/** Edge features analysis used by checks. */
export function sharpEdgeCount(shape: Shape) { return featureEdges(shape.mesh).length; }

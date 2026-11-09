// 2D sketches: a thin immutable wrapper around Manifold's CrossSection.
import type { CrossSection } from 'manifold-3d';
import { K } from './wasm';
import { mat4, Mat4, toVec2, v3, Vec2, Vec3 } from './math';
import { Shape } from './shape';
import { ForgeError } from './errors';

export interface EdgeLabel { name: string; a: Vec2; b: Vec2 }
export type Anchor = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'top' | 'bottom' | 'left' | 'right';

export const DEFAULT_SEGMENTS = { value: 48 };

export class Sketch {
  readonly cs: CrossSection;
  readonly labels: EdgeLabel[];
  /** Placement frame (sketch XY -> world) when the sketch was put on a face or plane. */
  readonly placement?: Mat4;
  color_?: string;
  name?: string;
  readonly kind = 'sketch';

  constructor(cs: CrossSection, labels: EdgeLabel[] = [], placement?: Mat4) {
    this.cs = cs;
    this.labels = labels;
    this.placement = placement;
  }

  private with(cs: CrossSection, labels = this.labels, placement = this.placement): Sketch {
    const s = new Sketch(cs, labels, placement);
    s.color_ = this.color_;
    s.name = this.name;
    return s;
  }

  private mapLabels(fn: (p: Vec2) => Vec2): EdgeLabel[] {
    return this.labels.map((l) => ({ name: l.name, a: fn(l.a), b: fn(l.b) }));
  }

  clone() { return this.with(this.cs); }
  color(c?: string) { const s = this.with(this.cs); s.color_ = c; return s; }

  // ---- transforms
  translate(x: number | Vec2, y = 0): Sketch {
    const [dx, dy] = Array.isArray(x) ? x : [x, y];
    return this.with(this.cs.translate([dx, dy]), this.mapLabels((p) => [p[0] + dx, p[1] + dy]));
  }
  center(): Vec2 {
    const b = this.cs.bounds();
    return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
  }
  rotate(deg: number): Sketch { return this.rotateAround(deg, this.center()); }
  rotateAround(deg: number, pivot: Vec2 | { x: number; y: number }): Sketch {
    const [px, py] = toVec2(pivot);
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const f = (p: Vec2): Vec2 => [px + (p[0] - px) * c - (p[1] - py) * s, py + (p[0] - px) * s + (p[1] - py) * c];
    return this.with(this.cs.translate([-px, -py]).rotate(deg).translate([px, py]), this.mapLabels(f));
  }
  scale(v: number | Vec2): Sketch { return this.scaleAround(this.center(), v); }
  scaleAround(pivot: Vec2, v: number | Vec2): Sketch {
    const [px, py] = toVec2(pivot);
    const [sx, sy] = typeof v === 'number' ? [v, v] : v;
    const f = (p: Vec2): Vec2 => [px + (p[0] - px) * sx, py + (p[1] - py) * sy];
    return this.with(this.cs.translate([-px, -py]).scale([sx, sy]).translate([px, py]), this.mapLabels(f));
  }
  mirror(normal: Vec2): Sketch { return this.mirrorThrough(this.center(), normal); }
  mirrorThrough(point: Vec2, normal: Vec2): Sketch {
    const [px, py] = toVec2(point);
    const n = toVec2(normal);
    const l = Math.hypot(n[0], n[1]) || 1;
    const nx = n[0] / l, ny = n[1] / l;
    const f = (p: Vec2): Vec2 => {
      const d = (p[0] - px) * nx + (p[1] - py) * ny;
      return [p[0] - 2 * d * nx, p[1] - 2 * d * ny];
    };
    return this.with(this.cs.translate([-px, -py]).mirror([nx, ny]).translate([px, py]), this.mapLabels(f));
  }

  // ---- booleans
  add(...others: any[]): Sketch { return this.with(K().CrossSection.union([this.cs, ...flat2(others).map((o) => o.cs)]), [...this.labels, ...flat2(others).flatMap((o) => o.labels)]); }
  subtract(...others: any[]): Sketch { return this.with(K().CrossSection.difference([this.cs, ...flat2(others).map((o) => o.cs)])); }
  intersect(...others: any[]): Sketch { return this.with(K().CrossSection.intersection([this.cs, ...flat2(others).map((o) => o.cs)])); }
  union(...others: any[]) { return this.add(...others); }
  hull(): Sketch { return this.with(this.cs.hull()); }

  // ---- features
  offset(delta: number, join: 'Round' | 'Square' | 'Miter' = 'Round'): Sketch {
    return this.with(this.cs.offset(delta, join as any, 2, DEFAULT_SEGMENTS.value));
  }
  filletCorners(radius: number): Sketch {
    // Rounds convex corners (opening) then concave corners (closing).
    const opened = this.cs.offset(-radius, 'Round' as any, 2, DEFAULT_SEGMENTS.value).offset(radius, 'Round' as any, 2, DEFAULT_SEGMENTS.value);
    return this.with(opened.offset(radius, 'Round' as any, 2, DEFAULT_SEGMENTS.value).offset(-radius, 'Round' as any, 2, DEFAULT_SEGMENTS.value));
  }
  filletCorner(at: Vec2, radius: number): Sketch {
    const rounded = this.filletCorners(radius);
    const [x, y] = toVec2(at);
    const win = K().CrossSection.square([radius * 3, radius * 3], true).translate([x, y]);
    return this.with(K().CrossSection.union([this.cs.subtract(win), rounded.cs.intersect(win)]));
  }
  chamferCorners(size: number): Sketch {
    const s = this.cs.offset(-size, 'Miter' as any, 2).offset(size, 'Square' as any, 2);
    return this.with(s);
  }
  chamferCorner(at: Vec2, size: number): Sketch {
    const [x, y] = toVec2(at);
    const win = K().CrossSection.square([size * 3, size * 3], true).translate([x, y]);
    const ch = this.chamferCorners(size);
    return this.with(K().CrossSection.union([this.cs.subtract(win), ch.cs.intersect(win)]));
  }
  regions(): Sketch[] {
    return this.cs.decompose().map((c) => this.with(c, [])).sort((a, b) => b.area() - a.area());
  }
  region(seed: Vec2): Sketch {
    const [x, y] = toVec2(seed);
    const probe = K().CrossSection.square([1e-3, 1e-3], true).translate([x, y]);
    const r = this.regions().find((s) => !s.cs.intersect(probe).isEmpty());
    if (!r) throw new ForgeError('SKETCH.NO_REGION', `no region contains (${x}, ${y})`);
    return r;
  }

  // ---- measurement
  area() { return this.cs.area(); }
  bounds() {
    const b = this.cs.bounds();
    return { minX: b.min[0], minY: b.min[1], maxX: b.max[0], maxY: b.max[1], width: b.max[0] - b.min[0], height: b.max[1] - b.min[1] };
  }
  isEmpty() { return this.cs.isEmpty(); }
  numVert() { return this.cs.numVert(); }
  toPolygons(): number[][][] { return this.cs.toPolygons().map((p) => p.map((v) => [v[0], v[1]])); }

  // ---- labels
  labelEdge(name: string): Sketch { return this.labelEdges(name); }
  labelEdges(...names: any[]): Sketch {
    const polys = this.cs.toPolygons();
    let outer = (polys[0] ?? []) as any[];
    // Start at the bottom-left vertex so rect() edges come out bottom, right, top, left.
    if (outer.length) {
      let bi = 0;
      outer.forEach((p, i) => { const b = outer[bi]; if (p[1] < b[1] - 1e-9 || (Math.abs(p[1] - b[1]) < 1e-9 && p[0] < b[0])) bi = i; });
      outer = [...outer.slice(bi), ...outer.slice(0, bi)];
    }
    if (names.length === 1 && names[0] && typeof names[0] === 'object' && !Array.isArray(names[0])) {
      // {bottom: 'floor', ...} — label rectangle-like sides by direction
      const dirMap = names[0] as Record<string, string>;
      const out: EdgeLabel[] = [...this.labels];
      for (let i = 0; i < outer.length; i++) {
        const a = outer[i] as Vec2, b = outer[(i + 1) % outer.length] as Vec2;
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'bottom' : 'top') : dy > 0 ? 'right' : 'left';
        if (dirMap[side]) out.push({ name: dirMap[side], a: [a[0], a[1]], b: [b[0], b[1]] });
      }
      return this.with(this.cs, out);
    }
    const out: EdgeLabel[] = [...this.labels];
    for (let i = 0; i < outer.length && i < names.length; i++) {
      if (!names[i]) continue;
      const a = outer[i], b = outer[(i + 1) % outer.length];
      out.push({ name: names[i], a: [a[0], a[1]], b: [b[0], b[1]] });
    }
    return this.with(this.cs, out);
  }
  edgeLabels() { return this.labels.map((l) => l.name); }
  prefixLabels(p: string) { return this.with(this.cs, this.labels.map((l) => ({ ...l, name: p + l.name }))); }
  renameLabel(from: string, to: string) { return this.with(this.cs, this.labels.map((l) => (l.name === from ? { ...l, name: to } : l))); }
  dropLabels(...names: string[]) { return this.with(this.cs, this.labels.filter((l) => !names.includes(l.name))); }

  // ---- placement
  attachTo(target: Sketch, targetAnchor: Anchor = 'center', selfAnchor: Anchor = 'center', offset: Vec2 = [0, 0]): Sketch {
    const ta = anchorPoint(target, targetAnchor), sa = anchorPoint(this, selfAnchor);
    const o = toVec2(offset);
    return this.translate(ta[0] - sa[0] + o[0], ta[1] - sa[1] + o[1]);
  }

  onFace(parentOrFace: any, faceOrOpts?: any, opts: any = {}): Sketch {
    let face: any;
    if (parentOrFace instanceof Shape) {
      face = typeof faceOrOpts === 'string' ? parentOrFace.face(faceOrOpts) : faceOrOpts;
    } else {
      face = parentOrFace;
      opts = faceOrOpts ?? {};
    }
    if (!face || !face.normal) throw new ForgeError('SKETCH.BAD_FACE', 'onFace needs a face reference');
    const u = Number(opts.u ?? 0), v = Number(opts.v ?? 0), protrude = Number(opts.protrude ?? 0);
    const n = face.normal as Vec3, ua = face.uAxis as Vec3, va = face.vAxis as Vec3;
    const o = v3.add(v3.add(v3.add(face.center, v3.scale(ua, u)), v3.scale(va, v)), v3.scale(n, protrude));
    let s: Sketch = this;
    if (opts.selfAnchor && opts.selfAnchor !== 'center') {
      const p = anchorPoint(this, opts.selfAnchor);
      s = this.translate(-p[0], -p[1]);
    }
    return new Sketch(s.cs, s.labels, mat4.fromFrame(ua, va, n, o));
  }
  onPlane(origin: Vec3, normal: Vec3 = [0, 0, 1], xAxis?: Vec3): Sketch {
    const n = v3.norm(normal);
    const x = xAxis ? v3.norm(xAxis) : v3.perp(n);
    const y = v3.cross(n, x);
    return new Sketch(this.cs, this.labels, mat4.fromFrame(x, y, n, origin));
  }

  // ---- promotion to 3D
  extrude(extent: any = 1, opts: any = {}): Shape {
    let height: number;
    if (typeof extent === 'number') height = extent;
    else if (extent && typeof extent === 'object') {
      if (typeof extent.offset === 'number' && extent.upToPlane == null && extent.upToFace == null) height = extent.offset;
      else if (extent.upToPlane) {
        const p = extent.upToPlane;
        height = (p.offset ?? 0) + (extent.offset ?? 0);
        if (p.normal) height = (p.offset ?? 0) / (toVec3n(p.normal)[2] || 1);
      } else if (extent.upToFace) {
        const f = extent.upToFace;
        const local = this.placement ? mat4.apply(mat4.invert(this.placement), f.center) : f.center;
        height = local[2] + (extent.offset ?? 0);
      } else if (extent.height != null) height = extent.height;
      else height = 1;
      opts = { ...extent, ...opts };
    } else height = Number(extent);
    const twist = Number(opts.twist ?? 0);
    const sc = opts.scale ?? opts.taper ?? 1;
    const scaleTop: Vec2 = typeof sc === 'number' ? [sc, sc] : toVec2(sc);
    const divisions = twist ? Math.max(8, Math.ceil(Math.abs(twist) / 5)) : 0;
    const sign = height < 0 ? -1 : 1;
    let m = this.cs.extrude(Math.abs(height), divisions, twist, scaleTop, !!opts.center);
    if (sign < 0) m = m.mirror([0, 0, 1]);
    const zBot = opts.center ? -Math.abs(height) / 2 : 0;
    const zTop = opts.center ? Math.abs(height) / 2 : height;
    const labels = opts.labels ?? {};
    const faces = [
      { name: labels.start ?? opts.startLabel ?? 'bottom', type: 'plane' as const, normal: [0, 0, sign < 0 ? 1 : -1] as Vec3, point: [0, 0, sign < 0 ? 0 : zBot] as Vec3 },
      { name: labels.end ?? opts.endLabel ?? 'top', type: 'plane' as const, normal: [0, 0, sign] as Vec3, point: [0, 0, zTop] as Vec3 },
    ];
    if (!twist && scaleTop[0] === 1 && scaleTop[1] === 1) {
      for (const l of this.labels) {
        const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1];
        const len = Math.hypot(dx, dy) || 1;
        // CCW outer contour: outward normal is (dy, -dx)
        faces.push({ name: l.name, type: 'plane', normal: [dy / len, -dx / len, 0], point: [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2, (zBot + zTop) / 2] });
      }
    }
    let shape = new Shape(m, { faces, recipe: { kind: 'extrude', sketch: this, height, center: !!opts.center, simple: !twist && scaleTop[0] === 1 && scaleTop[1] === 1 } });
    if (this.color_) shape = shape.color(this.color_);
    if (this.placement) shape = shape.transform(this.placement);
    return shape;
  }
  revolve(degrees = 360, segments?: number): Shape {
    const k = K();
    let cs = this.cs;
    let m;
    if (degrees < 0) {
      m = k.Manifold.revolve(cs, segments ?? DEFAULT_SEGMENTS.value, -degrees).mirror([0, 1, 0]);
    } else {
      m = k.Manifold.revolve(cs, segments ?? DEFAULT_SEGMENTS.value, degrees);
    }
    let shape = new Shape(m, { faces: [] });
    if (this.color_) shape = shape.color(this.color_);
    if (this.placement) shape = shape.transform(this.placement);
    return shape;
  }
}

function toVec3n(v: any): Vec3 { return Array.isArray(v) ? [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0] : [v.x ?? 0, v.y ?? 0, v.z ?? 0]; }

function flat2(items: any[]): Sketch[] {
  const out: Sketch[] = [];
  for (const it of items) {
    if (Array.isArray(it)) out.push(...flat2(it));
    else if (it instanceof Sketch) out.push(it);
    else if (it && it.toSketch) out.push(it.toSketch());
    else if (it != null) throw new ForgeError('SKETCH.BAD_OPERAND', 'expected a Sketch');
  }
  return out;
}

export function anchorPoint(s: Sketch, a: Anchor): Vec2 {
  const b = s.bounds();
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  switch (a) {
    case 'top-left': return [b.minX, b.maxY];
    case 'top-right': return [b.maxX, b.maxY];
    case 'bottom-left': return [b.minX, b.minY];
    case 'bottom-right': return [b.maxX, b.minY];
    case 'top': return [cx, b.maxY];
    case 'bottom': return [cx, b.minY];
    case 'left': return [b.minX, cy];
    case 'right': return [b.maxX, cy];
    default: return [cx, cy];
  }
}

// ---------------------------------------------------------------- 2D primitives
export function fromPolys(polys: Vec2[][]): Sketch {
  return new Sketch(K().CrossSection.ofPolygons(polys as any, 'Positive' as any));
}

export function rect(w: number, h: number): Sketch {
  return new Sketch(K().CrossSection.square([w, h], true));
}
export function circle2d(r: number, segments?: number): Sketch {
  return new Sketch(K().CrossSection.circle(r, segments ?? DEFAULT_SEGMENTS.value));
}
export function roundedRect(w: number, h: number, r: number): Sketch {
  r = Math.max(0, Math.min(r, w / 2 - 1e-6, h / 2 - 1e-6));
  if (r <= 0) return rect(w, h);
  return new Sketch(K().CrossSection.square([w - 2 * r, h - 2 * r], true).offset(r, 'Round' as any, 2, DEFAULT_SEGMENTS.value));
}
export function polygon(points: any[]): Sketch {
  const pts = points.map(toVec2);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area < 0) pts.reverse();
  return new Sketch(K().CrossSection.ofPolygons([pts] as any, 'Positive' as any));
}
export function ngon(sides: number, radius: number): Sketch {
  const pts: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = Math.PI / 2 + (i * 2 * Math.PI) / sides;
    pts.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  return polygon(pts);
}
export function ellipse(rx: number, ry: number, segments?: number): Sketch {
  return circle2d(1, segments).scaleAround([0, 0], [rx, ry]);
}
export function slot(length: number, width: number): Sketch {
  const r = width / 2;
  const core = K().CrossSection.square([Math.max(1e-6, length - width), 1e-6], true);
  return new Sketch(core.offset(r, 'Round' as any, 2, DEFAULT_SEGMENTS.value));
}
export function arcSlot(pitchRadius: number, sweepDeg: number, thickness: number): Sketch {
  const pts: Vec2[] = [];
  const n = Math.max(4, Math.ceil(Math.abs(sweepDeg) / 3));
  for (let i = 0; i <= n; i++) {
    const a = ((sweepDeg * i) / n) * (Math.PI / 180);
    pts.push([pitchRadius * Math.cos(a), pitchRadius * Math.sin(a)]);
  }
  return stroke(pts, thickness, 'Round');
}
export function stroke(points: any[], width: number, join: 'Round' | 'Square' = 'Round'): Sketch {
  const pts = points.map(toVec2);
  const k = K();
  const parts: any[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * (width / 2), ny = (dx / l) * (width / 2);
    parts.push(k.CrossSection.ofPolygons([[[a[0] + nx, a[1] + ny], [a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny]]] as any, 'NonZero' as any));
    if (join === 'Round') parts.push(k.CrossSection.circle(width / 2, 24).translate(b));
  }
  if (join === 'Round' && pts.length) parts.push(k.CrossSection.circle(width / 2, 24).translate(pts[0]));
  return new Sketch(k.CrossSection.union(parts));
}

/** Catmull-Rom spline through points; closed by default. */
export function catmullRom(points: Vec2[], closed: boolean, tension = 0.5, samples = 16): Vec2[] {
  const n = points.length;
  const out: Vec2[] = [];
  const get = (i: number) => (closed ? points[((i % n) + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let s = 0; s < samples; s++) {
      const t = s / samples, t2 = t * t, t3 = t2 * t;
      const m1 = [(p2[0] - p0[0]) * tension, (p2[1] - p0[1]) * tension];
      const m2 = [(p3[0] - p1[0]) * tension, (p3[1] - p1[1]) * tension];
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      out.push([h00 * p1[0] + h10 * m1[0] + h01 * p2[0] + h11 * m2[0], h00 * p1[1] + h10 * m1[1] + h01 * p2[1] + h11 * m2[1]]);
    }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

export function spline2d(points: any[], opts: any = {}): Sketch {
  const pts = points.map(toVec2);
  const closed = opts.closed ?? true;
  const poly = catmullRom(pts, closed, opts.tension ?? 0.5, opts.samplesPerSegment ?? 16);
  if (closed) return polygon(poly);
  if (!opts.strokeWidth) throw new ForgeError('SKETCH.OPEN_SPLINE', 'open spline2d needs strokeWidth');
  return stroke(poly, opts.strokeWidth, opts.join ?? 'Round');
}

export function union2d(...items: any[]) { const s = flat2(items); return s[0].add(...s.slice(1)); }
export function difference2d(...items: any[]) { const s = flat2(items); return s[0].subtract(...s.slice(1)); }
export function intersection2d(...items: any[]) { const s = flat2(items); return s[0].intersect(...s.slice(1)); }

export function linearPattern2d(s: Sketch, count: number, dx: number, dy = 0): Sketch {
  const parts: any[] = [];
  for (let i = 0; i < count; i++) parts.push(s.translate(dx * i, dy * i));
  return union2d(parts);
}
export function circularPattern2d(s: Sketch, count: number, cxOrOpts: any = 0, cy = 0): Sketch {
  const o = typeof cxOrOpts === 'object' ? cxOrOpts : { centerX: cxOrOpts, centerY: cy };
  const parts: any[] = [];
  for (let i = 0; i < count; i++) parts.push(s.rotateAround((o.startDeg ?? 0) + (360 * i) / count, [o.centerX ?? 0, o.centerY ?? 0]));
  return union2d(parts);
}

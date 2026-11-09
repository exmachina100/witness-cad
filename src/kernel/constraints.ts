// constrainedSketch(): a 2D geometric constraint solver (damped Gauss-Newton with numeric Jacobian).
import { ForgeError } from './errors';
import { Sketch, polygon } from './sketch';
import { K } from './wasm';
import type { Vec2 } from './math';

type PointId = number;
interface PointE { id: PointId; kind: 'point'; x: number; y: number; fixed: boolean }
interface LineE { id: number; kind: 'line'; a: PointId; b: PointId; construction: boolean; name?: string }
interface CircleE { id: number; kind: 'circle'; c: PointId; r: number; construction: boolean; segments: number; name?: string }
interface ArcE { id: number; kind: 'arc'; c: PointId; a: PointId; b: PointId; clockwise: boolean }
type Entity = PointE | LineE | CircleE | ArcE;

interface Constraint { id: string; kind: string; residual: (v: (i: number) => number) => number[]; value?: number; refs: any[] }

export class ConstrainedSketchBuilder {
  private entities: Entity[] = [];
  private constraints: Constraint[] = [];
  private loops: { items: { kind: 'line' | 'arc'; id: number }[]; points: PointId[] }[] = [];
  private current: { items: { kind: 'line' | 'arc'; id: number }[]; points: PointId[] } | null = null;
  private nextId = 1;
  private cid = 0;
  constructor(private opts: { strict?: boolean } = {}) {}

  // ---------------- entities
  point(x = 0, y = 0, fixed = false) {
    const p: PointE = { id: this.nextId++, kind: 'point', x, y, fixed };
    this.entities.push(p);
    return p;
  }
  line(a: any, b: any, construction = false, name?: string) {
    const l: LineE = { id: this.nextId++, kind: 'line', a: this.pid(a), b: this.pid(b), construction, name };
    this.entities.push(l);
    return l;
  }
  circle(center: any, radius: number, construction = false, segments = 64, name?: string) {
    const c: CircleE = { id: this.nextId++, kind: 'circle', c: this.pid(center), r: radius, construction, segments, name };
    this.entities.push(c);
    return c;
  }
  arcByCenter(center: any, end: any, clockwise = false) {
    const last = this.current?.points[this.current.points.length - 1];
    if (last == null) throw new ForgeError('CSKETCH.NO_START', 'arcByCenter needs a current point (moveTo first)');
    const e = this.pidOrNew(end);
    const arc: ArcE = { id: this.nextId++, kind: 'arc', c: this.pidOrNew(center), a: last, b: e, clockwise };
    this.entities.push(arc);
    this.current!.items.push({ kind: 'arc', id: arc.id });
    this.current!.points.push(e);
    // endpoints equidistant from centre
    this.addC('arcRadius', [arc], (v) => [this.dist(v, arc.c, arc.a) - this.dist(v, arc.c, arc.b)]);
    return this;
  }
  rect(o: { x?: number; y?: number; width?: number; height?: number } = {}) {
    const x = o.x ?? 0, y = o.y ?? 0, w = o.width ?? 10, h = o.height ?? 10;
    const p = [this.point(x - w / 2, y - h / 2), this.point(x + w / 2, y - h / 2), this.point(x + w / 2, y + h / 2), this.point(x - w / 2, y + h / 2)];
    const lines = p.map((pt, i) => this.line(pt, p[(i + 1) % 4]));
    this.horizontal(lines[0]); this.horizontal(lines[2]); this.vertical(lines[1]); this.vertical(lines[3]);
    if (o.width != null) this.length(lines[0], w);
    if (o.height != null) this.length(lines[1], h);
    this.loops.push({ items: lines.map((l) => ({ kind: 'line' as const, id: l.id })), points: p.map((q) => q.id) });
    return { points: p, lines, bottom: lines[0], right: lines[1], top: lines[2], left: lines[3] };
  }
  regularPolygon(o: { sides: number; radius?: number; cx?: number; cy?: number; startAngle?: number }) {
    const r = o.radius ?? 10;
    const c = this.point(o.cx ?? 0, o.cy ?? 0);
    const pts = Array.from({ length: o.sides }, (_, i) => {
      const a = (((o.startAngle ?? 90) + (360 * i) / o.sides) * Math.PI) / 180;
      return this.point(c.x + r * Math.cos(a), c.y + r * Math.sin(a));
    });
    const lines = pts.map((p, i) => this.line(p, pts[(i + 1) % pts.length]));
    for (const p of pts) this.addC('onCircle', [c, p], (v) => [this.dist(v, c.id, p.id) - r]);
    for (let i = 1; i < lines.length; i++) this.equal(lines[0], lines[i]);
    this.loops.push({ items: lines.map((l) => ({ kind: 'line' as const, id: l.id })), points: pts.map((q) => q.id) });
    return { center: c, points: pts, lines };
  }
  addPolygon(o: { points: Vec2[]; addLoop?: boolean }) {
    const pts = o.points.map((p) => this.point(p[0], p[1]));
    const lines = pts.map((p, i) => this.line(p, pts[(i + 1) % pts.length]));
    if (o.addLoop !== false) this.loops.push({ items: lines.map((l) => ({ kind: 'line' as const, id: l.id })), points: pts.map((q) => q.id) });
    return { points: pts, lines };
  }

  // ---------------- turtle drawing
  moveTo(x: number, y: number) {
    if (this.current && this.current.points.length > 1) this.loops.push(this.current);
    const p = this.point(x, y);
    this.current = { items: [], points: [p.id] };
    return this;
  }
  lineTo(x: number, y: number) {
    if (!this.current) this.moveTo(0, 0);
    const prev = this.current!.points[this.current!.points.length - 1];
    const p = this.point(x, y);
    const l = this.line(prev, p);
    this.current!.items.push({ kind: 'line', id: l.id });
    this.current!.points.push(p.id);
    return this;
  }
  lineH(dx: number) { const p = this.lastPoint(); return this.lineTo(p.x + dx, p.y); }
  lineV(dy: number) { const p = this.lastPoint(); return this.lineTo(p.x, p.y + dy); }
  lineAngled(len: number, deg: number) { const p = this.lastPoint(); return this.lineTo(p.x + len * Math.cos((deg * Math.PI) / 180), p.y + len * Math.sin((deg * Math.PI) / 180)); }
  arcTo(x: number, y: number, _r?: number, cw = false) {
    const p = this.lastPoint();
    return this.arcByCenter(this.point((p.x + x) / 2, (p.y + y) / 2), this.point(x, y), cw);
  }
  bezierTo(_x1: number, _y1: number, _x2: number, _y2: number, x: number, y: number) { return this.lineTo(x, y); }
  bezier(...a: number[]) { return this.bezierTo(a[0], a[1], a[2], a[3], a[4], a[5]); }
  blendTo(x: number, y: number) { return this.lineTo(x, y); }
  label(name: string) {
    const it = this.current?.items[this.current.items.length - 1];
    if (it) { const e = this.ent(it.id) as LineE; e.name = name; }
    return this;
  }
  close() {
    if (!this.current) return this;
    const pts = this.current.points;
    const first = pts[0], last = pts[pts.length - 1];
    const fp = this.ent(first) as PointE, lp = this.ent(last) as PointE;
    if (Math.hypot(fp.x - lp.x, fp.y - lp.y) < 1e-9 && pts.length > 2) {
      pts.pop();
      // re-point last item at first
      const it = this.current.items[this.current.items.length - 1];
      const e = this.ent(it.id) as any;
      e.b = first;
    } else {
      const l = this.line(last, first);
      this.current.items.push({ kind: 'line', id: l.id });
    }
    this.loops.push(this.current);
    this.current = null;
    return this;
  }
  addLoop(lines: LineE[]) { this.loops.push({ items: lines.map((l) => ({ kind: 'line' as const, id: l.id })), points: lines.map((l) => l.a) }); return this; }
  addProfileLoop(lines: LineE[]) { return this.addLoop(lines); }
  get lines() { return this.entities.filter((e) => e.kind === 'line') as LineE[]; }
  get points() { return this.entities.filter((e) => e.kind === 'point') as PointE[]; }
  lastLine() { return this.lines[this.lines.length - 1]; }

  // ---------------- constraints
  horizontal(l: any) { const L = this.lineE(l); return this.addC('horizontal', [L], (v) => [v(this.yi(L.a)) - v(this.yi(L.b))]); }
  vertical(l: any) { const L = this.lineE(l); return this.addC('vertical', [L], (v) => [v(this.xi(L.a)) - v(this.xi(L.b))]); }
  parallel(a: any, b: any) { const A = this.lineE(a), B = this.lineE(b); return this.addC('parallel', [A, B], (v) => [this.cross(v, A, B)]); }
  sameDirection(a: any, b: any) { return this.parallel(a, b); }
  oppositeDirection(a: any, b: any) { return this.parallel(a, b); }
  perpendicular(a: any, b: any) { const A = this.lineE(a), B = this.lineE(b); return this.addC('perpendicular', [A, B], (v) => [this.dotL(v, A, B)]); }
  collinear(a: any, b: any) {
    const A = this.lineE(a), B = this.lineE(b);
    return this.addC('collinear', [A, B], (v) => [this.cross(v, A, B), this.ptLineDist(v, B.a, A)]);
  }
  distance(a: any, b: any, value: number) { const pa = this.pid(a), pb = this.pid(b); return this.addC('distance', [a, b], (v) => [this.dist(v, pa, pb) - value], value); }
  length(l: any, value: number) { const L = this.lineE(l); return this.addC('length', [L], (v) => [this.dist(v, L.a, L.b) - value], value); }
  hDistance(a: any, b: any, value: number) { const pa = this.pid(a), pb = this.pid(b); return this.addC('hDistance', [a, b], (v) => [v(this.xi(pb)) - v(this.xi(pa)) - value], value); }
  vDistance(a: any, b: any, value: number) { const pa = this.pid(a), pb = this.pid(b); return this.addC('vDistance', [a, b], (v) => [v(this.yi(pb)) - v(this.yi(pa)) - value], value); }
  offsetX(a: any, b: any, value: number) { return this.hDistance(a, b, value); }
  offsetY(a: any, b: any, value: number) { return this.vDistance(a, b, value); }
  angle(a: any, b: any, deg: number) {
    const A = this.lineE(a), B = this.lineE(b);
    return this.addC('angle', [A, B], (v) => {
      const [ax, ay] = this.dir(v, A), [bx, by] = this.dir(v, B);
      const ang = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
      return [wrap(ang - (deg * Math.PI) / 180)];
    }, deg);
  }
  angleBetween(a: any, b: any, deg: number) { return this.angle(a, b, deg); }
  absoluteAngle(l: any, deg: number) {
    const L = this.lineE(l);
    return this.addC('absoluteAngle', [L], (v) => { const [x, y] = this.dir(v, L); return [wrap(Math.atan2(y, x) - (deg * Math.PI) / 180)]; }, deg);
  }
  radius(c: any, value: number) { const C = this.circleE(c); return this.addC('radius', [C], (v) => [v(this.ri(C)) - value], value); }
  diameter(c: any, value: number) { return this.radius(c, value / 2); }
  equalRadius(a: any, b: any) { const A = this.circleE(a), B = this.circleE(b); return this.addC('equalRadius', [A, B], (v) => [v(this.ri(A)) - v(this.ri(B))]); }
  equal(a: any, b: any) {
    const A = this.lineE(a), B = this.lineE(b);
    return this.addC('equal', [A, B], (v) => [this.dist(v, A.a, A.b) - this.dist(v, B.a, B.b)]);
  }
  coincident(a: any, b: any) { const pa = this.pid(a), pb = this.pid(b); return this.addC('coincident', [a, b], (v) => [v(this.xi(pa)) - v(this.xi(pb)), v(this.yi(pa)) - v(this.yi(pb))]); }
  concentric(a: any, b: any) { return this.coincident(this.circleE(a).c, this.circleE(b).c); }
  fix(p: any, x?: number, y?: number) {
    const P = this.ent(this.pid(p)) as PointE;
    const fx = x ?? P.x, fy = y ?? P.y;
    return this.addC('fix', [P], (v) => [v(this.xi(P.id)) - fx, v(this.yi(P.id)) - fy]);
  }
  midpoint(p: any, l: any) {
    const P = this.pid(p), L = this.lineE(l);
    return this.addC('midpoint', [p, L], (v) => [v(this.xi(P)) - (v(this.xi(L.a)) + v(this.xi(L.b))) / 2, v(this.yi(P)) - (v(this.yi(L.a)) + v(this.yi(L.b))) / 2]);
  }
  pointOnLine(p: any, l: any) { const P = this.pid(p), L = this.lineE(l); return this.addC('pointOnLine', [p, L], (v) => [this.ptLineDist(v, P, L)]); }
  pointOnCircle(p: any, c: any) { const P = this.pid(p), C = this.circleE(c); return this.addC('pointOnCircle', [p, C], (v) => [this.dist(v, P, C.c) - v(this.ri(C))]); }
  pointLineDistance(p: any, l: any, value: number) { const P = this.pid(p), L = this.lineE(l); return this.addC('pointLineDistance', [p, L], (v) => [Math.abs(this.ptLineDist(v, P, L)) - value], value); }
  lineDistance(a: any, b: any, value: number) { const A = this.lineE(a), B = this.lineE(b); return this.addC('lineDistance', [A, B], (v) => [this.cross(v, A, B), Math.abs(this.ptLineDist(v, B.a, A)) - value], value); }
  tangent(a: any, b: any) {
    const ea = this.ent(typeof a === 'object' ? a.id : a), eb = this.ent(typeof b === 'object' ? b.id : b);
    const L = (ea.kind === 'line' ? ea : eb) as LineE, C = (ea.kind === 'circle' ? ea : eb) as CircleE;
    if (L.kind !== 'line' || C.kind !== 'circle') {
      const A = this.circleE(a), B = this.circleE(b);
      return this.addC('tangent', [A, B], (v) => [this.dist(v, A.c, B.c) - (v(this.ri(A)) + v(this.ri(B)))]);
    }
    return this.addC('tangent', [L, C], (v) => [Math.abs(this.ptLineDist(v, C.c, L)) - v(this.ri(C))]);
  }
  symmetric(a: any, b: any, axis: any) {
    const pa = this.pid(a), pb = this.pid(b), L = this.lineE(axis);
    return this.addC('symmetric', [a, b, L], (v) => {
      const mx = (v(this.xi(pa)) + v(this.xi(pb))) / 2, my = (v(this.yi(pa)) + v(this.yi(pb))) / 2;
      const [dx, dy] = this.dir(v, L);
      const ex = v(this.xi(pb)) - v(this.xi(pa)), ey = v(this.yi(pb)) - v(this.yi(pa));
      const lx = v(this.xi(L.a)), ly = v(this.yi(L.a));
      const len = Math.hypot(dx, dy) || 1;
      return [((mx - lx) * dy - (my - ly) * dx) / len, (ex * dx + ey * dy) / len];
    });
  }
  ccw() { return this; }
  blockRotation() { return this; }
  shapeWidth(s: any, value: number) { const P = this.shapePts(s); return this.addC('shapeWidth', [s], (v) => { const xs = P.map((p) => v(this.xi(p))); return [Math.max(...xs) - Math.min(...xs) - value]; }, value); }
  shapeHeight(s: any, value: number) { const P = this.shapePts(s); return this.addC('shapeHeight', [s], (v) => { const ys = P.map((p) => v(this.yi(p))); return [Math.max(...ys) - Math.min(...ys) - value]; }, value); }
  shapeArea(s: any, value: number) { const P = this.shapePts(s); return this.addC('shapeArea', [s], (v) => [Math.abs(this.polyArea(v, P)) - value], value); }
  shapeCentroidX(s: any, value: number) { const P = this.shapePts(s); return this.addC('shapeCentroidX', [s], (v) => [this.polyCentroid(v, P)[0] - value], value); }
  shapeCentroidY(s: any, value: number) { const P = this.shapePts(s); return this.addC('shapeCentroidY', [s], (v) => [this.polyCentroid(v, P)[1] - value], value); }
  shapeEqualCentroid(a: any, b: any) {
    const A = this.shapePts(a), B = this.shapePts(b);
    return this.addC('shapeEqualCentroid', [a, b], (v) => { const ca = this.polyCentroid(v, A), cb = this.polyCentroid(v, B); return [ca[0] - cb[0], ca[1] - cb[1]]; });
  }

  // ---------------- extra entities
  pointAt(x: number, y: number, fixed = false) { return this.point(x, y, fixed); }
  lineAt(x1: number, y1: number, x2: number, y2: number, construction = false) { return this.line(this.point(x1, y1), this.point(x2, y2), construction); }
  /** A closed polygon from points ([x, y] or point handles); also added as a profile loop. */
  shape(points: any[], o: { construction?: boolean; name?: string } = {}) {
    const ids = points.map((p) => this.pidOrNew(p));
    const lines = ids.map((id, i) => this.line(id, ids[(i + 1) % ids.length], o.construction));
    if (!o.construction) this.loops.push({ items: lines.map((l) => ({ kind: 'line' as const, id: l.id })), points: ids });
    return { kind: 'shape' as const, id: this.nextId++, points: ids, lines, name: o.name };
  }
  /** Rectangle as a shape handle (width/height/centroid constraints apply to it). */
  groupRect(o: { x?: number; y?: number; width?: number; height?: number } = {}) {
    const x = o.x ?? 0, y = o.y ?? 0, w = o.width ?? 10, h = o.height ?? 10;
    const sh = this.shape([[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2]]);
    this.horizontal(sh.lines[0]); this.horizontal(sh.lines[2]); this.vertical(sh.lines[1]); this.vertical(sh.lines[3]);
    if (o.width != null) this.length(sh.lines[0], w);
    if (o.height != null) this.length(sh.lines[1], h);
    return sh;
  }
  /** Group entities so they can be referenced together; returns a shape-like handle over their points. */
  group(...items: any[]) {
    const pts: PointId[] = [];
    for (const it of items.flat()) {
      if (it?.kind === 'shape') pts.push(...it.points);
      else if (it?.kind === 'line') pts.push(it.a, it.b);
      else if (it?.kind === 'point' || typeof it === 'number') pts.push(this.pid(it));
    }
    return { kind: 'shape' as const, id: this.nextId++, points: [...new Set(pts)], lines: items.flat().filter((i: any) => i?.kind === 'line') };
  }
  /** Polyline through points: route([[0,0],[10,0],[10,5]], { close: true }). */
  route(points: Vec2[], o: { close?: boolean } = {}) {
    this.moveTo(points[0][0], points[0][1]);
    for (const p of points.slice(1)) this.lineTo(p[0], p[1]);
    return o.close ? this.close() : this;
  }
  lastArc() { const a = [...this.entities].reverse().find((e) => e.kind === 'arc'); if (!a) throw new ForgeError('CSKETCH.NO_ARC', 'no arc yet'); return a as ArcE; }
  /** Arc length of an arc (default: the last arc drawn). */
  arcLength(arcOrValue: any, value?: number) {
    const A = value == null ? this.lastArc() : this.arcE(arcOrValue);
    const L = value ?? arcOrValue;
    return this.addC('arcLength', [A], (v) => [this.arcSweep(v, A) * this.dist(v, A.c, A.a) - L], L);
  }
  /** Line meets arc tangentially at their shared endpoint. */
  lineTangentArc(l: any, arc?: any) {
    const L = this.lineE(l), A = arc == null ? this.lastArc() : this.arcE(arc);
    const p = [A.a, A.b].find((q) => q === L.a || q === L.b) ?? A.a;
    return this.addC('lineTangentArc', [L, A], (v) => { const [dx, dy] = this.dir(v, L); const rx = v(this.xi(p)) - v(this.xi(A.c)), ry = v(this.yi(p)) - v(this.yi(A.c)); return [(dx * rx + dy * ry) / ((Math.hypot(dx, dy) * Math.hypot(rx, ry)) || 1)]; });
  }
  /** Two arcs meet tangentially at their shared endpoint (centres and joint collinear). */
  arcTangentArc(a: any, b: any) {
    const A = this.arcE(a), B = this.arcE(b);
    const p = [A.a, A.b].find((q) => q === B.a || q === B.b) ?? A.b;
    return this.addC('arcTangentArc', [A, B], (v) => {
      const ax = v(this.xi(p)) - v(this.xi(A.c)), ay = v(this.yi(p)) - v(this.yi(A.c)), bx = v(this.xi(p)) - v(this.xi(B.c)), by = v(this.yi(p)) - v(this.yi(B.c));
      return [(ax * by - ay * bx) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1)];
    });
  }
  bezierTangentArc(l: any, arc?: any) { return this.lineTangentArc(l, arc); }
  /** Tangent continuity between two consecutive entities (line/arc in any combination). */
  smoothBlend(a: any, b: any) {
    const ea = this.ent(typeof a === 'object' ? a.id : a), eb = this.ent(typeof b === 'object' ? b.id : b);
    if (ea.kind === 'arc' && eb.kind === 'arc') return this.arcTangentArc(ea, eb);
    if (ea.kind === 'line' && eb.kind === 'arc') return this.lineTangentArc(ea, eb);
    if (ea.kind === 'arc' && eb.kind === 'line') return this.lineTangentArc(eb, ea);
    return this.parallel(ea, eb);
  }
  /** Copy a point from another solved sketch as a fixed reference. */
  referenceFrom(sketch: any, pointId: number | { id: number }) {
    const p = sketch.point(pointId);
    return this.point(p.x, p.y, true);
  }
  /** Copy every point of another solved sketch as fixed references (returned in order). */
  referenceAllFrom(sketch: any) { return (sketch.pointIds?.() ?? []).map((id: number) => this.referenceFrom(sketch, id)); }

  // ---------------- solve
  solve(o: { maxIterations?: number; tolerance?: number } = {}): ConstraintSketch {
    const vars: number[] = [];
    const index = new Map<string, number>();
    for (const e of this.entities) {
      if (e.kind === 'point') {
        index.set(`x${e.id}`, vars.length); vars.push(e.x);
        index.set(`y${e.id}`, vars.length); vars.push(e.y);
      } else if (e.kind === 'circle') { index.set(`r${e.id}`, vars.length); vars.push(e.r); }
    }
    this._index = index;
    const fixedVars = new Set<number>();
    for (const e of this.entities) if (e.kind === 'point' && e.fixed) { fixedVars.add(index.get(`x${e.id}`)!); fixedVars.add(index.get(`y${e.id}`)!); }
    const x = vars.slice();
    const res = (xx: number[]) => this.constraints.flatMap((c) => c.residual((i) => xx[i]));
    const tol = o.tolerance ?? 1e-9;
    let lambda = 1e-3;
    let r = res(x);
    let err = r.reduce((s, v) => s + v * v, 0);
    for (let it = 0; it < (o.maxIterations ?? 200) && err > tol; it++) {
      const J = jacobian(res, x, fixedVars);
      const n = x.length;
      // (JᵀJ + λI) dx = -Jᵀr
      const A = Array.from({ length: n }, () => new Array(n).fill(0));
      const g = new Array(n).fill(0);
      for (let i = 0; i < r.length; i++) for (let a = 0; a < n; a++) {
        if (!J[i][a]) continue;
        g[a] += J[i][a] * r[i];
        for (let b = 0; b < n; b++) A[a][b] += J[i][a] * J[i][b];
      }
      for (let a = 0; a < n; a++) A[a][a] += lambda * (1 + A[a][a]);
      const dx = solveLinear(A, g.map((v) => -v));
      const xn = x.map((v, i) => v + (dx[i] ?? 0));
      const rn = res(xn);
      const en = rn.reduce((s, v) => s + v * v, 0);
      if (en < err) { for (let i = 0; i < n; i++) x[i] = xn[i]; r = rn; err = en; lambda = Math.max(1e-9, lambda / 3); }
      else lambda *= 4;
      if (lambda > 1e9) break;
    }
    const J = jacobian(res, x, fixedVars);
    const rank = matrixRank(J);
    const free = x.length - fixedVars.size;
    const dof = free - rank;
    const redundant = r.length - rank;
    const maxError = Math.sqrt(Math.max(0, ...r.map((v) => v * v)));
    const status = maxError > 1e-5 ? 'over' : dof > 0 ? 'under' : redundant > 0 ? 'over-redundant' : 'fully';
    if (this.opts.strict && status !== 'fully') throw new ForgeError('CSKETCH.NOT_FULLY_CONSTRAINED', `sketch is ${status} constrained (dof ${dof})`);
    // write back
    const pos = new Map<number, Vec2>();
    for (const e of this.entities) if (e.kind === 'point') pos.set(e.id, [x[index.get(`x${e.id}`)!], x[index.get(`y${e.id}`)!]]);
    const radii = new Map<number, number>();
    for (const e of this.entities) if (e.kind === 'circle') radii.set(e.id, x[index.get(`r${e.id}`)!]);
    if (this.current && this.current.points.length > 2) this.close();
    return new ConstraintSketch(
      { status, dof, maxError, constraints: this.constraints.map((c) => ({ id: c.id, kind: c.kind, value: c.value })) },
      this.entities, pos, radii, this.loops,
      (id: string, value: number) => {
        const c = this.constraints.find((k) => k.id === id);
        if (!c) throw new ForgeError('CSKETCH.NO_CONSTRAINT', `no constraint ${id}`);
        return this;
      },
    );
  }

  // ---------------- internals
  private _index = new Map<string, number>();
  private xi(p: PointId) { return this.lazyIndex(`x${p}`); }
  private yi(p: PointId) { return this.lazyIndex(`y${p}`); }
  private ri(c: CircleE) { return this.lazyIndex(`r${c.id}`); }
  private lazyIndex(k: string) { const i = this._index.get(k); if (i == null) throw new ForgeError('CSKETCH.INTERNAL', `unknown variable ${k}`); return i; }
  private ent(id: number) { const e = this.entities.find((x) => x.id === id); if (!e) throw new ForgeError('CSKETCH.NO_ENTITY', `no entity ${id}`); return e; }
  private pid(p: any): PointId { if (typeof p === 'number') return p; if (p?.kind === 'point') return p.id; throw new ForgeError('CSKETCH.NOT_POINT', 'expected a point'); }
  private pidOrNew(p: any): PointId { if (Array.isArray(p)) return this.point(p[0], p[1]).id; return this.pid(p); }
  private lineE(l: any): LineE { const e = this.ent(typeof l === 'number' ? l : l.id); if (e.kind !== 'line') throw new ForgeError('CSKETCH.NOT_LINE', 'expected a line'); return e; }
  private arcE(a: any): ArcE { const e = this.ent(typeof a === 'number' ? a : a.id); if (e.kind !== 'arc') throw new ForgeError('CSKETCH.NOT_ARC', 'expected an arc'); return e; }
  private shapePts(s: any): PointId[] { if (s?.kind === 'shape') return s.points; if (Array.isArray(s)) return s.map((p: any) => this.pid(p)); throw new ForgeError('CSKETCH.NOT_SHAPE', 'expected a shape handle from shape(), groupRect() or group()'); }
  private polyArea(v: (i: number) => number, P: PointId[]) { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += v(this.xi(p)) * v(this.yi(q)) - v(this.xi(q)) * v(this.yi(p)); } return a / 2; }
  private polyCentroid(v: (i: number) => number, P: PointId[]): Vec2 {
    const A = this.polyArea(v, P);
    if (Math.abs(A) < 1e-12) return [P.reduce((s, p) => s + v(this.xi(p)), 0) / P.length, P.reduce((s, p) => s + v(this.yi(p)), 0) / P.length];
    let cx = 0, cy = 0;
    for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; const c = v(this.xi(p)) * v(this.yi(q)) - v(this.xi(q)) * v(this.yi(p)); cx += (v(this.xi(p)) + v(this.xi(q))) * c; cy += (v(this.yi(p)) + v(this.yi(q))) * c; }
    return [cx / (6 * A), cy / (6 * A)];
  }
  private arcSweep(v: (i: number) => number, A: ArcE) {
    const a0 = Math.atan2(v(this.yi(A.a)) - v(this.yi(A.c)), v(this.xi(A.a)) - v(this.xi(A.c)));
    const a1 = Math.atan2(v(this.yi(A.b)) - v(this.yi(A.c)), v(this.xi(A.b)) - v(this.xi(A.c)));
    let d = a1 - a0;
    if (A.clockwise) { while (d > 0) d -= 2 * Math.PI; return -d; }
    while (d < 0) d += 2 * Math.PI;
    return d;
  }
  private circleE(c: any): CircleE { const e = this.ent(typeof c === 'number' ? c : c.id); if (e.kind !== 'circle') throw new ForgeError('CSKETCH.NOT_CIRCLE', 'expected a circle'); return e; }
  private lastPoint(): PointE { const id = this.current?.points[this.current.points.length - 1]; return id ? (this.ent(id) as PointE) : this.point(0, 0); }
  private addC(kind: string, refs: any[], residual: Constraint['residual'], value?: number) {
    const id = `c${++this.cid}`;
    this.constraints.push({ id, kind, refs, residual, value });
    return this;
  }
  private dist(v: (i: number) => number, a: PointId, b: PointId) { return Math.hypot(v(this.xi(b)) - v(this.xi(a)), v(this.yi(b)) - v(this.yi(a))); }
  private dir(v: (i: number) => number, L: LineE): Vec2 { return [v(this.xi(L.b)) - v(this.xi(L.a)), v(this.yi(L.b)) - v(this.yi(L.a))]; }
  private cross(v: (i: number) => number, A: LineE, B: LineE) {
    const [ax, ay] = this.dir(v, A), [bx, by] = this.dir(v, B);
    return (ax * by - ay * bx) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1);
  }
  private dotL(v: (i: number) => number, A: LineE, B: LineE) {
    const [ax, ay] = this.dir(v, A), [bx, by] = this.dir(v, B);
    return (ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1);
  }
  private ptLineDist(v: (i: number) => number, p: PointId, L: LineE) {
    const [dx, dy] = this.dir(v, L);
    const len = Math.hypot(dx, dy) || 1;
    return ((v(this.xi(p)) - v(this.xi(L.a))) * dy - (v(this.yi(p)) - v(this.yi(L.a))) * dx) / len;
  }
}

function wrap(a: number) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

function jacobian(f: (x: number[]) => number[], x: number[], fixed: Set<number>) {
  const r0 = f(x);
  const J = r0.map(() => new Array(x.length).fill(0));
  for (let j = 0; j < x.length; j++) {
    if (fixed.has(j)) continue;
    const h = 1e-7 * Math.max(1, Math.abs(x[j]));
    const xp = x.slice(); xp[j] += h;
    const rp = f(xp);
    for (let i = 0; i < r0.length; i++) J[i][j] = (rp[i] - r0[i]) / h;
  }
  return J;
}

function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) continue;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-14 ? 0 : row[n] / row[i]));
}

function matrixRank(J: number[][]): number {
  const M = J.map((r) => r.slice());
  let rank = 0;
  const rows = M.length, cols = rows ? M[0].length : 0;
  for (let c = 0; c < cols && rank < rows; c++) {
    let p = rank;
    for (let r = rank + 1; r < rows; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-8) continue;
    [M[rank], M[p]] = [M[p], M[rank]];
    for (let r = rank + 1; r < rows; r++) {
      const f = M[r][c] / M[rank][c];
      for (let k = c; k < cols; k++) M[r][k] -= f * M[rank][k];
    }
    rank++;
  }
  return rank;
}

export class ConstraintSketch {
  readonly kind = 'constraintSketch';
  constructor(
    public constraintMeta: { status: string; dof: number; maxError: number; constraints: any[] },
    private entities: Entity[], private pos: Map<number, Vec2>, private radii: Map<number, number>,
    private loops: { items: { kind: 'line' | 'arc'; id: number }[]; points: number[] }[],
    private _update: (id: string, v: number) => any,
  ) {}
  get definition() { return { entities: this.entities, loops: this.loops }; }
  point(id: number | { id: number }) { const p = this.pos.get(typeof id === 'number' ? id : id.id)!; return { x: p[0], y: p[1] }; }
  pointIds() { return this.entities.filter((e) => e.kind === 'point').map((e) => e.id); }
  private loopPolyline(loop: { items: { kind: 'line' | 'arc'; id: number }[]; points: number[] }): Vec2[] {
    const out: Vec2[] = [];
    for (const it of loop.items) {
      const e = this.entities.find((x) => x.id === it.id)!;
      if (e.kind === 'line') out.push(this.pos.get(e.a)!);
      else if (e.kind === 'arc') {
        const c = this.pos.get(e.c)!, a = this.pos.get(e.a)!, b = this.pos.get(e.b)!;
        const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
        let a0 = Math.atan2(a[1] - c[1], a[0] - c[0]), a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
        if (!e.clockwise && a1 <= a0) a1 += 2 * Math.PI;
        if (e.clockwise && a1 >= a0) a1 -= 2 * Math.PI;
        const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 0.1));
        for (let i = 0; i < n; i++) out.push([c[0] + r * Math.cos(a0 + ((a1 - a0) * i) / n), c[1] + r * Math.sin(a0 + ((a1 - a0) * i) / n)]);
      }
    }
    return out;
  }
  toPolyline(): Vec2[][] { return this.loops.map((l) => this.loopPolyline(l)); }
  /** All closed regions formed by the profile loops and non-construction circles. */
  detectArrangement(): Sketch[] {
    const k = K();
    const parts: Vec2[][] = this.toPolyline().filter((p) => p.length >= 3);
    for (const e of this.entities) if (e.kind === 'circle' && !e.construction) {
      const c = this.pos.get(e.c)!, r = this.radii.get(e.id)!;
      parts.push(Array.from({ length: e.segments }, (_, i) => [c[0] + r * Math.cos((i / e.segments) * 2 * Math.PI), c[1] + r * Math.sin((i / e.segments) * 2 * Math.PI)] as Vec2));
    }
    if (!parts.length) return [];
    const cs = k.CrossSection.ofPolygons(parts as any, 'EvenOdd' as any);
    return new Sketch(cs).regions();
  }
  detectArrangementRegion(seed: Vec2) { return this.toSketch().region(seed); }
  toSketch(): Sketch {
    const k = K();
    const parts: Vec2[][] = this.toPolyline().filter((p) => p.length >= 3);
    for (const e of this.entities) if (e.kind === 'circle' && !e.construction) {
      const c = this.pos.get(e.c)!, r = this.radii.get(e.id)!;
      parts.push(Array.from({ length: e.segments }, (_, i) => [c[0] + r * Math.cos((i / e.segments) * 2 * Math.PI), c[1] + r * Math.sin((i / e.segments) * 2 * Math.PI)] as Vec2));
    }
    if (!parts.length) throw new ForgeError('CSKETCH.EMPTY', 'constrained sketch has no closed profile');
    return new Sketch(k.CrossSection.ofPolygons(parts as any, 'EvenOdd' as any));
  }
  extrude(h: number, o?: any) { return this.toSketch().extrude(h, o); }
  revolve(d?: number) { return this.toSketch().revolve(d); }
  withUpdatedConstraint(id: string, value: number) { this._update(id, value); return this; }
}

export function constrainedSketch(opts: { strict?: boolean } = {}) { return new ConstrainedSketchBuilder(opts); }
export { polygon };

// PathBuilder: turtle-style 2D outline construction that closes into a Sketch.
import { Sketch, polygon, stroke, catmullRom } from './sketch';
import { Vec2 } from './math';
import { ForgeError } from './errors';

const ARC_SEG_DEG = 5;

export class PathBuilder {
  pts: Vec2[] = [];
  segLabels: { index: number; name: string }[] = [];
  private pendingFillet: { index: number; r: number }[] = [];
  private pendingChamfer: { index: number; d: number }[] = [];

  private get cur(): Vec2 {
    if (!this.pts.length) this.pts.push([0, 0]);
    return this.pts[this.pts.length - 1];
  }
  getX() { return this.cur[0]; }
  getY() { return this.cur[1]; }
  moveTo(x: number, y: number) { this.pts = [[x, y]]; return this; }
  lineTo(x: number, y: number) { this.cur; this.pts.push([x, y]); return this; }
  lineBy(dx: number, dy: number) { const c = this.cur; return this.lineTo(c[0] + dx, c[1] + dy); }
  lineH(dx: number) { return this.lineBy(dx, 0); }
  lineV(dy: number) { return this.lineBy(0, dy); }
  lineAngled(length: number, deg: number) {
    const r = (deg * Math.PI) / 180;
    return this.lineBy(length * Math.cos(r), length * Math.sin(r));
  }
  label(name: string) {
    this.segLabels.push({ index: this.pts.length - 2, name });
    return this;
  }
  closeLabel(name: string) { this.segLabels.push({ index: -1, name }); return this; }

  private arcPoints(cx: number, cy: number, r: number, a0: number, a1: number) {
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / ARC_SEG_DEG));
    for (let i = 1; i <= n; i++) {
      const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
      this.pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  arc(cx: number, cy: number, radius: number, startDeg: number, endDeg: number) {
    const s = (startDeg * Math.PI) / 180;
    this.lineTo(cx + radius * Math.cos(s), cy + radius * Math.sin(s));
    this.arcPoints(cx, cy, radius, startDeg, endDeg);
    return this;
  }
  arcTo(x: number, y: number, radius: number, clockwise = false) {
    const [x0, y0] = this.cur;
    const dx = x - x0, dy = y - y0, d = Math.hypot(dx, dy);
    const r = Math.max(radius, d / 2);
    const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
    const mx = (x0 + x) / 2, my = (y0 + y) / 2;
    const sgn = clockwise ? -1 : 1;
    const cx = mx - (sgn * h * dy) / d, cy = my + (sgn * h * dx) / d;
    let a0 = (Math.atan2(y0 - cy, x0 - cx) * 180) / Math.PI;
    let a1 = (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
    if (!clockwise && a1 < a0) a1 += 360;
    if (clockwise && a1 > a0) a1 -= 360;
    this.arcPoints(cx, cy, r, a0, a1);
    this.pts[this.pts.length - 1] = [x, y];
    return this;
  }
  arcBy(dx: number, dy: number, radius: number, clockwise = false) { const c = this.cur; return this.arcTo(c[0] + dx, c[1] + dy, radius, clockwise); }
  exactArcTo(x: number, y: number, o: { radius?: number; clockwise?: boolean } = {}) {
    const [x0, y0] = this.cur;
    return this.arcTo(x, y, o.radius ?? Math.hypot(x - x0, y - y0) / 2, o.clockwise);
  }
  arcAround(cx: number, cy: number, sweepDeg: number) {
    const [x0, y0] = this.cur;
    const r = Math.hypot(x0 - cx, y0 - cy);
    const a0 = (Math.atan2(y0 - cy, x0 - cx) * 180) / Math.PI;
    this.arcPoints(cx, cy, r, a0, a0 + sweepDeg);
    return this;
  }
  arcAroundRelative(dx: number, dy: number, sweepDeg: number) { const c = this.cur; return this.arcAround(c[0] + dx, c[1] + dy, sweepDeg); }
  tangentArcTo(x: number, y: number) {
    const n = this.pts.length;
    if (n < 2) return this.arcTo(x, y, Math.hypot(x - this.cur[0], y - this.cur[1]) / 2);
    const [px, py] = this.pts[n - 2], [x0, y0] = this.pts[n - 1];
    const tx = x0 - px, ty = y0 - py;
    const tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl, ny = tx / tl; // left normal
    const dx = x - x0, dy = y - y0;
    const denom = 2 * (dx * nx + dy * ny);
    if (Math.abs(denom) < 1e-9) return this.lineTo(x, y);
    const r = (dx * dx + dy * dy) / denom;
    const cx = x0 + nx * r, cy = y0 + ny * r;
    let a0 = (Math.atan2(y0 - cy, x0 - cx) * 180) / Math.PI;
    let a1 = (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
    if (r > 0 && a1 < a0) a1 += 360;
    if (r < 0 && a1 > a0) a1 -= 360;
    this.arcPoints(cx, cy, Math.abs(r), a0, a1);
    this.pts[this.pts.length - 1] = [x, y];
    return this;
  }
  bezierTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
    const [x0, y0] = this.cur;
    const n = 24;
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      this.pts.push([
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      ]);
    }
    return this;
  }
  bezierBy(dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number) {
    const [x, y] = this.cur;
    return this.bezierTo(x + dx1, y + dy1, x + dx2, y + dy2, x + dx3, y + dy3);
  }
  tangentBezierTo(cp2x: number, cp2y: number, x: number, y: number, weight = 0.5) {
    const n = this.pts.length;
    const [x0, y0] = this.cur;
    let c1: Vec2 = [x0, y0];
    if (n >= 2) {
      const [px, py] = this.pts[n - 2];
      const l = Math.hypot(x - x0, y - y0) * weight;
      const tl = Math.hypot(x0 - px, y0 - py) || 1;
      c1 = [x0 + ((x0 - px) / tl) * l, y0 + ((y0 - py) / tl) * l];
    }
    return this.bezierTo(c1[0], c1[1], cp2x, cp2y, x, y);
  }
  blendTo(x: number, y: number, weight = 0.5) {
    const [x0, y0] = this.cur;
    return this.tangentBezierTo(x - (x - x0) * weight, y - (y - y0) * weight, x, y, weight);
  }
  smoothThrough(waypoints: any[], tension = 0.5) {
    const pts: Vec2[] = [this.cur, ...waypoints.map((p: any) => (Array.isArray(p) ? p : [p.x, p.y]) as Vec2)];
    const curve = catmullRom(pts, false, tension, 12);
    this.pts.push(...curve.slice(1));
    return this;
  }
  nurbsTo(controlPoints: any[], o: { weights?: number[]; degree?: number } = {}) {
    const cps: Vec2[] = [this.cur, ...controlPoints.map((p: any) => (Array.isArray(p) ? p : [p.x, p.y]) as Vec2)];
    const w = o.weights ?? cps.map(() => 1);
    const deg = Math.min(o.degree ?? 3, cps.length - 1);
    const n = cps.length;
    const knots: number[] = [];
    for (let i = 0; i <= n + deg; i++) knots.push(i <= deg ? 0 : i >= n ? 1 : (i - deg) / (n - deg));
    const N = (i: number, p: number, t: number): number => {
      if (p === 0) return (knots[i] <= t && t < knots[i + 1]) || (t === 1 && knots[i + 1] === 1 && knots[i] < 1) ? 1 : 0;
      const a = knots[i + p] - knots[i], b = knots[i + p + 1] - knots[i + 1];
      return (a ? ((t - knots[i]) / a) * N(i, p - 1, t) : 0) + (b ? ((knots[i + p + 1] - t) / b) * N(i + 1, p - 1, t) : 0);
    };
    const samples = 32;
    for (let s = 1; s <= samples; s++) {
      const t = s / samples;
      let x = 0, y = 0, ws = 0;
      for (let i = 0; i < n; i++) {
        const b = N(i, deg, t) * w[i];
        x += b * cps[i][0]; y += b * cps[i][1]; ws += b;
      }
      this.pts.push([x / (ws || 1), y / (ws || 1)]);
    }
    return this;
  }
  smoothCapTo(endX: number, endY: number, _cornerRadius: number, capRadius: number) {
    return this.arcTo(endX, endY, capRadius);
  }
  fillet(radius: number) { this.pendingFillet.push({ index: this.pts.length - 1, r: radius }); return this; }
  chamfer(distance: number) { this.pendingChamfer.push({ index: this.pts.length - 1, d: distance }); return this; }
  mirror(axis: 'x' | 'y' | Vec2) {
    const ax: Vec2 = axis === 'x' ? [1, 0] : axis === 'y' ? [0, 1] : axis;
    const l = Math.hypot(ax[0], ax[1]) || 1;
    const ux = ax[0] / l, uy = ax[1] / l;
    const refl = (p: Vec2): Vec2 => {
      const d = p[0] * ux + p[1] * uy;
      return [2 * d * ux - p[0], 2 * d * uy - p[1]];
    };
    const back = this.pts.slice(0, -1).reverse().map(refl);
    this.pts.push(...back);
    return this;
  }
  toPolyline(): Vec2[] { return this.applyCorners().map((p) => [p[0], p[1]]); }

  private applyCorners(): Vec2[] {
    let pts = this.pts.slice();
    const mods = [
      ...this.pendingFillet.map((f) => ({ index: f.index, kind: 'f' as const, v: f.r })),
      ...this.pendingChamfer.map((c) => ({ index: c.index, kind: 'c' as const, v: c.d })),
    ].sort((a, b) => b.index - a.index);
    for (const m of mods) {
      const i = m.index;
      const n = pts.length;
      const prev = pts[(i - 1 + n) % n], p = pts[i], next = pts[(i + 1) % n];
      if (!prev || !next) continue;
      const d1: Vec2 = [prev[0] - p[0], prev[1] - p[1]], d2: Vec2 = [next[0] - p[0], next[1] - p[1]];
      const l1 = Math.hypot(...d1), l2 = Math.hypot(...d2);
      const u1: Vec2 = [d1[0] / l1, d1[1] / l1], u2: Vec2 = [d2[0] / l2, d2[1] / l2];
      const ang = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
      let replacement: Vec2[];
      if (m.kind === 'c') {
        replacement = [[p[0] + u1[0] * m.v, p[1] + u1[1] * m.v], [p[0] + u2[0] * m.v, p[1] + u2[1] * m.v]];
      } else {
        const t = Math.min(m.v / Math.tan(ang / 2), l1 * 0.999, l2 * 0.999);
        const r = t * Math.tan(ang / 2);
        const a: Vec2 = [p[0] + u1[0] * t, p[1] + u1[1] * t], b: Vec2 = [p[0] + u2[0] * t, p[1] + u2[1] * t];
        const bis: Vec2 = [u1[0] + u2[0], u1[1] + u2[1]];
        const bl = Math.hypot(...bis) || 1;
        const cd = r / Math.sin(ang / 2);
        const c: Vec2 = [p[0] + (bis[0] / bl) * cd, p[1] + (bis[1] / bl) * cd];
        let a0 = Math.atan2(a[1] - c[1], a[0] - c[0]), a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
        let da = a1 - a0;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        const steps = Math.max(3, Math.ceil(Math.abs(da) / (ARC_SEG_DEG * Math.PI / 180)));
        replacement = [];
        for (let s = 0; s <= steps; s++) {
          const aa = a0 + (da * s) / steps;
          replacement.push([c[0] + r * Math.cos(aa), c[1] + r * Math.sin(aa)]);
        }
      }
      pts = [...pts.slice(0, i), ...replacement, ...pts.slice(i + 1)];
    }
    return pts;
  }

  close(): Sketch {
    const pts = this.applyCorners();
    if (pts.length < 3) throw new ForgeError('PATH.TOO_FEW_POINTS', 'a closed path needs at least 3 points');
    const last = pts[pts.length - 1], first = pts[0];
    if (Math.hypot(last[0] - first[0], last[1] - first[1]) < 1e-9) pts.pop();
    let s = polygon(pts);
    const labels = this.segLabels.map((l) => {
      const i = l.index < 0 ? this.pts.length - 1 : l.index;
      const a = this.pts[i], b = this.pts[(i + 1) % this.pts.length];
      return { name: l.name, a, b };
    });
    if (labels.length) s = new Sketch(s.cs, labels);
    return s;
  }
  closeOffset(delta: number, join: any = 'Round') { return this.close().offset(delta, join); }
  stroke(width: number, join: 'Round' | 'Square' = 'Round'): Sketch { return stroke(this.applyCorners(), width, join); }
}

export function path() { return new PathBuilder(); }

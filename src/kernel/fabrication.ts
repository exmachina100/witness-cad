// Sheet metal (bend rules, flanges, flat patterns) and laser-cut kits (panels, tab-and-slot, nesting, instructions).
import { ForgeError } from './errors';
import { Shape } from './shape';
import { ShapeGroup, group } from './ops';
import { Sketch, polygon, rect, union2d } from './sketch';
import { sketchToDxf, sketchToSvg } from './output';
import type { Vec2 } from './math';

// ---------------------------------------------------------------- sheet metal
export interface BendRule { thickness: number; bendRadius: number; kFactor: number; material?: string; gauge?: number; bendAllowance(angleDeg: number): number; bendDeduction(angleDeg: number): number }

function makeRule(o: { thickness: number; bendRadius?: number; kFactor?: number; material?: string; gauge?: number }): BendRule {
  if (!(o.thickness > 0)) throw new ForgeError('SHEETMETAL.THICKNESS', 'sheet metal needs a positive thickness');
  const t = o.thickness, r = o.bendRadius ?? t, k = o.kFactor ?? 0.44;
  const ba = (a: number) => ((a * Math.PI) / 180) * (r + k * t);
  return {
    thickness: t, bendRadius: r, kFactor: k, material: o.material, gauge: o.gauge,
    bendAllowance: ba,
    bendDeduction: (a: number) => 2 * (r + t) * Math.tan(((a * Math.PI) / 180) / 2) - ba(a),
  };
}
const GAUGES: Record<string, Record<number, number>> = {
  steel: { 7: 4.554, 8: 4.176, 9: 3.797, 10: 3.416, 11: 3.038, 12: 2.657, 13: 2.278, 14: 1.897, 16: 1.519, 18: 1.214, 20: 0.912, 22: 0.759, 24: 0.607, 26: 0.455, 28: 0.378 },
  stainless: { 10: 3.571, 11: 3.175, 12: 2.778, 14: 1.984, 16: 1.587, 18: 1.27, 20: 0.953, 22: 0.794, 24: 0.635, 26: 0.476 },
  aluminum: { 8: 3.264, 10: 2.588, 11: 2.305, 12: 2.052, 14: 1.628, 16: 1.29, 18: 1.024, 20: 0.813, 22: 0.643, 24: 0.511, 26: 0.404 },
};
export const SheetMetal = {
  rule: makeRule,
  ruleFromGauge(gauge: number, material: 'steel' | 'stainless' | 'aluminum' | string = 'steel', o: { bendRadius?: number; kFactor?: number } = {}) {
    const table = GAUGES[material.toLowerCase().replace(/aluminium/, 'aluminum')] ?? GAUGES.steel;
    const t = table[gauge];
    if (!t) throw new ForgeError('SHEETMETAL.GAUGE', `no ${material} gauge ${gauge} (have ${Object.keys(table).join(', ')})`);
    return makeRule({ thickness: t, material, gauge, ...o });
  },
  gauges: GAUGES,
};

type Edge = 'top' | 'bottom' | 'left' | 'right';
const EDGE_ROT: Record<Edge, number> = { right: 0, top: 90, left: 180, bottom: 270 };
interface Flange { edge: Edge; length: number; angle: number; bendRadius: number; name: string }

export class SheetMetalPart {
  readonly kind = 'sheetMetal';
  constructor(readonly width: number, readonly height: number, readonly rule: BendRule, readonly flanges: Flange[] = [], readonly cutouts: { sketch: Sketch; region: string }[] = [], readonly name?: string) {}
  private with(f = this.flanges, c = this.cutouts) { return new SheetMetalPart(this.width, this.height, this.rule, f, c, this.name); }
  get thickness() { return this.rule.thickness; }
  /** Add a bent flange on a base edge: flange('right', { length: 20, angle: 90 }). */
  flange(edge: Edge, o: { length: number; angle?: number; bendRadius?: number; name?: string }) {
    if (!EDGE_ROT.hasOwnProperty(edge)) throw new ForgeError('SHEETMETAL.EDGE', `edge must be one of top, bottom, left, right`);
    if (this.flanges.some((f) => f.edge === edge)) throw new ForgeError('SHEETMETAL.DUP_FLANGE', `edge "${edge}" already has a flange`);
    return this.with([...this.flanges, { edge, length: o.length, angle: o.angle ?? 90, bendRadius: o.bendRadius ?? this.rule.bendRadius, name: o.name ?? `flange-${edge}` }]);
  }
  /** Cut a 2D outline through a region ("base" or a flange name), in that region's flat coordinates. */
  cutout(sketch: Sketch, o: { region?: string } = {}) { return this.with(this.flanges, [...this.cutouts, { sketch, region: o.region ?? 'base' }]); }
  regionNames() { return ['base', ...this.flanges.map((f) => f.name)]; }
  private half(edge: Edge) { return edge === 'left' || edge === 'right' ? this.width / 2 : this.height / 2; }
  private span(edge: Edge) { return edge === 'left' || edge === 'right' ? this.height : this.width; }
  /** Flat blank with bend allowances, cutouts removed. */
  flatPattern(): Sketch {
    let s = rect(this.width, this.height);
    const pieces: Sketch[] = [s];
    for (const f of this.flanges) {
      const d = this.half(f.edge), len = this.span(f.edge);
      const ba = makeRule({ thickness: this.thickness, bendRadius: f.bendRadius, kFactor: this.rule.kFactor }).bendAllowance(f.angle);
      let strip = polygon([[d, -len / 2], [d + ba + f.length, -len / 2], [d + ba + f.length, len / 2], [d, len / 2]]);
      let cuts = this.cutouts.filter((c) => c.region === f.name).map((c) => c.sketch.translate(d + ba + f.length / 2, 0));
      if (cuts.length) strip = strip.subtract(...cuts);
      pieces.push(strip.rotateAround(EDGE_ROT[f.edge], [0, 0]));
    }
    s = union2d(pieces);
    const baseCuts = this.cutouts.filter((c) => c.region === 'base').map((c) => c.sketch);
    return baseCuts.length ? s.subtract(...baseCuts) : s;
  }
  /** Folded 3D part: base on z = 0..t with flanges bent up by their angles. */
  folded(): Shape {
    const t = this.thickness;
    let base = rect(this.width, this.height);
    const baseCuts = this.cutouts.filter((c) => c.region === 'base').map((c) => c.sketch);
    if (baseCuts.length) base = base.subtract(...baseCuts);
    const parts: Shape[] = [base.extrude(t)];
    for (const f of this.flanges) {
      const d = this.half(f.edge), len = this.span(f.edge), r = f.bendRadius;
      const a = (f.angle * Math.PI) / 180;
      const n = Math.max(4, Math.ceil(f.angle / 6));
      const inner: Vec2[] = [], outer: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const th = -Math.PI / 2 + (a * i) / n;
        inner.push([d + r * Math.cos(th), t + r + r * Math.sin(th)]);
        outer.push([d + (r + t) * Math.cos(th), t + r + (r + t) * Math.sin(th)]);
      }
      const th = -Math.PI / 2 + a, tan: Vec2 = [-Math.sin(th), Math.cos(th)];
      const ie = inner[n], oe = outer[n];
      const profile = polygon([...outer, [oe[0] + tan[0] * f.length, oe[1] + tan[1] * f.length], [ie[0] + tan[0] * f.length, ie[1] + tan[1] * f.length], ...inner.slice().reverse()]);
      let solid = profile.extrude(len).rotateX(90).translate(0, len / 2, 0);
      const cuts = this.cutouts.filter((c) => c.region === f.name);
      if (cuts.length) {
        // Cut flange holes as prisms through the flange plane.
        const mid: Vec2 = [(ie[0] + oe[0]) / 2 + tan[0] * f.length / 2, (ie[1] + oe[1]) / 2 + tan[1] * f.length / 2];
        for (const c of cuts) {
          const prism = c.sketch.rotate(90).extrude(t * 4).translate(0, 0, -t * 2) // sketch u along the flange, v along the edge
            .rotateY(90 - f.angle).translate(mid[0], 0, mid[1]);
          solid = solid.subtract(prism);
        }
      }
      parts.push(solid.rotateZ(EDGE_ROT[f.edge], { pivot: [0, 0, 0] }));
    }
    const out = parts[0].add(...parts.slice(1));
    return out.withMeta({ sheetMetal: { thickness: t, bendRadius: this.rule.bendRadius, kFactor: this.rule.kFactor, flanges: this.flanges, width: this.width, height: this.height }, sheet: { thickness: t, material: this.rule.material } });
  }
  toShape() { return this.folded(); }
  boundingBox() { return this.folded().boundingBox(); }
}

/**
 * sheetMetal({ width, height, thickness | rule, bendRadius, kFactor }) starts a sheet-metal part;
 * sheetMetal({ outline, thickness, kerf }) still returns a flat sheet solid (laser part).
 */
export function sheetMetal(o: any): any {
  if (o?.outline) return laserPart(o.outline, o);
  const rule: BendRule = o.rule ?? makeRule({ thickness: o.thickness, bendRadius: o.bendRadius, kFactor: o.kFactor, material: o.material });
  return new SheetMetalPart(o.width, o.height ?? o.depth, rule, [], [], o.name);
}

// ---------------------------------------------------------------- laser
export const COMMON_KERFS: Record<string, number> = {
  'plywood-3mm': 0.15, 'plywood-6mm': 0.2, 'mdf-3mm': 0.18, 'mdf-6mm': 0.22, 'acrylic-2mm': 0.1, 'acrylic-3mm': 0.12, 'acrylic-5mm': 0.15,
  'cardboard-3mm': 0.25, 'felt-3mm': 0.3, 'steel-1mm': 0.15, 'steel-2mm': 0.2, 'aluminum-2mm': 0.2,
};
export function lookupKerf(material: string, thickness?: number): number {
  const m = material.toLowerCase();
  if (thickness != null) { const k = COMMON_KERFS[`${m}-${thickness}mm`]; if (k != null) return k; }
  const any = Object.entries(COMMON_KERFS).filter(([k]) => k.startsWith(m + '-'));
  if (!any.length) return 0.15;
  if (thickness == null) return any[0][1];
  return any.sort((a, b) => Math.abs(parseFloat(a[0].split('-')[1]) - thickness) - Math.abs(parseFloat(b[0].split('-')[1]) - thickness))[0][1];
}

function laserPart(outline: Sketch, o: { thickness: number; material?: string; kerf?: number; name?: string; color?: string }): Shape {
  const kerf = o.kerf ?? (o.material ? lookupKerf(o.material, o.thickness) : 0);
  let s = outline.offset(kerf / 2).extrude(o.thickness).withMeta({ sheet: { thickness: o.thickness, material: o.material, kerf, outline }, manufacturing: { process: 'cut', method: 'laser', thickness: o.thickness, material: o.material } });
  if (o.name) s = s.named(o.name);
  if (o.color) s = s.color(o.color);
  return s;
}

/** Fingers/tabs along an edge of `length` and the matching slots. */
function tabSlot(o: { length: number; thickness: number; tabs?: number; tabWidth?: number; clearance?: number }) {
  const n = o.tabs ?? Math.max(1, Math.floor(o.length / (o.thickness * 6)));
  const w = o.tabWidth ?? Math.min(o.length / (2 * n), o.thickness * 3);
  const c = o.clearance ?? 0.1;
  const pitch = o.length / n;
  const centers = Array.from({ length: n }, (_, i) => -o.length / 2 + pitch * (i + 0.5));
  const tabs = union2d(centers.map((x) => rect(w, o.thickness).translate(x, o.thickness / 2)));
  const slots = union2d(centers.map((x) => rect(w + c, o.thickness + c).translate(x, 0)));
  return { tabs, slots, centers, tabWidth: w };
}

interface KitPart { name: string; shape: Shape; outline: Sketch; quantity: number; pose?: any; step?: number; note?: string }

export class LaserKit {
  readonly kind = 'laserKit';
  constructor(readonly parts: KitPart[], readonly o: { sheetWidth: number; sheetHeight: number; spacing: number; material?: string; thickness?: number }) {}
  /** Shelf-pack the flat outlines onto sheets. */
  layout() {
    const sheets: { x: number; y: number; part: string; sketch: Sketch; rotated: boolean }[][] = [[]];
    let x = 0, y = 0, rowH = 0;
    const sp = this.o.spacing, W = this.o.sheetWidth, H = this.o.sheetHeight;
    const items = this.parts.flatMap((p) => Array.from({ length: p.quantity }, (_, i) => ({ name: p.quantity > 1 ? `${p.name} ${i + 1}` : p.name, sk: p.outline })))
      .map((it) => { const b = it.sk.bounds(); const rot = b.width < b.height && b.height <= W; return { ...it, sk: rot ? it.sk.rotate(90) : it.sk, rot }; })
      .sort((a, b) => b.sk.bounds().height - a.sk.bounds().height);
    for (const it of items) {
      const b = it.sk.bounds();
      if (b.width > W || b.height > H) throw new ForgeError('LASER.PART_TOO_BIG', `part "${it.name}" (${b.width.toFixed(1)} x ${b.height.toFixed(1)}) does not fit the ${W} x ${H} sheet`);
      if (x + b.width > W) { x = 0; y += rowH + sp; rowH = 0; }
      if (y + b.height > H) { sheets.push([]); x = 0; y = 0; rowH = 0; }
      const placed = it.sk.translate(x - b.minX, y - b.minY);
      sheets[sheets.length - 1].push({ x, y, part: it.name, sketch: placed, rotated: it.rot });
      x += b.width + sp; rowH = Math.max(rowH, b.height);
    }
    return sheets;
  }
  sheetCount() { return this.layout().length; }
  sheetSketch(i = 0) { const s = this.layout()[i]; return s?.length ? union2d(s.map((p) => p.sketch)) : rect(0.001, 0.001); }
  toSvg(i = 0, o: any = {}) { return sketchToSvg(this.sheetSketch(i), { strokeWidth: 0.1, ...o }); }
  toDxf(i = 0, o: any = {}) { return sketchToDxf(this.sheetSketch(i), o); }
  bom() { return this.parts.map((p) => ({ part: p.name, quantity: p.quantity, thickness: this.o.thickness, material: this.o.material })); }
}

function instructions(kit: LaserKit, o: { title?: string } = {}) {
  const steps = kit.parts
    .map((p, i) => ({ order: p.step ?? i + 1, part: p.name, quantity: p.quantity, note: p.note }))
    .sort((a, b) => a.order - b.order)
    .map((s, i) => ({ step: i + 1, title: `Fit ${s.quantity > 1 ? `${s.quantity} x ` : ''}${s.part}`, text: s.note ?? `Press ${s.part} into its slots; tabs should sit flush.` , part: s.part }));
  return { title: o.title ?? 'Assembly instructions', sheets: kit.sheetCount(), cutList: kit.bom(), steps };
}
function formatInstructions(ins: ReturnType<typeof instructions>): string {
  const lines = [`# ${ins.title}`, '', `Sheets to cut: ${ins.sheets}`, '', '## Cut list', ...ins.cutList.map((c) => `- ${c.quantity} x ${c.part}${c.thickness ? ` (${c.thickness} mm${c.material ? ` ${c.material}` : ''})` : ''}`), '', '## Steps', ...ins.steps.map((s) => `${s.step}. ${s.title}. ${s.text}`)];
  return lines.join('\n');
}

export const Laser = {
  COMMON_KERFS,
  lookupKerf,
  sheet: (o: { outline: Sketch; thickness: number; material?: string; kerf?: number }) => laserPart(o.outline, o),
  part: (outline: Sketch, o: { thickness: number; material?: string; kerf?: number; name?: string; color?: string }) => laserPart(outline, o),
  /** Rectangular panel with optional rounded corners and holes: panel({ width, height, thickness, cornerRadius, holes: [{ x, y, d }] }). */
  panel(o: { width: number; height: number; thickness: number; cornerRadius?: number; holes?: { x: number; y: number; d: number }[]; material?: string; kerf?: number; name?: string }) {
    let s = rect(o.width, o.height);
    if (o.cornerRadius) s = s.filletCorners(o.cornerRadius);
    if (o.holes?.length) s = s.subtract(...o.holes.map((h) => polygon(Array.from({ length: 48 }, (_, i) => [h.x + (h.d / 2) * Math.cos((i * Math.PI) / 24), h.y + (h.d / 2) * Math.sin((i * Math.PI) / 24)] as Vec2))));
    return laserPart(s, o);
  },
  tabSlot,
  fingerJoint: (length: number, o: { thickness: number; fingers?: number; invert?: boolean }) => {
    const n = o.fingers ?? Math.max(3, Math.round(length / (o.thickness * 3)) | 1);
    const w = length / n;
    const parts: Sketch[] = [];
    for (let i = o.invert ? 1 : 0; i < n; i += 2) parts.push(rect(w, o.thickness).translate(-length / 2 + w * (i + 0.5), 0));
    return parts.length ? union2d(parts) : rect(0.001, 0.001);
  },
  /** Collect parts into a kit: kit({ side: shape, ... } | [{ name, shape, quantity, pose, step }], { sheetWidth, sheetHeight }). */
  kit(parts: any, o: { sheetWidth?: number; sheetHeight?: number; spacing?: number; material?: string; thickness?: number } = {}) {
    const list: KitPart[] = (Array.isArray(parts) ? parts : Object.entries(parts).map(([name, v]) => (v instanceof Shape ? { name, shape: v } : { name, ...(v as any) }))).map((p: any) => {
      const shape: Shape = p.shape ?? p.part;
      const outline: Sketch = p.outline ?? shape.meta.sheet?.outline ?? shape.project();
      return { name: p.name ?? shape.name ?? 'part', shape, outline, quantity: p.quantity ?? 1, pose: p.pose, step: p.step, note: p.note };
    });
    const thickness = o.thickness ?? list[0]?.shape.meta.sheet?.thickness;
    return new LaserKit(list, { sheetWidth: o.sheetWidth ?? 600, sheetHeight: o.sheetHeight ?? 400, spacing: o.spacing ?? 3, material: o.material ?? list[0]?.shape.meta.sheet?.material, thickness });
  },
  /** Posed 3D preview of a kit: each part moved by its `pose` (a function or transform). */
  assemblyPreview(kit: LaserKit): ShapeGroup {
    return group(kit.parts.map((p) => ({ name: p.name, shape: typeof p.pose === 'function' ? p.pose(p.shape) : p.pose ? p.shape.transform(p.pose) : p.shape })));
  },
  instructions,
  formatInstructions,
  toDxf: (s: Sketch, o?: any) => sketchToDxf(s, o),
  toSvg: (s: Sketch, o?: any) => sketchToSvg(s, o),
};

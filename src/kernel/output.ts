// bom(), dim(), Manufacturing.*, sketchToDxf / sketchToSvg.
import { ctx } from './context';
import { ForgeError } from './errors';
import { toVec3, v3, Vec3 } from './math';
import type { Sketch } from './sketch';

export function bom(quantity: number, description: string, opts: any = {}) {
  if (!Number.isFinite(quantity) || quantity < 0) throw new ForgeError('BOM.QUANTITY', 'bom quantity must be a finite number >= 0');
  if (quantity === 0) return;
  if (opts.unitPrice != null && !opts.currency) throw new ForgeError('BOM.CURRENCY', 'bom unitPrice needs a 3-letter currency code');
  if ((opts.priceSource || opts.priceDate) && opts.unitPrice == null) throw new ForgeError('BOM.PRICE', 'priceSource and priceDate need unitPrice');
  const c = ctx();
  const key = opts.key ?? `${description}|${opts.material ?? ''}|${JSON.stringify(opts.dimensions ?? '')}`;
  const existing = c.bom.find((r) => r.key === key);
  if (existing) existing.quantity += quantity;
  else c.bom.push({ quantity, description, unit: opts.unit ?? 'pieces', key, ...opts, file: c.currentFile });
}

export function bomToCsv(rows: any[]): string {
  const cols = ['quantity', 'unit', 'description', 'material', 'process', 'dimensions', 'unitPrice', 'currency', 'notes'];
  const esc = (v: any) => {
    const s = v == null ? '' : Array.isArray(v) ? v.join(' x ') : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

class Dimension {
  constructor(public rec: any) {}
  get value() { return this.rec.value; }
  get record() { return this.rec; }
  tag(t: string) { this.rec.tag = t; return this; }
  measures(n: string) { this.rec.measures = n; return this; }
  above() { this.rec.side = 'above'; return this; }
  below() { this.rec.side = 'below'; return this; }
  left() { this.rec.side = 'left'; return this; }
  right() { this.rec.side = 'right'; return this; }
}

function pointOf(x: any): Vec3 {
  if (Array.isArray(x)) return toVec3(x);
  if (x?.kind === 'face') return x.center;
  if (x?.center && typeof x.center === 'function') return x.center();
  if (x?.x != null) return [x.x, x.y, x.z ?? 0];
  throw new ForgeError('DIM.BAD_TARGET', 'cannot measure that');
}

function addDim(from: Vec3, to: Vec3, kind: string, opts: any = {}) {
  const rec = { from, to, value: v3.dist(from, to), kind, ...opts };
  ctx().dims.push(rec);
  return new Dimension(rec);
}

export const dim: any = (a: any, b?: any, c?: any) => {
  if (a?.kind === 'edge') return addDim(a.start, a.end, 'edge', b ?? {});
  if (a?.start && a?.end && !b?.kind && !Array.isArray(b)) return addDim(toVec3([a.start.x, a.start.y, 0]), toVec3([a.end.x, a.end.y, 0]), 'line', b ?? {});
  if (a?.kind === 'face' && (b == null || (typeof b === 'object' && !Array.isArray(b) && b.kind !== 'face'))) {
    const s = a.size ?? [0, 0];
    const half = v3.scale(a.uAxis, s[0] / 2);
    return addDim(v3.sub(a.center, half), v3.add(a.center, half), 'face', b ?? {});
  }
  if (a?.kind === 'face' && b?.kind === 'face') {
    const d = Math.abs(v3.dot(v3.sub(b.center, a.center), a.normal));
    if (Math.abs(Math.abs(v3.dot(a.normal, b.normal)) - 1) > 1e-3) throw new ForgeError('DIM.NOT_PARALLEL', 'faces are not parallel');
    return addDim(a.center, v3.add(a.center, v3.scale(a.normal, v3.dot(v3.sub(b.center, a.center), a.normal) >= 0 ? d : -d)), 'faces', c ?? {});
  }
  return addDim(pointOf(a), pointOf(b), 'points', c ?? {});
};
dim.radius = (face: any, opts: any = {}) => {
  if (face?.radius == null) throw new ForgeError('DIM.NOT_ROUND', 'face is not round');
  return addDim(face.center, v3.add(face.center, v3.scale(face.uAxis, face.radius)), 'radius', opts);
};
const axisDim = (k: number) => (a: any, b: any, opts: any = {}) => {
  const pa = pointOf(a), pb = pointOf(b);
  const to: Vec3 = [...pa] as Vec3;
  to[k] = pb[k];
  return addDim(pa, to, 'axis', opts);
};
dim.alongX = axisDim(0);
dim.alongY = axisDim(1);
dim.alongZ = axisDim(2);

function process(kind: string) {
  return (opts: any = {}) => {
    const rec = { process: kind, ...opts };
    return rec;
  };
}

/** Manufacturing.* returns a process descriptor; attach it with shape.withMeta({manufacturing}) or pass to bom(). */
export const Manufacturing = {
  print: process('print'),
  printResin: process('resin'),
  printPowder: process('powder'),
  machine: process('machine'),
  cut: process('cut'),
  mold: process('mold'),
  castUrethane: process('urethane'),
  other: process('other'),
  buy: process('buy'),
};

export function sketchToSvg(s: Sketch, o: any = {}): string {
  const stroke = o.stroke ?? '#000000', sw = o.strokeWidth ?? 0.1, fill = o.fill ?? 'none', pad = o.padding ?? 1;
  const b = s.bounds();
  const w = b.width + pad * 2, h = b.height + pad * 2;
  const ppu = o.pixelsPerUnit;
  const d = s.toPolygons().map((poly) => 'M' + poly.map((p) => `${(p[0] - b.minX + pad).toFixed(4)} ${(b.maxY - p[1] + pad).toFixed(4)}`).join(' L') + ' Z').join(' ');
  const size = ppu ? `width="${w * ppu}" height="${h * ppu}"` : `width="${w}mm" height="${h}mm"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 ${w} ${h}"><path d="${d}" fill="${fill}" fill-rule="evenodd" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
}

export function sketchToDxf(s: Sketch, o: any = {}): string {
  const layer = o.layer ?? '0', color = o.colorIndex ?? 7;
  const out: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  for (const poly of s.toPolygons()) {
    out.push('0', 'LWPOLYLINE', '8', layer, '62', String(color), '90', String(poly.length), '70', '1');
    for (const p of poly) out.push('10', p[0].toFixed(6), '20', p[1].toFixed(6));
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n');
}

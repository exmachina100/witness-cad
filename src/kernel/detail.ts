// Surface detail on a planar face: knurling, grooves, dimples, bumps, hex pockets and text,
// clipped to the face outline (minus a margin), embossed or debossed.
import { ForgeError } from './errors';
import { Shape, faceProfile } from './shape';
import { Sketch, rect, polygon, union2d } from './sketch';
import { text2d } from './text';
import type { Vec2 } from './math';

export type DetailKind = 'knurl' | 'grooves' | 'ribs' | 'dimples' | 'bumps' | 'hex' | 'text';
export interface DetailOptions {
  kind: DetailKind; depth?: number; height?: number; mode?: 'emboss' | 'deboss';
  spacing?: number; size?: number; angle?: number; margin?: number; text?: string; width?: number;
}

const circle = (r: number, n = 24) => polygon(Array.from({ length: n }, (_, i) => [r * Math.cos((i * 2 * Math.PI) / n), r * Math.sin((i * 2 * Math.PI) / n)] as Vec2));

function stripes(b: { minX: number; maxX: number; minY: number; maxY: number }, pitch: number, width: number, angle: number): Sketch {
  const R = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + pitch, cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const bars: Sketch[] = [];
  for (let y = -R; y <= R; y += pitch) bars.push(rect(2 * R, width).translate(0, y));
  return union2d(bars).rotateAround(angle, [0, 0]).translate(cx, cy);
}
function grid(b: { minX: number; maxX: number; minY: number; maxY: number }, pitch: number, cell: (x: number, y: number) => Sketch, hexOffset = false): Sketch {
  const cells: Sketch[] = [];
  const dy = hexOffset ? pitch * Math.sqrt(3) / 2 : pitch;
  let row = 0;
  for (let y = b.minY; y <= b.maxY + pitch; y += dy, row++) for (let x = b.minX + (hexOffset && row % 2 ? pitch / 2 : 0); x <= b.maxX + pitch; x += pitch) cells.push(cell(x, y));
  return union2d(cells);
}

export function surfaceDetail(shape: Shape, face: string, o: DetailOptions): Shape {
  const prof = faceProfile(shape, face);
  const area = prof.offset(-(o.margin ?? 1));
  if (area.isEmpty()) throw new ForgeError('DETAIL.TOO_SMALL', `face "${face}" is too small for a ${o.margin ?? 1} mm margin`);
  const b = area.bounds();
  const p = o.spacing ?? 2, ang = o.angle ?? 0;
  let pattern: Sketch;
  switch (o.kind) {
    case 'knurl': pattern = stripes(b, p, o.width ?? p * 0.45, ang + 30).add(stripes(b, p, o.width ?? p * 0.45, ang - 30)); break;
    case 'grooves': case 'ribs': pattern = stripes(b, p, o.width ?? p * 0.5, ang); break;
    case 'dimples': case 'bumps': pattern = grid(b, p, (x, y) => circle((o.size ?? p * 0.6) / 2).translate(x, y), true); break;
    case 'hex': pattern = grid(b, p, (x, y) => circle((o.size ?? p * 0.85) / 2, 6).rotate(30).translate(x, y), true); break;
    case 'text': {
      if (!o.text) throw new ForgeError('DETAIL.NO_TEXT', 'text detail needs text');
      let t = text2d(o.text, { size: o.size ?? 6, align: 'center', baseline: 'center' });
      const tb = t.bounds(), fit = Math.min(1, (b.maxX - b.minX) / (tb.width || 1), (b.maxY - b.minY) / (tb.height || 1));
      if (fit < 1) t = t.scale(fit);
      pattern = t.rotate(ang).translate((b.minX + b.maxX) / 2 - (t.bounds().minX + t.bounds().maxX) / 2, (b.minY + b.maxY) / 2 - (t.bounds().minY + t.bounds().maxY) / 2);
      break;
    }
    default: throw new ForgeError('DETAIL.KIND', `unknown detail "${(o as any).kind}" (knurl, grooves, ribs, dimples, bumps, hex, text)`);
  }
  const clipped = o.kind === 'text' ? pattern : pattern.intersect(area);
  if (clipped.isEmpty()) return shape;
  const emboss = o.mode ? o.mode === 'emboss' : o.kind === 'ribs' || o.kind === 'bumps';
  const placed = clipped.onFace(shape, face);
  const out = emboss ? shape.add(placed.extrude(o.height ?? o.depth ?? 0.6)) : shape.cutout(placed, { depth: o.depth ?? o.height ?? 0.6 });
  return out.withMeta({ surfaceDetails: [...(shape.meta.surfaceDetails ?? []), { face, ...o }] });
}

(Shape.prototype as any).surfaceDetail = function (this: Shape, face: string, o: DetailOptions) { return surfaceDetail(this, face, o); };

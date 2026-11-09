// text2d(): outlines from an OpenType font, flattened into a Sketch.
import * as opentype from 'opentype.js';
import { K } from './wasm';
import { Sketch } from './sketch';
import { ForgeError } from './errors';
import type { Vec2 } from './math';

const fonts = new Map<string, opentype.Font>();
let defaultKey: string | null = null;

export function registerFont(key: string, data: ArrayBuffer, makeDefault = false) {
  const f = opentype.parse(data);
  fonts.set(key, f);
  if (makeDefault || !defaultKey) defaultKey = key;
  return f;
}

/** loadFont(source): source is an ArrayBuffer (or a key already registered). */
export function loadFont(source: any, cacheKey?: string) {
  if (typeof source === 'string' && fonts.has(source)) return source;
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    const key = cacheKey ?? `font-${fonts.size}`;
    registerFont(key, source instanceof ArrayBuffer ? source : (source as any).buffer);
    return key;
  }
  throw new ForgeError('TEXT.FONT', 'loadFont needs font bytes (ArrayBuffer) or a registered font name');
}

function getFont(name?: string) {
  const k = name ?? defaultKey;
  const f = k ? fonts.get(k) : undefined;
  if (!f) throw new ForgeError('TEXT.NO_FONT', `font "${name ?? 'default'}" is not loaded`);
  return f;
}

function flatten(cmds: opentype.PathCommand[], tol: number): Vec2[][] {
  const loops: Vec2[][] = [];
  let cur: Vec2[] = [];
  let last: Vec2 = [0, 0];
  const steps = Math.max(4, Math.round(1 / Math.max(tol, 0.02)));
  for (const c of cmds as any[]) {
    if (c.type === 'M') { if (cur.length > 2) loops.push(cur); cur = [[c.x, -c.y]]; last = [c.x, -c.y]; }
    else if (c.type === 'L') { cur.push([c.x, -c.y]); last = [c.x, -c.y]; }
    else if (c.type === 'Q') {
      for (let i = 1; i <= steps; i++) { const t = i / steps, u = 1 - t; cur.push([u * u * last[0] + 2 * u * t * c.x1 + t * t * c.x, u * u * last[1] + 2 * u * t * -c.y1 + t * t * -c.y]); }
      last = [c.x, -c.y];
    } else if (c.type === 'C') {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        cur.push([u * u * u * last[0] + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, u * u * u * last[1] + 3 * u * u * t * -c.y1 + 3 * u * t * t * -c.y2 + t * t * t * -c.y]);
      }
      last = [c.x, -c.y];
    } else if (c.type === 'Z') { if (cur.length > 2) loops.push(cur); cur = []; }
  }
  if (cur.length > 2) loops.push(cur);
  return loops;
}

export function textWidth(content: string, o: { size?: number; letterSpacing?: number; font?: string } = {}) {
  const f = getFont(o.font);
  const size = o.size ?? 10;
  return f.getAdvanceWidth(content, size) + (o.letterSpacing ?? 0) * Math.max(0, content.length - 1);
}

export function text2d(content: string, o: { size?: number; letterSpacing?: number; align?: 'left' | 'center' | 'right'; baseline?: 'baseline' | 'center' | 'top'; font?: string; flattenTolerance?: number } = {}): Sketch {
  const f = getFont(o.font);
  const size = o.size ?? 10;
  const ls = o.letterSpacing ?? 0;
  const loops: Vec2[][] = [];
  let x = 0;
  for (const ch of content) {
    const p = f.getPath(ch, x, 0, size);
    loops.push(...flatten(p.commands, o.flattenTolerance ?? 0.1));
    x += f.getAdvanceWidth(ch, size) + ls;
  }
  const k = K();
  let cs = loops.length ? k.CrossSection.ofPolygons(loops as any, 'NonZero' as any) : k.CrossSection.square([1e-6, 1e-6]);
  // TrueType fonts wind outer contours clockwise; NonZero handles either, EvenOdd keeps counters open.
  cs = k.CrossSection.ofPolygons(loops as any, 'EvenOdd' as any);
  const b = cs.bounds();
  const w = x - ls;
  const dx = o.align === 'center' ? -w / 2 : o.align === 'right' ? -w : 0;
  const dy = o.baseline === 'center' ? -(b.min[1] + b.max[1]) / 2 : o.baseline === 'top' ? -b.max[1] : 0;
  return new Sketch(cs.translate([dx, dy]));
}

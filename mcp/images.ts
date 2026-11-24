// Procedural image assets (no image model is configured): seamless textures for materials and decals.
import { encodePng } from '../src/render/raster';

export const PROCEDURAL_KINDS = ['wood', 'brushed_metal', 'carbon_fiber', 'noise', 'checker', 'gradient', 'stripes', 'knurl'] as const;
type Kind = (typeof PROCEDURAL_KINDS)[number];
const NAMED: Record<string, string> = { red: '#c0392b', orange: '#e67e22', yellow: '#f1c40f', green: '#27ae60', blue: '#2e86de', purple: '#8e44ad', black: '#1b1b1b', white: '#f5f5f5', grey: '#8c8c8c', gray: '#8c8c8c', brown: '#7b4a26', oak: '#b98a55', walnut: '#5d3a1f', steel: '#9aa3ab', aluminum: '#c3c8cd', gold: '#d4af37', copper: '#b87333' };
const hex = (h: string) => { const m = (NAMED[h.toLowerCase()] ?? h).replace('#', ''); return [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16) || 0); };
function hash(x: number, y: number, s: number) { let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise(x: number, y: number, s: number, period: number) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, w = (t: number) => t * t * (3 - 2 * t);
  const g = (a: number, b: number) => hash(((a % period) + period) % period, ((b % period) + period) % period, s);
  const a = g(xi, yi), b = g(xi + 1, yi), c = g(xi, yi + 1), d = g(xi + 1, yi + 1);
  return a + (b - a) * w(fx) + (c - a) * w(fy) + (a - b - c + d) * w(fx) * w(fy);
}
const fbm = (x: number, y: number, s: number, p: number) => { let v = 0, amp = 0.5, f = 1; for (let o = 0; o < 5; o++) { v += amp * vnoise(x * f, y * f, s + o, p * f); amp /= 2; f *= 2; } return v; };

export function proceduralImage(o: { prompt?: string; kind?: Kind; width: number; height: number; colors?: string[]; seed?: number }) {
  const pr = (o.prompt ?? '').toLowerCase();
  const kind: Kind = o.kind ?? (PROCEDURAL_KINDS.find((k) => pr.includes(k.replace('_', ' ')) || pr.includes(k)) ?? (/wood|oak|walnut|grain/.test(pr) ? 'wood' : /metal|steel|alumin/.test(pr) ? 'brushed_metal' : /carbon/.test(pr) ? 'carbon_fiber' : /check/.test(pr) ? 'checker' : /stripe/.test(pr) ? 'stripes' : /knurl|grip/.test(pr) ? 'knurl' : /gradient|fade/.test(pr) ? 'gradient' : 'noise'));
  const words = pr.split(/[^a-z#0-9]+/).filter((w) => NAMED[w] || /^#[0-9a-f]{6}$/.test(w));
  const defaults: Record<Kind, string[]> = { wood: ['#7b4a26', '#c08a52'], brushed_metal: ['#8f979e', '#d3d8dc'], carbon_fiber: ['#111111', '#3a3a3a'], noise: ['#3a3f47', '#c9ced6'], checker: ['#222222', '#eeeeee'], gradient: ['#2e86de', '#f5f5f5'], stripes: ['#f1c40f', '#1b1b1b'], knurl: ['#5f666d', '#c3c8cd'] };
  const cols = (o.colors?.length ? o.colors : words.length ? words : defaults[kind]).map(hex);
  const A = cols[0], B = cols[1] ?? cols[0].map((v) => Math.min(255, v + 80));
  const W = o.width, H = o.height, s = o.seed ?? 1, rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H; let t: number;
    switch (kind) {
      case 'wood': { const r = (u * 8 + fbm(u * 4, v * 4, s, 4) * 3) % 1; t = 0.5 + 0.5 * Math.sin(r * Math.PI * 2 + fbm(u * 16, v * 2, s + 9, 16) * 2); t = t * 0.8 + vnoise(u * 200, v * 8, s, 200) * 0.2; break; }
      case 'brushed_metal': t = 0.4 + 0.6 * vnoise(u * 2, v * 400, s, 400) * 0.6 + 0.4 * vnoise(u * 8, v * 1200, s + 3, 1200) * 0.4; break;
      case 'carbon_fiber': { const cx = Math.floor(u * 16), cy = Math.floor(v * 16), fx = (u * 16) % 1, fy = (v * 16) % 1; const weave = (cx + cy) % 2 ? Math.sin(fx * Math.PI) : Math.sin(fy * Math.PI); t = 0.25 + 0.75 * weave * weave; break; }
      case 'checker': t = (Math.floor(u * 8) + Math.floor(v * 8)) % 2; break;
      case 'gradient': t = v; break;
      case 'stripes': t = Math.floor((u + v) * 10) % 2; break;
      case 'knurl': { const a = Math.abs(Math.sin((u + v) * Math.PI * 24)), b = Math.abs(Math.sin((u - v) * Math.PI * 24)); t = Math.min(a, b); break; }
      default: t = fbm(u * 8, v * 8, s, 8);
    }
    for (let k = 0; k < 3; k++) rgb[(y * W + x) * 3 + k] = Math.round(A[k] + (B[k] - A[k]) * Math.max(0, Math.min(1, t)));
  }
  return { kind, width: W, height: H, png: encodePng(rgb, W, H) };
}

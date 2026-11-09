// Headless software renderer: z-buffered, flat-shaded PNG of a build result (used by the MCP server and CLI).
import { zlibSync } from 'fflate';
import type { RunResult } from '../kernel/runtime';
import { worldMeshes } from '../export/mesh';

export type RenderView = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
const DIRS: Record<RenderView, [number, number, number]> = {
  iso: [1, -1.2, 0.9], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 0, 1], bottom: [0, 0, -1],
};
const norm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function renderPng(result: RunResult, o: { width?: number; height?: number; view?: RenderView; transforms?: Record<string, number[]>; background?: [number, number, number] } = {}): Uint8Array {
  const W = o.width ?? 800, H = o.height ?? 560;
  const bg = o.background ?? [24, 29, 36];
  const meshes = worldMeshes(result.objects, { transforms: o.transforms });
  const color = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { const g = 1 - (Math.floor(i / W) / H) * 0.25; color[i * 3] = bg[0] * g; color[i * 3 + 1] = bg[1] * g; color[i * 3 + 2] = bg[2] * g; }
  const depth = new Float32Array(W * H).fill(Infinity);

  // camera basis: looking along -d, Z up (Y up for top/bottom views)
  const d = norm(DIRS[o.view ?? 'iso']);
  const upHint = Math.abs(d[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1];
  const right = norm(cross(upHint, d)), up = cross(d, right);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const m of meshes) for (let i = 0; i < m.positions.length; i += 3) {
    const p = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
    const x = dot(p, right), y = dot(p, up);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return encodePng(color, W, H);
  const scale = 0.86 * Math.min(W / Math.max(1e-6, maxX - minX), H / Math.max(1e-6, maxY - minY));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const light = norm([d[0] + 0.4, d[1] - 0.3, d[2] + 0.8]);

  for (const m of meshes) {
    const P = m.positions, I = m.indices;
    const sx = new Float32Array(P.length / 3), sy = new Float32Array(P.length / 3), sz = new Float32Array(P.length / 3);
    for (let v = 0; v < P.length / 3; v++) {
      const p = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
      sx[v] = W / 2 + (dot(p, right) - cx) * scale;
      sy[v] = H / 2 - (dot(p, up) - cy) * scale;
      sz[v] = -dot(p, d);
    }
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
      const e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
      const n = norm(cross(e1, e2));
      if (dot(n, d) < -1e-6) continue; // back face
      const shade = 0.35 + 0.65 * Math.max(0, dot(n, light));
      const r = Math.min(255, m.color[0] * 255 * shade + 8), g = Math.min(255, m.color[1] * 255 * shade + 8), bl = Math.min(255, m.color[2] * 255 * shade + 8);
      const x0 = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c]))), x1 = Math.min(W - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
      const y0 = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c]))), y1 = Math.min(H - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
      const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a]);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((sx[b] - px) * (sy[c] - py) - (sx[c] - px) * (sy[b] - py)) / area;
        const w1 = ((sx[c] - px) * (sy[a] - py) - (sx[a] - px) * (sy[c] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const z = w0 * sz[a] + w1 * sz[b] + w2 * sz[c];
        const k = y * W + x;
        if (z >= depth[k]) continue;
        depth[k] = z;
        color[k * 3] = r; color[k * 3 + 1] = g; color[k * 3 + 2] = bl;
      }
    }
  }
  // silhouette / crease outline from depth discontinuities
  const out = color.slice();
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const k = y * W + x, z = depth[k];
    const zs = [depth[k - 1], depth[k + 1], depth[k - W], depth[k + W]];
    const edge = zs.some((n) => (Number.isFinite(z) !== Number.isFinite(n)) || (Number.isFinite(z) && Math.abs(n - z) * scale > 6));
    if (edge && Number.isFinite(z)) { out[k * 3] *= 0.35; out[k * 3 + 1] *= 0.35; out[k * 3 + 2] *= 0.35; }
  }
  return encodePng(out, W, H);
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf: Uint8Array) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export function encodePng(rgb: Uint8Array, W: number, H: number): Uint8Array {
  const raw = new Uint8Array((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; raw.set(rgb.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1); }
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W); dv.setUint32(4, H); ihdr[8] = 8; ihdr[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

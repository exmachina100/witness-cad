// 2D part drawings: orthographic projections (front, top, right) and a BOM table as SVG.
import type { RunResult } from '../kernel/runtime';
import { worldMeshes } from './mesh';
import { escapeXml } from './formats';

type View = { name: string; axes: [number, number]; flip: [number, number]; depth: number; dir: 1 | -1 };
const VIEWS: View[] = [
  { name: 'Front', axes: [0, 2], flip: [1, 1], depth: 1, dir: 1 },
  { name: 'Top', axes: [0, 1], flip: [1, 1], depth: 2, dir: -1 },
  { name: 'Right', axes: [1, 2], flip: [1, 1], depth: 0, dir: -1 },
];

/** Silhouette + feature-edge projection of all solids. */
export function toDrawingSvg(result: RunResult, opts: { title?: string; transforms?: Record<string, number[]> } = {}): string {
  const meshes = worldMeshes(result.objects, { transforms: opts.transforms });
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], m.positions[i + k]); max[k] = Math.max(max[k], m.positions[i + k]); }
  if (!meshes.length) return '<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="148mm"/>';
  const size = max.map((v, i) => v - min[i]);
  const gap = Math.max(...size) * 0.25 + 10;
  const W = size[0] + size[1] + gap * 3, H = size[2] + size[1] + gap * 3 + 30;
  const paths: string[] = [];
  const place: Record<string, [number, number]> = {
    Front: [gap, gap + size[1] + gap], Top: [gap, gap], Right: [gap + size[0] + gap, gap + size[1] + gap],
  };
  for (const v of VIEWS) {
    const [ox, oy] = place[v.name];
    const [a, b] = v.axes;
    const segs: string[] = [];
    for (const m of meshes) {
      // feature edges: edges whose adjacent face normals differ, or silhouette edges for this view
      const edges = new Map<string, { i: number; j: number; n: number[][] }>();
      const p = m.positions;
      const key = (i: number) => `${p[i * 3].toFixed(4)},${p[i * 3 + 1].toFixed(4)},${p[i * 3 + 2].toFixed(4)}`;
      for (let t = 0; t < m.indices.length; t += 3) {
        const ids = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
        const A = ids.map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
        const u = [A[1][0] - A[0][0], A[1][1] - A[0][1], A[1][2] - A[0][2]], w = [A[2][0] - A[0][0], A[2][1] - A[0][1], A[2][2] - A[0][2]];
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        const nn = [n[0] / l, n[1] / l, n[2] / l];
        for (let e = 0; e < 3; e++) {
          const i = ids[e], j = ids[(e + 1) % 3];
          const k1 = key(i), k2 = key(j);
          const k = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
          const rec = edges.get(k) ?? { i, j, n: [] };
          rec.n.push(nn);
          edges.set(k, rec);
        }
      }
      for (const e of edges.values()) {
        let draw = e.n.length < 2;
        if (!draw) {
          const [n1, n2] = e.n;
          const dot = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
          const facing1 = n1[v.depth] * v.dir, facing2 = n2[v.depth] * v.dir;
          draw = dot < 0.94 || Math.sign(facing1) !== Math.sign(facing2);
          if (facing1 < -1e-6 && facing2 < -1e-6) draw = false; // back faces only
        }
        if (!draw) continue;
        const x1 = ox + (p[e.i * 3 + a] - min[a]), y1 = oy + (max[b] - p[e.i * 3 + b]);
        const x2 = ox + (p[e.j * 3 + a] - min[a]), y2 = oy + (max[b] - p[e.j * 3 + b]);
        segs.push(`M${x1.toFixed(3)} ${y1.toFixed(3)}L${x2.toFixed(3)} ${y2.toFixed(3)}`);
      }
    }
    paths.push(`<g><path d="${segs.join('')}" stroke="#111" stroke-width="0.25" fill="none"/><text x="${ox}" y="${oy - 2}" font-size="4" font-family="sans-serif">${v.name}</text></g>`);
  }
  // overall dimensions
  const dimText = `Overall ${size[0].toFixed(1)} × ${size[1].toFixed(1)} × ${size[2].toFixed(1)} mm`;
  const bomRows = result.bom.slice(0, 12).map((r, i) => `<text x="${gap + size[0] + gap}" y="${gap + 6 + i * 5}" font-size="3.5" font-family="sans-serif">${r.quantity} × ${escapeXml(r.description)}${r.material ? ` (${escapeXml(r.material)})` : ''}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(1)}mm" height="${H.toFixed(1)}mm" viewBox="0 0 ${W.toFixed(2)} ${H.toFixed(2)}"><rect width="100%" height="100%" fill="#fff"/>${paths.join('')}${bomRows.join('')}<text x="${gap}" y="${H - 12}" font-size="4.5" font-family="sans-serif" font-weight="bold">${escapeXml(opts.title ?? 'Witness CAD drawing')}</text><text x="${gap}" y="${H - 6}" font-size="3.5" font-family="sans-serif">${dimText} · units mm · third-angle projection</text></svg>`;
}

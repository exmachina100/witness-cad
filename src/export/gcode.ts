// A small FDM slicer: layers from Manifold slices, perimeter walls, solid top/bottom skins and
// rectilinear sparse infill, written as Marlin-flavoured G-code (absolute XYZ, absolute E).
import { K } from '../kernel/wasm';
import type { ExportMesh } from './mesh';

export interface GcodeOptions {
  layerHeight?: number; lineWidth?: number; walls?: number; infill?: number; topBottomLayers?: number;
  nozzleTemp?: number; bedTemp?: number; printSpeed?: number; travelSpeed?: number; filamentDiameter?: number;
  bedCenter?: [number, number]; retract?: number; firstLayerSpeed?: number;
}
type P2 = [number, number];

export function toGcode(meshes: ExportMesh[], o: GcodeOptions = {}): string {
  const k = K();
  const h = o.layerHeight ?? 0.2, w = o.lineWidth ?? 0.45, walls = o.walls ?? 2, density = Math.max(0, Math.min(1, o.infill ?? 0.2));
  const skins = o.topBottomLayers ?? 4, fd = o.filamentDiameter ?? 1.75, center = o.bedCenter ?? [110, 110];
  const speed = (o.printSpeed ?? 50) * 60, travel = (o.travelSpeed ?? 150) * 60, first = (o.firstLayerSpeed ?? 20) * 60, retract = o.retract ?? 0.8;
  let solid = k.Manifold.union(meshes.map((m) => { const mesh = new k.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices }); mesh.merge(); return new k.Manifold(mesh); }));
  const bb = solid.boundingBox();
  solid = solid.translate([center[0] - (bb.min[0] + bb.max[0]) / 2, center[1] - (bb.min[1] + bb.max[1]) / 2, -bb.min[2]]);
  const height = bb.max[2] - bb.min[2];
  const nLayers = Math.max(1, Math.floor(height / h + 1e-6));
  const slices = Array.from({ length: nLayers }, (_, i) => solid.slice(Math.min(height - 1e-4, (i + 0.5) * h)));
  const ePerMm = (w * h) / (Math.PI * (fd / 2) ** 2);

  const out: string[] = [];
  let E = 0, X = 0, Y = 0, filament = 0, moves = 0;
  const fmt = (v: number) => v.toFixed(3).replace(/\.?0+$/, '');
  const travelTo = (p: P2) => {
    const d = Math.hypot(p[0] - X, p[1] - Y);
    if (d < 1e-6) return;
    if (d > 2 && retract) { E -= retract; out.push(`G1 E${fmt(E)} F2400`); }
    out.push(`G0 X${fmt(p[0])} Y${fmt(p[1])} F${travel}`);
    if (d > 2 && retract) { E += retract; out.push(`G1 E${fmt(E)} F2400`); }
    X = p[0]; Y = p[1];
  };
  const extrudeTo = (p: P2, f: number) => {
    const d = Math.hypot(p[0] - X, p[1] - Y);
    if (d < 1e-6) return;
    E += d * ePerMm; filament += d * ePerMm; moves++;
    out.push(`G1 X${fmt(p[0])} Y${fmt(p[1])} E${fmt(E)} F${f}`);
    X = p[0]; Y = p[1];
  };
  const loop = (poly: P2[], f: number) => { if (poly.length < 3) return; travelTo(poly[0]); for (const p of poly.slice(1)) extrudeTo(p, f); extrudeTo(poly[0], f); };
  const lines = (polys: P2[][], spacing: number, angleDeg: number, f: number) => {
    if (!polys.length) return;
    const a = (angleDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const rot = (p: P2): P2 => [p[0] * c + p[1] * s, -p[0] * s + p[1] * c], back = (p: P2): P2 => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
    const rp = polys.map((poly) => poly.map(rot));
    const ys = rp.flat().map((p) => p[1]);
    const y0 = Math.ceil(Math.min(...ys) / spacing) * spacing, y1 = Math.max(...ys);
    let flip = false;
    for (let y = y0; y <= y1; y += spacing) {
      const xs: number[] = [];
      for (const poly of rp) for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        if ((p[1] <= y && q[1] > y) || (q[1] <= y && p[1] > y)) xs.push(p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]));
      }
      xs.sort((m, n) => m - n);
      const segs: [P2, P2][] = [];
      for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > w * 0.5) segs.push([[xs[i], y], [xs[i + 1], y]]);
      if (flip) segs.reverse();
      for (const [p, q] of segs) { const [A, B] = flip ? [q, p] : [p, q]; travelTo(back(A)); extrudeTo(back(B), f); }
      flip = !flip;
    }
  };

  out.push('; Witness CAD G-code', `; layers ${nLayers} x ${h} mm, line width ${w} mm, ${walls} walls, ${Math.round(density * 100)}% infill`,
    'G21 ; mm', 'G90 ; absolute XYZ', 'M82 ; absolute E', `M140 S${o.bedTemp ?? 60}`, `M104 S${o.nozzleTemp ?? 210}`, `M190 S${o.bedTemp ?? 60}`, `M109 S${o.nozzleTemp ?? 210}`,
    'G28 ; home', 'G92 E0', 'G1 Z5 F3000', 'M106 S0');
  for (let i = 0; i < nLayers; i++) {
    const z = (i + 1) * h, f = i === 0 ? first : speed;
    out.push(`; LAYER ${i}`, `G1 Z${fmt(z)} F1200`);
    if (i === 1) out.push('M106 S255');
    const cs = slices[i];
    if (cs.isEmpty()) continue;
    for (let wi = 0; wi < walls; wi++) {
      const ring = cs.offset(-w * (wi + 0.5), 'Round' as any, 2, 24);
      for (const poly of ring.toPolygons() as P2[][]) loop(poly, f);
    }
    const inner = cs.offset(-w * walls, 'Round' as any, 2, 24);
    if (inner.isEmpty()) continue;
    // Solid where the region is not covered by every layer within `skins` above and below.
    let core = inner;
    for (let d = 1; d <= skins; d++) {
      const lo = i - d, hi = i + d;
      if (lo < 0 || hi >= nLayers) { core = inner.subtract(inner); break; }
      core = core.intersect(slices[lo]).intersect(slices[hi]);
    }
    const skin = inner.subtract(core);
    lines(skin.toPolygons() as P2[][], w, i % 2 ? 45 : -45, f);
    if (density > 0 && !core.isEmpty()) lines(core.toPolygons() as P2[][], w / density, i % 2 ? 45 : -45, f);
  }
  out.push('M106 S0', 'M104 S0', 'M140 S0', `G1 Z${fmt(Math.min(height + 10, height * 1.1 + 10))} F3000`, 'G28 X Y', 'M84',
    `; filament used: ${(filament / 1000).toFixed(3)} m, ${moves} extrusion moves`);
  return out.join('\n') + '\n';
}

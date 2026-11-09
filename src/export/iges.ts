// IGES 5.3 export: each triangle becomes a bilinear B-spline surface patch (entity 128), in millimetres.
// Faceted, like the STL, but readable by CAD tools that do not take meshes.
import type { ExportMesh } from './mesh';
import { weld } from './weld';

const num = (v: number) => { const s = (Math.abs(v) < 1e-12 ? 0 : v).toPrecision(12).replace(/\.?0+(e|$)/, '$1'); return s.includes('.') || s.includes('e') ? s : s + '.'; };
const holl = (s: string) => `${s.length}H${s}`;

export function toIges(meshes: ExportMesh[], name = 'witness_model'): string {
  const start = [`Witness CAD IGES export: ${name}`];
  const now = new Date(), d = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${d(now.getUTCMonth() + 1)}${d(now.getUTCDate())}.${d(now.getUTCHours())}${d(now.getUTCMinutes())}${d(now.getUTCSeconds())}`;
  let maxCoord = 1;
  const tris: [number[], number[], number[]][] = [];
  for (const m of meshes) {
    const { pos, tri } = weld(m);
    for (let i = 0; i < tri.length; i += 3) {
      const p = [tri[i], tri[i + 1], tri[i + 2]].map((k) => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]]);
      for (const q of p) maxCoord = Math.max(maxCoord, ...q.map(Math.abs));
      tris.push(p as any);
    }
  }
  const global = [',', ';', name, `${name}.igs`, 'Witness CAD', '1.0', '32', '38', '6', '308', '15', name, '1.0', '2', 'MM', '1', '0.0', stamp, '1e-06', num(maxCoord), 'Witness CAD', 'Witness CAD', '11', '0', stamp];
  const gParams = global.map((g, i) => (i < 2 ? holl(g) : /^[\d.e+-]+$/.test(g) && i !== 4 && i !== 17 && i !== 24 ? g : holl(g)));
  const gText = gParams.join(',') + ';';

  const D: string[] = [], P: string[] = [];
  const pad = (s: string | number, n = 8) => String(s).padStart(n, ' ');
  tris.forEach(([a, b, c], idx) => {
    const de = idx * 2 + 1;
    const ctrl = [a, b, c, c];
    const params = ['128', '1', '1', '1', '1', '0', '0', '1', '0', '0', '0.', '0.', '1.', '1.', '0.', '0.', '1.', '1.', '1.', '1.', '1.', '1.', ...ctrl.flatMap((p) => p.map(num)), '0.', '1.', '0.', '1.'];
    const first = P.length + 1;
    let line = '';
    const lines: string[] = [];
    params.forEach((v, i) => {
      const tok = v + (i === params.length - 1 ? ';' : ',');
      if (line.length + tok.length > 64) { lines.push(line); line = ''; }
      line += tok;
    });
    if (line) lines.push(line);
    for (const l of lines) P.push(l.padEnd(64, ' ') + ' ' + pad(de, 7) + 'P' + pad(P.length + 1, 7));
    D.push(pad(128) + pad(first) + pad(0) + pad(0) + pad(0) + pad(0) + pad(0) + pad(0) + '00000000' + 'D' + pad(de, 7));
    D.push(pad(128) + pad(0) + pad(0) + pad(lines.length) + pad(0) + pad('') + pad('') + pad('') + pad(0) + 'D' + pad(de + 1, 7));
  });
  const sec = (txt: string[], ch: string) => txt.map((l, i) => l.padEnd(72, ' ') + ch + pad(i + 1, 7));
  const G: string[] = [];
  for (let i = 0; i < gText.length; i += 72) G.push(gText.slice(i, i + 72));
  const out = [...sec(start, 'S'), ...sec(G, 'G'), ...D, ...P];
  out.push(`S${pad(start.length, 7)}G${pad(G.length, 7)}D${pad(D.length, 7)}P${pad(P.length, 7)}`.padEnd(72, ' ') + 'T' + pad(1, 7));
  return out.join('\n') + '\n';
}

// Minimal PDF writer: A4 pages with Helvetica text, filled rectangles and RGB images (Flate).
import { zlibSync, strToU8 } from 'fflate';
const L = (s: string) => strToU8(s, true); // latin-1 (WinAnsi) bytes

export type PdfOp =
  | { t: 'text'; x: number; y: number; size: number; text: string; bold?: boolean; color?: [number, number, number] }
  | { t: 'rect'; x: number; y: number; w: number; h: number; color: [number, number, number] }
  | { t: 'image'; x: number; y: number; w: number; h: number; rgb: Uint8Array; width: number; height: number };
export interface PdfPage { ops: PdfOp[] }

export const A4 = { w: 595.28, h: 841.89 };
const esc = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, (c) => ({ '—': '-', '–': '-', '’': "'", '‘': "'", '“': '"', '”': '"', '°': '\xb0', '…': '...' } as any)[c] ?? '?')
  .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const n = (x: number) => (Math.round(x * 100) / 100).toString();

/** Greedy word wrap for Helvetica at a given size (average glyph width 0.5 em). */
export function wrap(text: string, size: number, width: number): string[] {
  const max = Math.max(8, Math.floor(width / (size * 0.5)));
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if ((line + ' ' + w).trim().length > max && line) { out.push(line); line = w; } else line = (line + ' ' + w).trim();
    }
    out.push(line);
  }
  return out;
}

export function writePdf(pages: PdfPage[], info: { title?: string } = {}): Uint8Array {
  const objs: (Uint8Array | string)[] = [];
  const add = (o: Uint8Array | string) => { objs.push(o); return objs.length; };
  const fontR = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pagesId = objs.length + 1; objs.push(''); // placeholder
  const kids: number[] = [];
  const bin = (head: string, body: Uint8Array) => { const h = L(head + '\nstream\n'), t = L('\nendstream'); const u = new Uint8Array(h.length + body.length + t.length); u.set(h); u.set(body, h.length); u.set(t, h.length + body.length); return u; };
  for (const p of pages) {
    const xobj: string[] = [];
    let cs = '';
    for (const op of p.ops) {
      if (op.t === 'rect') cs += `${op.color.map((c) => n(c / 255)).join(' ')} rg ${n(op.x)} ${n(op.y)} ${n(op.w)} ${n(op.h)} re f\n`;
      else if (op.t === 'text') cs += `BT /${op.bold ? 'F2' : 'F1'} ${n(op.size)} Tf ${(op.color ?? [20, 24, 30]).map((c) => n(c / 255)).join(' ')} rg ${n(op.x)} ${n(op.y)} Td (${esc(op.text)}) Tj ET\n`;
      else {
        const data = zlibSync(op.rgb, { level: 6 });
        const id = add(bin(`<< /Type /XObject /Subtype /Image /Width ${op.width} /Height ${op.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>`, data));
        const nm = `Im${xobj.length + 1}`; xobj.push(`/${nm} ${id} 0 R`);
        cs += `q ${n(op.w)} 0 0 ${n(op.h)} ${n(op.x)} ${n(op.y)} cm /${nm} Do Q\n`;
      }
    }
    const content = zlibSync(L(cs));
    const cid = add(bin(`<< /Length ${content.length} /Filter /FlateDecode >>`, content));
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(A4.w)} ${n(A4.h)}] /Resources << /Font << /F1 ${fontR} 0 R /F2 ${fontB} 0 R >> /XObject << ${xobj.join(' ')} >> >> /Contents ${cid} 0 R >>`));
  }
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const infoId = add(`<< /Title (${esc(info.title ?? 'Document')}) /Producer (Witness CAD) >>`);
  const chunks: Uint8Array[] = [L('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let off = chunks[0].length; const xref: number[] = [];
  objs.forEach((o, i) => {
    xref.push(off);
    const head = L(`${i + 1} 0 obj\n`), body = typeof o === 'string' ? L(o) : o, tail = L('\nendobj\n');
    chunks.push(head, body, tail); off += head.length + body.length + tail.length;
  });
  const xs = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${xref.map((x) => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R >>\nstartxref\n${off}\n%%EOF\n`;
  chunks.push(L(xs));
  const total = chunks.reduce((s, c) => s + c.length, 0), out = new Uint8Array(total);
  let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

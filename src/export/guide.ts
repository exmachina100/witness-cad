// Build guide (instructions.pdf): cover, instruction pages, then one page per assembly step
// showing what is already in place with the moving parts in orange, pulled out along their step.
import type { RunResult, SceneObject } from '../kernel/runtime';
import { checkAssemblySteps } from '../kernel/assembly-steps';
import { renderRgb } from '../render/raster';
import { mat4 } from '../kernel/math';
import { A4, PdfOp, PdfPage, wrap, writePdf } from './pdf';

const ORANGE = '#ff8a1f';
const pic = (objects: SceneObject[], w = 1000, h = 700) => renderRgb({ objects } as unknown as RunResult, { width: w, height: h, view: 'iso', background: [246, 247, 249] });

function textBlock(ops: PdfOp[], text: string, x: number, y: number, size: number, width: number, bold = false): number {
  for (const line of wrap(text, size, width)) { ops.push({ t: 'text', x, y, size, text: line, bold }); y -= size * 1.4; }
  return y;
}
const header = (ops: PdfOp[], title: string, page: number, total: number) => {
  ops.push({ t: 'rect', x: 0, y: A4.h - 6, w: A4.w, h: 6, color: [255, 138, 31] });
  ops.push({ t: 'text', x: 40, y: 28, size: 9, text: `${title}  ·  page ${page} of ${total}`, color: [120, 126, 134] });
};

/** Returns null when the model has no assembly steps (a model with no steps gets no guide). */
export function buildGuidePdf(result: RunResult, o: { title?: string } = {}): Uint8Array | null {
  const chk = checkAssemblySteps(result);
  const steps = chk.steps;
  if (!steps.length) return null;
  const title = o.title ?? 'Build guide';
  const solids = result.objects.filter((x) => x.kind === 'solid' && x.mesh && !x.mock);
  const pagesInfo = result.assemblySteps?.pages ?? [];
  const total = 1 + pagesInfo.length + steps.length;
  const pages: PdfPage[] = [];
  const imgW = A4.w - 80, imgH = imgW * 0.7;

  // cover
  {
    const ops: PdfOp[] = [];
    ops.push({ t: 'text', x: 40, y: A4.h - 80, size: 28, text: title, bold: true });
    ops.push({ t: 'text', x: 40, y: A4.h - 108, size: 12, text: `${steps.length} step${steps.length === 1 ? '' : 's'}  ·  ${solids.length} part${solids.length === 1 ? '' : 's'}  ·  base: ${(result.assemblySteps?.base ?? []).join(', ') || 'none'}`, color: [90, 96, 104] });
    const p = pic(solids);
    ops.push({ t: 'image', x: 40, y: A4.h - 140 - imgH, w: imgW, h: imgH, rgb: p.rgb, width: p.width, height: p.height });
    let y = A4.h - 170 - imgH;
    ops.push({ t: 'text', x: 40, y, size: 13, text: 'Steps', bold: true }); y -= 20;
    for (const s of steps) { if (y < 60) break; y = textBlock(ops, `${s.index}. ${s.title}`, 52, y, 10.5, A4.w - 100); }
    const errs = chk.diagnostics.filter((d) => d.severity === 'error');
    if (errs.length && y > 80) { y -= 8; ops.push({ t: 'text', x: 40, y, size: 10, text: `Warning: ${errs.length} step(s) pass through placed parts (see check_assembly).`, color: [190, 40, 40] }); }
    header(ops, title, 1, total);
    pages.push({ ops });
  }
  // instruction pages
  pagesInfo.forEach((pg, i) => {
    const ops: PdfOp[] = [];
    ops.push({ t: 'text', x: 40, y: A4.h - 80, size: 20, text: pg.title, bold: true });
    textBlock(ops, pg.text, 40, A4.h - 115, 11.5, A4.w - 80);
    header(ops, title, 2 + i, total);
    pages.push({ ops });
  });
  // step pages
  const offs = Object.fromEntries(result.objects.map((x) => [x.id, x.stepExplode ?? [0, 0, 0]]));
  const placedBefore = new Set<string>(result.objects.filter((x) => !steps.some((s) => s.objectIds.includes(x.id))).map((x) => x.id));
  for (const s of steps) {
    const moving = new Set(s.objectIds);
    // Parts placed so far stay home; moving parts are drawn pulled out along their direction (60 % explode).
    const view = solids.filter((x) => placedBefore.has(x.id) || moving.has(x.id)).map((x) => {
      if (!moving.has(x.id)) return x;
      const e = offs[x.id], T = mat4.mul(mat4.translation(e[0] * 0.6, e[1] * 0.6, e[2] * 0.6), x.transform ?? mat4.identity());
      return { ...x, color: ORANGE, transform: T };
    });
    const ops: PdfOp[] = [];
    ops.push({ t: 'text', x: 40, y: A4.h - 70, size: 11, text: `Step ${s.index} of ${steps.length}`, color: [255, 138, 31], bold: true });
    ops.push({ t: 'text', x: 40, y: A4.h - 96, size: 20, text: s.title, bold: true });
    const p = pic(view);
    ops.push({ t: 'image', x: 40, y: A4.h - 120 - imgH, w: imgW, h: imgH, rgb: p.rgb, width: p.width, height: p.height });
    let y = A4.h - 150 - imgH;
    y = textBlock(ops, `Parts: ${s.parts.join(', ')}`, 40, y, 11, A4.w - 80);
    y = textBlock(ops, `Move in along [${s.direction.map((v) => -(+v.toFixed(2)) + 0).join(', ')}]${s.kind === 'subAssembly' ? ' as one sub-assembly' : ''}.`, 40, y - 4, 11, A4.w - 80);
    if (s.note) textBlock(ops, s.note, 40, y - 8, 12, A4.w - 80);
    const bad = chk.diagnostics.find((d) => d.step === s.index && d.code === 'ASSEMBLY.STEP.PASSES_THROUGH');
    if (bad) ops.push({ t: 'text', x: 40, y: 60, size: 10, text: `Check: this step passes through ${bad.obstacles?.join(', ')}.`, color: [190, 40, 40] });
    header(ops, title, 1 + pagesInfo.length + s.index, total);
    pages.push({ ops });
    for (const id of moving) placedBefore.add(id);
  }
  return writePdf(pages, { title });
}

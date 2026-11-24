// Turntable animation of a built model as an animated GIF (headless, no browser needed).
import * as gifNs from 'gifenc';
import type { RunResult } from '../kernel/runtime';
import { renderRgb, RenderOpts } from './raster';

const gif: any = (gifNs as any).GIFEncoder ? gifNs : (gifNs as any).default;

export function renderTurntableGif(result: RunResult, o: RenderOpts & { frames?: number; elevation?: number; fps?: number; holdFrames?: number } = {}): Uint8Array {
  const n = Math.max(4, Math.min(120, o.frames ?? 36)), el = ((o.elevation ?? 25) * Math.PI) / 180, delay = Math.round(1000 / (o.fps ?? 15));
  const enc = gif.GIFEncoder();
  let palette: number[][] | null = null;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const { rgb, width, height } = renderRgb(result, { ...o, direction: [Math.cos(a) * Math.cos(el), Math.sin(a) * Math.cos(el), Math.sin(el)] });
    const rgba = new Uint8Array(width * height * 4);
    for (let p = 0; p < width * height; p++) { rgba[p * 4] = rgb[p * 3]; rgba[p * 4 + 1] = rgb[p * 3 + 1]; rgba[p * 4 + 2] = rgb[p * 3 + 2]; rgba[p * 4 + 3] = 255; }
    if (!palette) palette = gif.quantize(rgba, 256);
    const index = gif.applyPalette(rgba, palette);
    enc.writeFrame(index, width, height, { palette: i === 0 ? palette : undefined, delay: i === 0 && o.holdFrames ? delay * (1 + o.holdFrames) : delay, repeat: 0 });
  }
  enc.finish();
  return enc.bytes();
}

/** Build-up animation: parts fly in along their assembly steps, wave by wave, moving parts in orange. */
export function renderBuildUpGif(result: RunResult, waves: number[][], steps: { index: number; objectIds: string[] }[], o: RenderOpts & { framesPerWave?: number; fps?: number; follow?: boolean } = {}): Uint8Array {
  const per = Math.max(2, Math.min(30, o.framesPerWave ?? 10)), delay = Math.round(1000 / (o.fps ?? 12));
  const solids = result.objects.filter((x) => x.kind === 'solid' && x.mesh && !x.mock);
  const off = (id: string) => solids.find((x) => x.id === id)?.stepExplode ?? [0, 0, 0];
  // frame everything at full explode so the camera stays still
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const x of solids) { const b = x.stats?.bbox; if (!b) continue; const e = x.stepExplode ?? [0, 0, 0]; for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b.min[k], b.min[k] + e[k]); mx[k] = Math.max(mx[k], b.max[k], b.max[k] + e[k]); } }
  const stepOf = new Map<string, number>(); for (const s of steps) for (const id of s.objectIds) stepOf.set(id, s.index);
  const waveOf = (id: string) => { const st = stepOf.get(id); return st == null ? -1 : waves.findIndex((w) => w.includes(st)); };
  const enc = gif.GIFEncoder();
  let palette: number[][] | null = null, frame = 0;
  const emit = (objects: any[]) => {
    const { rgb, width, height } = renderRgb({ objects } as any, { ...o, bounds: { min: mn, max: mx } });
    const rgba = new Uint8Array(width * height * 4);
    for (let p = 0; p < width * height; p++) { rgba[p * 4] = rgb[p * 3]; rgba[p * 4 + 1] = rgb[p * 3 + 1]; rgba[p * 4 + 2] = rgb[p * 3 + 2]; rgba[p * 4 + 3] = 255; }
    if (!palette) palette = gif.quantize(rgba, 256);
    enc.writeFrame(gif.applyPalette(rgba, palette), width, height, { palette: frame++ === 0 ? palette : undefined, delay, repeat: 0 });
  };
  const place = (x: any, f: number, moving: boolean) => {
    if (f <= 0 && !moving) return x;
    const e = off(x.id), T = x.transform ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const M = T.slice(); M[12] += e[0] * f; M[13] += e[1] * f; M[14] += e[2] * f;
    return { ...x, transform: M, color: moving ? '#ff8a1f' : x.color };
  };
  for (let w = -1; w < waves.length; w++) {
    for (let i = 0; i <= per; i++) {
      const t = w < 0 ? 1 : 1 - i / per; // ease the current wave in from its exploded position
      const objs = solids.filter((x) => waveOf(x.id) <= w).map((x) => (waveOf(x.id) === w && w >= 0 ? place(x, t * t * (3 - 2 * t), true) : x));
      emit(objs);
      if (w < 0) break;
    }
  }
  for (let i = 0; i < 6; i++) emit(solids);
  enc.finish();
  return enc.bytes();
}

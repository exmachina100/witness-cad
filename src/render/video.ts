// Turntable animation of a built model as an animated GIF (headless, no browser needed).
import * as gifNs from 'gifenc';
import type { RunResult } from '../kernel/runtime';
import { renderRgb, RenderOpts } from './raster';

const gif: any = (gifNs as any).GIFEncoder ? gifNs : (gifNs as any).default;

export function renderTurntableGif(result: RunResult, o: RenderOpts & { frames?: number; elevation?: number; fps?: number } = {}): Uint8Array {
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
    enc.writeFrame(index, width, height, { palette: i === 0 ? palette : undefined, delay, repeat: 0 });
  }
  enc.finish();
  return enc.bytes();
}

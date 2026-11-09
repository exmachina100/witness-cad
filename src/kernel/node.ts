// Node bootstrap: loads the WASM kernel and the default font from node_modules.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initKernel } from './wasm';
import { registerFont } from './text';

let ready: Promise<void> | null = null;
export function initNode(): Promise<void> {
  if (!ready) ready = (async () => {
    await initKernel();
    const req = createRequire(import.meta.url);
    for (const [key, file] of [['Inter', '@fontsource/inter/files/inter-latin-400-normal.woff'], ['Inter Bold', '@fontsource/inter/files/inter-latin-700-normal.woff']] as const) {
      try {
        const buf = readFileSync(req.resolve(file));
        registerFont(key, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), key === 'Inter');
      } catch { /* fonts are optional */ }
    }
  })();
  return ready;
}

let stepReady: Promise<boolean> | null = null;
/** Load OpenCascade's STEP reader (optional dependency occt-import-js) for Import.step. */
export function ensureStepReaderNode(): Promise<boolean> {
  if (!stepReady) stepReady = (async () => {
    try {
      const req = createRequire(import.meta.url);
      const init = req('occt-import-js');
      const { installStepReader } = await import('./stepReader');
      installStepReader(await init());
      return true;
    } catch { return false; }
  })();
  return stepReady;
}

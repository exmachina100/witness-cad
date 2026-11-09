// Loads the Manifold WASM geometry kernel once, in the browser, a worker or Node.
import Module from 'manifold-3d';
import type { ManifoldToplevel } from 'manifold-3d';

let instance: ManifoldToplevel | null = null;
let loading: Promise<ManifoldToplevel> | null = null;

export async function initKernel(wasmUrl?: string): Promise<ManifoldToplevel> {
  if (instance) return instance;
  if (!loading) {
    loading = (async () => {
      const opts: any = {};
      if (wasmUrl) opts.locateFile = () => wasmUrl;
      const m = await (Module as any)(opts);
      m.setup();
      instance = m as ManifoldToplevel;
      return instance;
    })();
  }
  return loading;
}

export function K(): ManifoldToplevel {
  if (!instance) throw new Error('Geometry kernel not initialised. Call initKernel() first.');
  return instance;
}

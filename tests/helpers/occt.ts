// Reads STEP files back with OpenCascade (occt-import-js) so tests can check exported geometry.
import { createRequire } from 'node:module';

export interface StepReadback { ok: boolean; faces: number; meshes: number; volume: number; area: number }

let occt: any = null;
export async function loadOcct() {
  if (occt) return occt;
  const require = createRequire(import.meta.url);
  const init = require('occt-import-js');
  occt = await init();
  return occt;
}

export async function readStep(text: string, deflection = 0.01): Promise<StepReadback> {
  const o = await loadOcct();
  const res = o.ReadStepFile(new TextEncoder().encode(text), {
    linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: deflection, angularDeflection: 0.1,
  });
  let faces = 0, volume = 0, area = 0;
  for (const m of res.meshes ?? []) {
    faces += m.brep_faces?.length ?? 0;
    const p = m.attributes.position.array, ix = m.index.array;
    for (let t = 0; t < ix.length; t += 3) {
      const a = [p[ix[t] * 3], p[ix[t] * 3 + 1], p[ix[t] * 3 + 2]];
      const b = [p[ix[t + 1] * 3], p[ix[t + 1] * 3 + 1], p[ix[t + 1] * 3 + 2]];
      const c = [p[ix[t + 2] * 3], p[ix[t + 2] * 3 + 1], p[ix[t + 2] * 3 + 2]];
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    }
  }
  return { ok: !!res.success, faces, meshes: res.meshes?.length ?? 0, volume, area };
}

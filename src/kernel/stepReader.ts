// Adapts an occt-import-js module to the Import.step reader hook.
import { stepReader } from './importers';

export function installStepReader(occt: any) {
  stepReader.fn = (bytes: Uint8Array) => {
    const res = occt.ReadStepFile(bytes, { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.3 });
    if (!res?.success) throw new Error('STEP file could not be read');
    return (res.meshes ?? []).map((m: any) => ({ positions: Array.from(m.attributes.position.array as ArrayLike<number>), indices: Array.from(m.index.array as ArrayLike<number>), name: m.name, color: m.color }));
  };
}

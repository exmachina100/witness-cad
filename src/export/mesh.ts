// Common mesh preparation for exporters: world-space triangles per object.
import type { SceneObject } from '../kernel/runtime';
import { mat4 } from '../kernel/math';

export interface ExportMesh { name: string; positions: Float32Array; indices: Uint32Array; color: [number, number, number, number]; material?: any }

export function hexToRgba(hex?: string, opacity = 1): [number, number, number, number] {
  if (!hex) return [0.62, 0.66, 0.72, opacity];
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, opacity];
}

export function worldMeshes(objects: SceneObject[], opts: { includeMocks?: boolean; transforms?: Record<string, number[]> } = {}): ExportMesh[] {
  const out: ExportMesh[] = [];
  for (const o of objects) {
    if (o.kind !== 'solid' || !o.mesh) continue;
    if (o.mock && !opts.includeMocks) continue;
    const T = (o.part && opts.transforms?.[o.part]) ?? o.transform;
    let positions = o.mesh.positions;
    if (T) {
      positions = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        const p = mat4.apply(T, [o.mesh.positions[i], o.mesh.positions[i + 1], o.mesh.positions[i + 2]]);
        positions[i] = p[0]; positions[i + 1] = p[1]; positions[i + 2] = p[2];
      }
    }
    out.push({ name: o.name, positions, indices: o.mesh.indices, color: hexToRgba(o.color, o.material?.opacity ?? 1), material: o.material });
  }
  return out;
}

export function merged(meshes: ExportMesh[]): { positions: Float32Array; indices: Uint32Array } {
  const nv = meshes.reduce((s, m) => s + m.positions.length, 0);
  const ni = meshes.reduce((s, m) => s + m.indices.length, 0);
  const positions = new Float32Array(nv), indices = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + vo / 3;
    vo += m.positions.length; io += m.indices.length;
  }
  return { positions, indices };
}

export const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'part';

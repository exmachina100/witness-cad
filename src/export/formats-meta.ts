// Export format catalogue (no kernel imports, safe for the UI thread).
export const EXPORT_FORMATS = {
  '3mf': { label: '3MF (recommended for printing)', ext: '3mf', mime: 'model/3mf', group: 'Mesh' },
  stl: { label: 'STL (binary)', ext: 'stl', mime: 'model/stl', group: 'Mesh' },
  'stl-ascii': { label: 'STL (ASCII)', ext: 'stl', mime: 'model/stl', group: 'Mesh' },
  glb: { label: 'GLB (glTF binary)', ext: 'glb', mime: 'model/gltf-binary', group: 'Mesh' },
  obj: { label: 'OBJ + MTL (zip)', ext: 'zip', mime: 'application/zip', group: 'Mesh' },
  ply: { label: 'PLY', ext: 'ply', mime: 'text/plain', group: 'Mesh' },
  step: { label: 'STEP (faceted B-rep, AP214)', ext: 'step', mime: 'model/step', group: 'CAD' },
  usd: { label: 'USD (usda)', ext: 'usda', mime: 'text/plain', group: 'Simulation' },
  urdf: { label: 'URDF + meshes (zip)', ext: 'zip', mime: 'application/zip', group: 'Simulation' },
  mjcf: { label: 'MJCF / MuJoCo + meshes (zip)', ext: 'zip', mime: 'application/zip', group: 'Simulation' },
  sdf: { label: 'SDF / Gazebo + meshes (zip)', ext: 'zip', mime: 'application/zip', group: 'Simulation' },
  drawing: { label: 'Part drawing (SVG)', ext: 'svg', mime: 'image/svg+xml', group: 'Documents' },
  bom: { label: 'Bill of materials (CSV)', ext: 'csv', mime: 'text/csv', group: 'Documents' },
  package: { label: 'Manufacturing package (zip)', ext: 'zip', mime: 'application/zip', group: 'Documents' },
} as const;

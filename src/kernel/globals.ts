// The global scope a .forge.js script sees.
import * as ops from './ops';
import * as sk from './sketch';
import { path } from './path';
import { Shape, faceProfile, metric } from './shape';
import { Param, param } from './params';
import { verify, spec } from './verify';
import { bom, dim, Manufacturing, sketchToDxf, sketchToSvg } from './output';
import { scene, cutPlane, explodeView, compareWith, mock, Viewport } from './viewport';
import { assembly, Spring, Assembly } from './assembly';
import { Points, TransformExtras, connector, ANCHOR3D_NAMES, SHEET_METAL_EDGES, route, Optics, SimReady, woodJoinery, libNamespace } from './extras';
import { Sim, Fea, PhysicalMaterial, PhysicalProperties } from './sim';
import './physics';
import { Curve, loft, sweep, variableSweep, Loft } from './curves';
import * as lib from './lib';
import { text2d, textWidth, loadFont } from './text';
import { constrainedSketch } from './constraints';
import { Import } from './importers';
import './detail';
import { Laser, SheetMetal, sheetMetal } from './fabrication';
import { Surface, SurfaceBody, SurfaceSheet, Blend, Analysis, Thickness, Sculpt, Product, CarrierNS, SurfaceMembers } from './surfacing';
import { mat4, v3 } from './math';
import { ctx } from './context';

export const Transform = {
  identity: () => mat4.identity(),
  translation: (x: number, y: number, z: number) => mat4.translation(x, y, z),
  rotation: (axis: [number, number, number], deg: number) => mat4.axisAngle(axis, deg),
  scale: (x: number, y = x, z = x) => mat4.scaling(x, y, z),
  multiply: (...ms: number[][]) => ms.reduce((a, b) => mat4.mul(a, b), mat4.identity()),
  invert: (m: number[]) => mat4.invert(m),
  apply: (m: number[], p: [number, number, number]) => mat4.apply(m, p),
  ...TransformExtras,
};

export function buildGlobals(): Record<string, any> {
  return {
    // primitives & booleans
    box: ops.box, roundedBox: ops.roundedBox, cylinder: ops.cylinder, cone: ops.cone, sphere: ops.sphere, torus: ops.torus, wedge: ops.wedge,
    polyhedron: ops.polyhedron, hull: ops.hull, hullPoints: ops.hullPoints,
    union: ops.union, difference: ops.difference, intersection: ops.intersection,
    fillet: ops.fillet, chamfer: ops.chamfer, draft: ops.draft, offsetSolid: ops.offsetSolid,
    linearPattern: ops.linearPattern, circularPattern: ops.circularPattern, mirrorCopy: ops.mirrorCopy,
    circularLayout: ops.circularLayout, polygonVertices: ops.polygonVertices,
    group: ops.group, intersectWithPlane: ops.intersectWithPlane, projectToPlane: ops.projectToPlane, faceProfile,
    // sketches
    path, stroke: sk.stroke, rect: sk.rect, circle2d: sk.circle2d, roundedRect: sk.roundedRect, polygon: sk.polygon, ngon: sk.ngon,
    ellipse: sk.ellipse, slot: sk.slot, arcSlot: sk.arcSlot, spline2d: sk.spline2d, union2d: sk.union2d, difference2d: sk.difference2d,
    intersection2d: sk.intersection2d, linearPattern2d: sk.linearPattern2d, circularPattern2d: sk.circularPattern2d,
    text2d, textWidth, loadFont, constrainedSketch,
    // curves
    Curve, loft, sweep, variableSweep, Loft,
    // params, checks, output
    Param, param, verify, spec, bom, dim, Manufacturing, sketchToDxf, sketchToSvg,
    // scene
    scene, cutPlane, explodeView, compareWith, mock, Viewport,
    // assemblies & physics
    assembly, connector, Spring, Sim, Fea, PhysicalMaterial, PhysicalProperties,
    // library
    tube: lib.tube, pipe: lib.pipe, explode: lib.explode, bracket: lib.bracket, holePattern: lib.holePattern,
    thread: lib.thread, bolt: lib.bolt, nut: lib.nut, washer: lib.washer, fastenerSet: lib.fastenerSet, boltPattern: lib.boltPattern,
    pipeRoute: lib.pipeRoute, elbow: lib.elbow, beltDrive: lib.beltDrive, tangentLoop2d: lib.tangentLoop2d,
    tSlotProfile: lib.tSlotProfile, tSlotExtrusion: lib.tSlotExtrusion, profile2020BSlot6Profile: lib.profile2020BSlot6Profile, profile2020BSlot6: lib.profile2020BSlot6,
    spurGear: lib.spurGear, spurGearProfile: lib.spurGearProfile, bevelGear: lib.bevelGear, faceGear: lib.faceGear, ringGear: lib.ringGear, rackGear: lib.rackGear,
    gearPair: lib.gearPair, bevelGearPair: lib.bevelGearPair, faceGearPair: lib.faceGearPair, gearRatio: lib.gearRatio, rackRatio: lib.rackRatio,
    planetaryRatio: lib.planetaryRatio, sectorGear: lib.sectorGear, gearBodies: lib.gearBodies, driveWheel: lib.driveWheel, readDriveWheelMeta: lib.readDriveWheelMeta,
    hexagon: lib.hexagon, metric, lib: libNamespace,
    Surface, SurfaceBody, SurfaceSheet, Blend, Analysis, Thickness, Sculpt, Product, Carrier: CarrierNS, SurfaceMembers,
    Import, Points, ANCHOR3D_NAMES, SHEET_METAL_EDGES, route, Optics, SimReady,
    // math helpers
    Transform, Vec3: v3, deg: (r: number) => (r * 180) / Math.PI, rad: (d: number) => (d * Math.PI) / 180,
    // classes for instanceof checks
    Shape, Sketch: sk.Sketch, Assembly,
    // Wood.* library: joinery-friendly lumber helpers
    Wood: woodLib(),
    Laser, SheetMetal, sheetMetal,
    get __ctx() { return ctx(); },
  };
}

function woodLib() {
  const board = (length: number, width: number, thickness: number, o: { species?: string; grain?: 'x' | 'y' | 'z' } = {}) =>
    ops.box(length, width, thickness).color(o.species === 'walnut' ? '#5b3a29' : o.species === 'oak' ? '#b08a5a' : '#c9a36b').withMeta({ wood: { species: o.species ?? 'pine', grain: o.grain ?? 'x', length, width, thickness } });
  return {
    board,
    lumber: (nominal: string, length: number) => {
      const table: Record<string, [number, number]> = { '1x2': [19, 38], '1x4': [19, 89], '1x6': [19, 140], '2x2': [38, 38], '2x4': [38, 89], '2x6': [38, 140], '4x4': [89, 89] };
      const [t, w] = table[nominal] ?? [19, 89];
      return board(length, w, t);
    },
    plywood: (w: number, d: number, t = 18) => ops.box(w, d, t).color('#d9b98a').withMeta({ wood: { species: 'plywood', thickness: t } }),
    tenon: (shape: Shape, face: string, o: { length: number; thickness: number; width: number }) => {
      const f = shape.face(face);
      const t = sk.rect(o.width, o.thickness).onFace(shape, face).extrude(o.length);
      return shape.add(t).withMeta({ joinery: [...(shape.meta.joinery ?? []), { kind: 'tenon', face: f.name, ...o }] });
    },
    mortise: (shape: Shape, face: string, o: { depth: number; thickness: number; width: number; clearance?: number }) => {
      const c = o.clearance ?? 0.2;
      return shape.cutout(sk.rect(o.width + c, o.thickness + c).onFace(shape, face), { depth: o.depth });
    },
    ...woodJoinery,
    dowelHole: (shape: Shape, face: string, o: { diameter?: number; depth?: number; u?: number; v?: number } = {}) => shape.hole(face, { diameter: o.diameter ?? 8, depth: o.depth ?? 20, u: o.u, v: o.v }),
  };
}

export const GLOBAL_NAMES = Object.keys(buildGlobals()).filter((k) => !k.startsWith('__'));

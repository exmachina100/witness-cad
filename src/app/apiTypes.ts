// Type declarations fed to the editor so the .forge.js API gets completions and hover docs.
export const API_DTS = `
type Vec2 = [number, number];
type Vec3 = [number, number, number];
type Mat4 = number[];
interface FaceRef { kind: 'face'; name: string; normal: Vec3; center: Vec3; uAxis: Vec3; vAxis: Vec3; area: number; size: [number, number]; planar: boolean; radius?: number }
interface EdgeSegment { kind: 'edge'; start: Vec3; end: Vec3; length: number; convex: boolean }
interface Connector { name?: string; origin: Vec3; axis: Vec3; up: Vec3; kind?: string }
interface BBox { min: Vec3; max: Vec3; size: Vec3; center: Vec3 }
interface HoleOptions { diameter?: number; thread?: string | { designation: string; depth?: number }; clearance?: string; clearanceClass?: 'close' | 'normal' | 'loose'; depth?: number; upToFace?: string | FaceRef; u?: number; v?: number; counterbore?: { diameter: number; depth: number }; countersink?: { diameter: number; angleDeg?: number }; position?: Vec3 }
/** An immutable solid. Units are millimetres, angles degrees, Z up. */
declare class Shape {
  color(value?: string): Shape;
  material(props: { metalness?: number; roughness?: number; opacity?: number; emissive?: string; transmission?: number; ior?: number; clearcoat?: number }): Shape;
  named(name: string): Shape;
  translate(x: number, y?: number, z?: number): Shape;
  translatePolar(radius: number, angleDeg: number, z?: number): Shape;
  rotate(axis: Vec3 | 'x' | 'y' | 'z', angleDeg: number, opts?: { pivot?: Vec3 }): Shape;
  rotateX(deg: number, opts?: { pivot?: Vec3 }): Shape; rotateY(deg: number, opts?: { pivot?: Vec3 }): Shape; rotateZ(deg: number, opts?: { pivot?: Vec3 }): Shape;
  transform(m: Mat4): Shape; scale(v: number | Vec3): Shape; scaleAround(pivot: Vec3, v: number | Vec3): Shape;
  mirror(normal: Vec3): Shape; mirrorThrough(point: Vec3, normal: Vec3): Shape; pointAlong(direction: Vec3): Shape; placeOnFrame(frame: any, opts?: { offset?: Vec3 }): Shape;
  add(...others: Shape[]): Shape; subtract(...others: Shape[]): Shape; intersect(...others: Shape[]): Shape;
  split(cutter: Shape): [Shape, Shape]; splitByPlane(normal: Vec3, offset?: number): [Shape, Shape]; trimByPlane(normal: Vec3, offset?: number): Shape; hull(): Shape;
  boundingBox(): BBox; volume(): number; surfaceArea(): number; centroid(): Vec3; isEmpty(): boolean; minGap(other: Shape, searchLength?: number): number;
  face(selector: string | FaceRef): FaceRef; faces(...selectors: string[]): FaceRef[]; faceNames(): string[];
  edgesOf(face: string | FaceRef, opts?: { exclude?: string[]; convex?: boolean; concave?: boolean; minLength?: number }): EdgeSegment[];
  edgesBetween(a: string | FaceRef, b: string | FaceRef): EdgeSegment[]; edges(opts?: { convex?: boolean; concave?: boolean }): EdgeSegment[];
  as(name: string): Shape; labelFace(name: string, face: string | FaceRef): Shape;
  shell(thickness: number, opts?: { openFaces?: string[] }): Shape;
  pocket(face: string | FaceRef, depth: number, opts?: { inset?: number; scale?: number; join?: 'Square' | 'Round' | 'Miter' }): Shape;
  boss(face: string | FaceRef, height: number, opts?: { inset?: number; sketch?: Sketch }): Shape;
  hole(face: string | FaceRef, opts: HoleOptions): Shape;
  cutout(sketch: Sketch, opts?: { depth?: number; upToFace?: string | FaceRef; taperScale?: number }): Shape;
  withConnectors(c: Record<string, Connector>): Shape; connector(name: string): Connector;
  matchTo(mine: string, target: Connector | Vec3, opts?: { flip?: boolean; offset?: number }): Shape;
  attachTo(target: Shape, targetFace?: string, selfFace?: string, offset?: Vec3): Shape;
  withMeta(meta: Record<string, any>): Shape;
  smoothOut(minSharpAngle?: number): Shape; refine(n: number): Shape; slice(z?: number): Sketch; project(): Sketch;
}
/** A 2D profile in the XY plane. */
declare class Sketch {
  translate(x: number, y?: number): Sketch; rotate(deg: number): Sketch; rotateAround(deg: number, pivot: Vec2): Sketch;
  scale(v: number | Vec2): Sketch; mirror(normal: Vec2): Sketch;
  add(...o: Sketch[]): Sketch; subtract(...o: Sketch[]): Sketch; intersect(...o: Sketch[]): Sketch; hull(): Sketch;
  offset(delta: number, join?: 'Round' | 'Square' | 'Miter'): Sketch; filletCorners(r: number): Sketch; chamferCorners(s: number): Sketch;
  regions(): Sketch[]; region(seed: Vec2): Sketch; area(): number; bounds(): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
  labelEdges(...names: (string | null)[]): Sketch;
  attachTo(target: Sketch, targetAnchor?: string, selfAnchor?: string, offset?: Vec2): Sketch;
  onFace(parent: Shape, face: string, opts?: { u?: number; v?: number; protrude?: number; selfAnchor?: string }): Sketch;
  extrude(height: number | { upToFace?: FaceRef; upToPlane?: { normal: Vec3; offset?: number }; offset?: number }, opts?: { twist?: number; scale?: number | Vec2; center?: boolean; labels?: { start?: string; end?: string } }): Shape;
  revolve(degrees?: number, segments?: number): Shape;
  color(c: string): Sketch;
}
declare class PathBuilder {
  moveTo(x: number, y: number): PathBuilder; lineTo(x: number, y: number): PathBuilder; lineBy(dx: number, dy: number): PathBuilder;
  lineH(dx: number): PathBuilder; lineV(dy: number): PathBuilder; lineAngled(length: number, deg: number): PathBuilder;
  arcTo(x: number, y: number, radius: number, clockwise?: boolean): PathBuilder; tangentArcTo(x: number, y: number): PathBuilder;
  arc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): PathBuilder; arcAround(cx: number, cy: number, sweepDeg: number): PathBuilder;
  bezierTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): PathBuilder; blendTo(x: number, y: number, weight?: number): PathBuilder;
  smoothThrough(points: Vec2[], tension?: number): PathBuilder; nurbsTo(points: Vec2[], o?: { weights?: number[]; degree?: number }): PathBuilder;
  fillet(r: number): PathBuilder; chamfer(d: number): PathBuilder; label(name: string): PathBuilder; mirror(axis: 'x' | 'y' | Vec2): PathBuilder;
  close(): Sketch; stroke(width: number, join?: 'Round' | 'Square'): Sketch; toPolyline(): Vec2[];
}
declare function box(width: number, depth: number, height: number): Shape;
declare function roundedBox(width: number, depth: number, height: number, radius: number): Shape;
declare function cylinder(height: number, radius: number, radiusTop?: number, segments?: number): Shape;
declare function cone(height: number, radius: number, radiusTop?: number, segments?: number): Shape;
declare function sphere(radius: number, segments?: number): Shape;
declare function torus(majorRadius: number, minorRadius: number, segments?: number): Shape;
declare function polyhedron(vertices: Vec3[], faces: number[][]): Shape;
declare function hull(...items: (Shape | Vec3)[]): Shape;
declare function union(...inputs: (Shape | Shape[])[]): Shape;
declare function difference(...inputs: (Shape | Shape[])[]): Shape;
declare function intersection(...inputs: (Shape | Shape[])[]): Shape;
declare function fillet(shape: Shape, radius: number, edges?: string | EdgeSegment[] | FaceRef, options?: { segments?: number }): Shape;
declare function chamfer(shape: Shape, size: number, edges?: string | EdgeSegment[] | FaceRef): Shape;
declare function draft(shape: Shape, angleDeg: number, pullDirection?: Vec3, neutralPlaneOffset?: number): Shape;
declare function offsetSolid(shape: Shape, thickness: number): Shape;
declare function linearPattern(shape: Shape, count: number, dx: number, dy?: number, dz?: number): Shape;
declare function circularPattern(shape: Shape, count: number, centerXOrOpts?: number | { centerX?: number; centerY?: number; axis?: Vec3; origin?: Vec3 }, centerY?: number): Shape;
declare function mirrorCopy(shape: Shape, normal: Vec3): Shape;
declare function circularLayout(count: number, radius: number, opts?: { startDeg?: number; centerX?: number; centerY?: number }): { x: number; y: number; angle: number }[];
declare function polygonVertices(sides: number, radius: number, opts?: { startDeg?: number }): { x: number; y: number }[];
declare function group(...items: (Shape | Sketch | { name: string; shape?: Shape; sketch?: Sketch; group?: any; tags?: string[] })[]): any;
declare function intersectWithPlane(shape: Shape, plane: { normal: Vec3; offset?: number } | 'XY' | 'XZ' | 'YZ'): Sketch;
declare function projectToPlane(shape: Shape, plane: { normal: Vec3 } | 'XY' | 'XZ' | 'YZ'): Sketch;
declare function faceProfile(shape: Shape, face: string | FaceRef): Sketch;
declare function path(): PathBuilder;
declare function rect(width: number, height: number): Sketch;
declare function circle2d(radius: number, segments?: number): Sketch;
declare function roundedRect(width: number, height: number, radius: number): Sketch;
declare function polygon(points: Vec2[]): Sketch;
declare function ngon(sides: number, radius: number): Sketch;
declare function ellipse(rx: number, ry: number, segments?: number): Sketch;
declare function slot(length: number, width: number): Sketch;
declare function arcSlot(pitchRadius: number, sweepDeg: number, thickness: number): Sketch;
declare function stroke(points: Vec2[], width: number, join?: 'Round' | 'Square'): Sketch;
declare function spline2d(points: Vec2[], opts?: { closed?: boolean; tension?: number; samplesPerSegment?: number; strokeWidth?: number }): Sketch;
declare function text2d(content: string, opts?: { size?: number; letterSpacing?: number; align?: 'left' | 'center' | 'right'; baseline?: 'baseline' | 'center' | 'top'; font?: string }): Sketch;
declare function textWidth(content: string, opts?: { size?: number; letterSpacing?: number; font?: string }): number;
declare function union2d(...s: Sketch[]): Sketch; declare function difference2d(...s: Sketch[]): Sketch; declare function intersection2d(...s: Sketch[]): Sketch;
declare function linearPattern2d(s: Sketch, count: number, dx: number, dy?: number): Sketch;
declare function circularPattern2d(s: Sketch, count: number, centerX?: number | { centerX?: number; centerY?: number; startDeg?: number }, centerY?: number): Sketch;
declare function constrainedSketch(opts?: { strict?: boolean }): any;
declare function loft(profiles: Sketch[], heights: number[], opts?: any): Shape;
declare function sweep(profile: Sketch, path: any, opts?: { samples?: number; up?: Vec3 }): Shape;
declare function variableSweep(spine: any, sections: { t: number; profile: Sketch }[], opts?: any): Shape;
declare const Curve: any; declare const Loft: any;
declare const Param: {
  number(name: string, defaultValue: number, opts?: { min?: number; max?: number; step?: number; unit?: string; integer?: boolean }): number;
  string(name: string, defaultValue: string, opts?: { maxLength?: number }): string;
  bool(name: string, defaultValue: boolean): boolean;
  choice<T extends string>(name: string, defaultValue: T, choices: T[]): T;
  list(name: string, defaultItems: any[], opts?: { minItems?: number; maxItems?: number; fields?: any }): any[];
  path2d(name: string, points: Vec2[], opts?: { closed?: boolean }): { points: Vec2[]; toSketch(): Sketch };
  spline2d(name: string, points: Vec2[], opts?: any): { points: Vec2[]; toSketch(): Sketch; toCurveOnXZ(y?: number): any };
  placement2d(name: string, opts: any): { item(id: string): { x: number; y: number; angle: number } };
  variant(name: string, values: Record<string, any>): any;
  anchor: any;
};
declare function param(name: string, defaultValue: number, opts?: any): number;
declare const verify: {
  that(label: string, check: boolean, message?: string): boolean;
  equal(label: string, actual: any, expected: any, tol?: number, message?: string): boolean;
  notEqual(label: string, actual: any, expected: any, tol?: number): boolean;
  greaterThan(label: string, actual: number, min: number): boolean; lessThan(label: string, actual: number, max: number): boolean;
  inRange(label: string, actual: number, min: number, max: number): boolean;
  notColliding(label: string, a: Shape, b: Shape): boolean; minClearance(label: string, a: Shape, b: Shape, minGap: number): boolean;
  clearanceBetween(label: string, a: Shape, b: Shape, minGap: number, maxGap: number): boolean;
  parallel(label: string, a: FaceRef, b: FaceRef, tolDeg?: number): boolean; perpendicular(label: string, a: FaceRef, b: FaceRef, tolDeg?: number): boolean;
  coplanar(label: string, a: FaceRef, b: FaceRef): boolean; faceAt(label: string, face: FaceRef, pos: Vec3, tol?: number): boolean;
  volumeApprox(label: string, s: Shape, expected: number, tol?: number): boolean; areaApprox(label: string, s: Shape, expected: number, tol?: number): boolean;
  boundingBoxSize(label: string, s: Shape, size: Vec3, tol?: number): boolean; centersCoincide(label: string, a: Shape, b: Shape, tol?: number): boolean;
  connectorDistance(label: string, target: any, a: string, b: string, expected?: number, tol?: number): boolean;
  isEmpty(label: string, s: Shape): boolean; notEmpty(label: string, s: Shape): boolean; noSelfIntersection(label: string, s: Shape): boolean;
  noTinyEdges(label: string, s: Shape, min?: number): boolean; noSliverFaces(label: string, s: Shape): boolean; simReady(label: string, asset: any, target?: string): boolean;
};
declare function spec(name: string, check: (...shapes: Shape[]) => void): { check(...s: Shape[]): any };
declare function bom(quantity: number, description: string, opts?: { unit?: string; material?: string; process?: string; dimensions?: number[]; unitPrice?: number; currency?: string; notes?: string; key?: string }): void;
declare const dim: any; declare const Manufacturing: any;
declare function sketchToSvg(s: Sketch, o?: any): string; declare function sketchToDxf(s: Sketch, o?: any): string;
declare function scene(options: { background?: string | { top: string; bottom: string }; camera?: { position?: Vec3; target?: Vec3; fov?: number }; lights?: any[]; fog?: any; environment?: any; ground?: any; capture?: any }): void;
declare function cutPlane(name: string, normal: Vec3, offset?: number, opts?: any): void;
declare function explodeView(opts?: { enabled?: boolean; amountScale?: number }): void;
declare function mock<T>(shape: T, name?: string): T;
declare const Viewport: { label(text: string, at: Vec3, opts?: { color?: string; background?: string; size?: number }): void; highlight(target: any, opts?: any): void };
declare class Assembly {
  addPart(name: string, part: Shape | any, opts?: { transform?: Mat4; metadata?: { tags?: string[]; qty?: number; densityKgM3?: number; massKg?: number }; sim?: any; fea?: any }): Assembly;
  withConnectors(partName: string, connectors: Record<string, Connector>): Assembly;
  connect(parentRef: string, childRef: string, opts?: { as?: string; type?: 'fixed' | 'revolute' | 'prismatic' | 'ball' | 'universal' | 'cylindrical' | 'planar'; min?: number; max?: number; default?: number; follows?: { joint: string; ratio?: number; offset?: number }; drive?: any; along?: any; effort?: number; velocity?: number; damping?: number; friction?: number }): Assembly;
  addPose(name: string, values: Record<string, number>): Assembly;
  addAnimation(name: string, o: { duration?: number; loop?: boolean; keyframes: { at?: number; values?: Record<string, number>; pose?: string }[] }): Assembly;
  addMotionStudy(name: string, o: { joint: string; from: number; to: number; steps: number }): Assembly;
  addSpring(name: string, o: { from: string; to: string; spring: any }): Assembly;
  addCable(name: string, o: { through: string[]; diameter: number; length?: number; color?: string }): Assembly;
  addContact(a: string, b: string): Assembly; probe(name: string, part: string, point: Vec3): Assembly;
  withSimulation(o?: any): Assembly; simulate(o?: { duration?: number; dt?: number; targets?: Record<string, number>; initial?: Record<string, any>; ground?: boolean | { z?: number; friction?: number; restitution?: number }; gravity?: number | [number, number, number]; loads?: any[]; bodyVelocities?: Record<string, { linear?: number[]; angular?: number[] }>; motion?: Record<string, 'dynamic' | 'static' | 'kinematic'> }): any; holdTest(o: { joint: string; load: number; seconds?: number; maxTravel?: number }): any; solve(state?: Record<string, number> | string): any; connectorDistance(a: string, b: string): number;
  sweep(joint: string, o: { from: number; to: number; steps: number }): any; describe(): any; bom(): any[];
}
declare function assembly(name?: string): Assembly;
declare function connector(name: string, opts: { origin: Vec3; axis: Vec3; up?: Vec3; kind?: string }): Connector;
declare const Spring: any; declare const Sim: any; declare const Fea: any; declare const PhysicalMaterial: any; declare const PhysicalProperties: any; declare const Wood: any; declare const Laser: any;
declare function tube(ox: number, oy: number, oz: number, wall: number): Shape;
declare function pipe(height: number, outerRadius: number, wall: number, segments?: number): Shape;
declare function bolt(size: number | string, length: number, opts?: { head?: 'socket' | 'hex' | 'button' | 'flat'; threaded?: boolean }): Shape;
declare function nut(size: number | string, opts?: any): Shape; declare function washer(size: number | string, opts?: any): Shape;
declare function thread(diameter: number, pitch: number, length: number, opts?: any): Shape;
declare function spurGear(o: { module: number; teeth: number; faceWidth: number; pressureAngleDeg?: number; backlash?: number; boreDiameter?: number; helixAngleDeg?: number }): Shape;
declare function gearPair(o: { module: number; teethA: number; teethB: number; faceWidth: number; boreDiameter?: number }): { a: Shape; b: Shape; centerDistance: number; ratio: number };
declare function pipeRoute(points: Vec3[], radius: number, opts?: { bendRadius?: number; wall?: number }): Shape;
declare function bracket(width: number, height: number, depth: number, thick: number, holeDia?: number): Shape;
declare function require(path: string): any;
`;

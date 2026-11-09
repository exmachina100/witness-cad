// Assemblies: parts joined at connectors by typed joints, solved by forward kinematics.
import { ForgeError } from './errors';
import { mat4, Mat4, toVec3, v3, Vec3 } from './math';
import { Connector, connectorFrame, normConnector, Shape, xfConnector } from './shape';
import { ShapeGroup, group } from './ops';
import { ctx } from './context';
import { Curve3D, sweepCircle, polylineCurve, Curve } from './curves';

export type JointType = 'fixed' | 'revolute' | 'prismatic' | 'ball' | 'universal' | 'cylindrical' | 'planar' | 'path';

export interface Joint {
  name: string;
  type: JointType;
  parent: string; parentConn: string;
  child: string; childConn: string;
  min?: number; max?: number; default?: any; unit?: string;
  follows?: { joint: string; ratio?: number; offset?: number };
  driven?: boolean; drive?: any; effort?: number; velocity?: number; damping?: number; friction?: number;
  along?: Curve3D | Vec3[];
  align?: 'start' | 'middle' | 'end';
}

export interface Part {
  name: string;
  shape: Shape | ShapeGroup;
  transform: Mat4;
  metadata: any;
  sim?: any;
  fea?: any;
}

const G = 9.80665;

export function connector(nameOrOpts: any, maybe?: any): Connector {
  if (typeof nameOrOpts === 'string') return normConnector({ ...(maybe ?? {}), name: nameOrOpts }, nameOrOpts);
  return normConnector(nameOrOpts ?? {});
}

export class Assembly {
  readonly kind = 'assembly';
  name: string;
  parts: Part[] = [];
  joints: Joint[] = [];
  extraConnectors: Record<string, Record<string, Connector>> = {};
  asmConnectors: Record<string, Connector> = {};
  springs: { name: string; from: string; to: string; spring: any }[] = [];
  cables: { name: string; through: string[]; diameter: number; [k: string]: any }[] = [];
  animations: Record<string, any> = {};
  poses: Record<string, Record<string, any>> = {};
  motionStudies: Record<string, any> = {};
  contacts: [string, string][] = [];
  probes: Record<string, { part: string; point: Vec3 }> = {};
  simulation: any = null;
  feaStudies: any[] = [];
  references: Record<string, Vec3> = {};
  links: Record<string, any> = {};
  linkEdges: any[] = [];
  usedRefs = new Set<string>();

  constructor(name = 'Assembly') { this.name = name; }

  addPart(name: string, part: any, opts: any = {}): Assembly {
    if (this.parts.some((p) => p.name === name)) throw new ForgeError('ASSEMBLY.DUPLICATE_PART', `part "${name}" already exists`);
    if (part instanceof Assembly || part instanceof SolvedAssembly) {
      // Flatten a sub-assembly: parts become "name/part", joints stay movable as "name/joint".
      const asm = part instanceof SolvedAssembly ? part.assembly : part;
      const base = opts.transform ?? mat4.identity();
      for (const p of asm.parts) {
        this.parts.push({ ...p, name: `${name}/${p.name}`, transform: mat4.mul(base, p.transform) });
        if (asm.extraConnectors[p.name]) this.extraConnectors[`${name}/${p.name}`] = asm.extraConnectors[p.name];
      }
      for (const j of asm.joints) this.joints.push({ ...j, name: `${name}/${j.name}`, parent: `${name}/${j.parent}`, child: `${name}/${j.child}` });
      if (part instanceof SolvedAssembly) for (const j of asm.joints) this.joints[this.joints.length - asm.joints.length + asm.joints.indexOf(j)].default = part.jointValues[j.name];
      return this;
    }
    if (!(part instanceof Shape) && !(part instanceof ShapeGroup)) throw new ForgeError('ASSEMBLY.BAD_PART', `part "${name}" must be a Shape, group or assembly`);
    this.parts.push({ name, shape: part, transform: opts.transform ?? mat4.identity(), metadata: opts.metadata ?? {}, sim: opts.sim, fea: opts.fea });
    return this;
  }

  part(name: string): Part {
    const p = this.parts.find((x) => x.name === name);
    if (!p) throw new ForgeError('ASSEMBLY.NO_PART', `no part "${name}" (have: ${this.parts.map((x) => x.name).join(', ')})`);
    return p;
  }

  withConnectors(a: any, b?: any): Assembly {
    if (typeof a === 'string') {
      const conns: Record<string, Connector> = {};
      for (const [k, c] of Object.entries(b ?? {})) conns[k] = normConnector(c, k);
      this.extraConnectors[a] = { ...(this.extraConnectors[a] ?? {}), ...conns };
    } else {
      for (const [k, c] of Object.entries(a ?? {})) this.asmConnectors[k] = normConnector(c, k);
    }
    return this;
  }

  getConnectors(partName: string): Record<string, Connector> {
    const p = this.part(partName);
    const own = p.shape instanceof Shape ? p.shape.connectors : {};
    return { ...own, ...(this.extraConnectors[partName] ?? {}) };
  }

  /** Resolve "Part.conn" (part names may contain dots or slashes; the last dot splits). */
  splitRef(ref: string): [string, string] {
    const i = ref.lastIndexOf('.');
    if (i < 0) throw new ForgeError('ASSEMBLY.BAD_REF', `connector reference "${ref}" must look like "Part.connector"`);
    return [ref.slice(0, i), ref.slice(i + 1)];
  }

  getConnector(ref: string): Connector {
    const [p, c] = this.splitRef(ref);
    const conns = this.getConnectors(p);
    if (!conns[c]) throw new ForgeError('CONNECTOR.NOT_FOUND', `part "${p}" has no connector "${c}" (have: ${Object.keys(conns).join(', ') || 'none'})`);
    this.usedRefs.add(ref);
    return conns[c];
  }
  get usedConnectorRefs() { return [...this.usedRefs]; }

  connect(parentRef: string, childRef: string, opts: any = {}): Assembly {
    const [parent, parentConn] = this.splitRef(parentRef);
    const [child, childConn] = this.splitRef(childRef);
    this.getConnector(parentRef);
    this.getConnector(childRef);
    const type: JointType = opts.along ? 'path' : opts.type ?? (opts.min != null || opts.max != null ? 'revolute' : 'fixed');
    const name = opts.as ?? `${parent}-${child}`;
    if (this.joints.some((j) => j.name === name)) throw new ForgeError('ASSEMBLY.DUPLICATE_JOINT', `joint "${name}" already exists`);
    if (this.joints.some((j) => j.child === child)) {
      if (!opts.driven) ctx().warnings.push(`part "${child}" already has a parent joint; "${name}" closes a loop and is treated as a constraint`);
    }
    this.joints.push({
      name, type, parent, parentConn, child, childConn,
      min: opts.min, max: opts.max, default: opts.default ?? (opts.min != null && opts.min > 0 ? opts.min : opts.max != null && opts.max < 0 ? opts.max : type === 'fixed' ? undefined : 0),
      unit: opts.unit ?? (type === 'prismatic' || type === 'path' ? 'mm' : 'deg'),
      follows: opts.follows, driven: opts.driven, drive: opts.drive, effort: opts.effort, velocity: opts.velocity,
      damping: opts.damping, friction: opts.friction, along: opts.along, align: opts.align ?? opts.childAlign,
    });
    return this;
  }
  match(childRef: string, parentRef: string, opts: any = {}) { return this.connect(parentRef, childRef, { type: 'fixed', ...opts }); }

  link(name: string, opts: any = {}) { this.links[name] = { name, ...opts }; return this; }
  edgeBetweenLinks(a: string, b: string, opts: any = {}) { this.linkEdges.push({ a, b, ...opts }); return this; }
  addAngleBetweenLinks(a: string, b: string, c: string, opts: any = {}) { this.linkEdges.push({ kind: 'angle', a, b, c, ...opts }); return this; }
  addAngleBetweenLinkSegmentAndWorldDirection(from: string, to: string, direction: Vec3, opts: any = {}) { this.linkEdges.push({ kind: 'worldAngle', from, to, direction, ...opts }); return this; }

  addSpring(name: string, o: { from: string; to: string; spring: any }) { this.springs.push({ name, ...o }); return this; }
  addCable(name: string, o: any) { this.cables.push({ name, ...o }); return this; }
  addPose(name: string, values: Record<string, any>) { this.poses[name] = values; return this; }
  addAnimation(name: string, o: any) {
    this.animations[name] = { duration: 2, loop: true, continuous: false, ...o, name };
    return this;
  }
  addMotionStudy(name: string, o: any) {
    if ((o.steps ?? 0) > 1000) throw new ForgeError('MOTION_STUDY.STEPS', 'motion studies are limited to 1000 steps');
    this.motionStudies[name] = { ...o, name };
    return this;
  }
  addContact(a: string, b: string) { this.contacts.push([a, b]); return this; }
  probe(name: string, partName: string, point: Vec3) { this.probes[name] = { part: partName, point: toVec3(point) }; return this; }
  withSimulation(o: any = {}) { this.simulation = { ...(this.simulation ?? {}), ...o }; return this; }
  withFeaStudy(study: any) { this.feaStudies.push(study); return this; }
  withReferences(o: { points?: Record<string, Vec3> }) { Object.assign(this.references, o.points ?? o); return this; }
  place(def: any, name: string, values?: any) {
    if (def instanceof Assembly) return this.addPart(name, values ? def.solve(values) : def);
    throw new ForgeError('ASSEMBLY.PLACE', 'place() needs an assembly from require()');
  }

  connectorDistance(a: string, b: string, state?: any): number {
    const s = this.solve(state);
    return v3.dist(s.connectorWorld(a).origin, s.connectorWorld(b).origin);
  }

  sweep(jointName: string, o: { from: number; to: number; steps: number; state?: any }) {
    const frames: SolvedAssembly[] = [];
    for (let i = 0; i <= o.steps; i++) {
      const v = o.from + ((o.to - o.from) * i) / o.steps;
      frames.push(this.solve({ ...(o.state ?? {}), [jointName]: v }));
    }
    return { joint: jointName, frames, values: frames.map((_, i) => o.from + ((o.to - o.from) * i) / o.steps) };
  }

  /** Default joint values merged with a state object or pose name. */
  resolveState(state?: any): Record<string, any> {
    const values: Record<string, any> = {};
    for (const j of this.joints) if (j.default !== undefined) values[j.name] = j.default;
    if (typeof state === 'string') {
      if (!this.poses[state]) throw new ForgeError('ASSEMBLY.NO_POSE', `no pose "${state}"`);
      Object.assign(values, this.poses[state]);
    } else if (state) Object.assign(values, state);
    // live joint values from the UI override defaults
    const live = ctx().paramValues[`__joints__${this.name}`];
    if (live && !state) Object.assign(values, live);
    // followers
    for (const j of this.joints) if (j.follows) {
      const lead = values[j.follows.joint] ?? 0;
      values[j.name] = (j.follows.ratio ?? 1) * lead + (j.follows.offset ?? 0);
    }
    return values;
  }

  solve(state?: any): SolvedAssembly {
    const values = this.resolveState(state);
    const transforms = new Map<string, Mat4>();
    const warnings: string[] = [];
    const childJoint = new Map<string, Joint>();
    for (const j of this.joints) if (!childJoint.has(j.child)) childJoint.set(j.child, j);
    const roots = this.parts.filter((p) => !childJoint.has(p.name));
    for (const r of roots) transforms.set(r.name, r.transform);
    const visiting = new Set<string>();
    const place = (name: string): Mat4 => {
      if (transforms.has(name)) return transforms.get(name)!;
      if (visiting.has(name)) throw new ForgeError('ASSEMBLY.CYCLE', `joint cycle through "${name}"`);
      visiting.add(name);
      const j = childJoint.get(name)!;
      const parentT = place(j.parent);
      const pc = this.getConnectorLocal(j.parent, j.parentConn);
      const cc = this.getConnectorLocal(j.child, j.childConn);
      let v = values[j.name];
      if (typeof v === 'number') {
        if (j.min != null && v < j.min) { warnings.push(`joint ${j.name} below min (${v} < ${j.min})`); }
        if (j.max != null && v > j.max) { warnings.push(`joint ${j.name} above max (${v} > ${j.max})`); }
      }
      const motion = jointMotion(j, v);
      const flip = mat4.axisAngle([1, 0, 0], 180);
      const T = mat4.mul(parentT, mat4.mul(connectorFrame(pc), mat4.mul(motion, mat4.mul(flip, mat4.invert(connectorFrame(cc))))));
      transforms.set(name, T);
      visiting.delete(name);
      return T;
    };
    for (const p of this.parts) place(p.name);
    // loop-closing joints: report the gap
    const seen = new Set<string>();
    for (const j of this.joints) {
      if (childJoint.get(j.child) === j && !seen.has(j.child)) { seen.add(j.child); continue; }
      const a = xfConnector(this.getConnectorLocal(j.parent, j.parentConn), transforms.get(j.parent)!);
      const b = xfConnector(this.getConnectorLocal(j.child, j.childConn), transforms.get(j.child)!);
      const gap = v3.dist(a.origin, b.origin);
      if (gap > 1e-3) warnings.push(`loop joint ${j.name} is open by ${gap.toFixed(3)} mm`);
    }
    return new SolvedAssembly(this, transforms, values, warnings);
  }

  getConnectorLocal(part: string, conn: string): Connector {
    const conns = this.getConnectors(part);
    const c = conns[conn];
    if (!c) throw new ForgeError('CONNECTOR.NOT_FOUND', `part "${part}" has no connector "${conn}"`);
    return c;
  }

  describe() {
    return {
      name: this.name,
      parts: this.parts.map((p) => ({ name: p.name, metadata: p.metadata, sim: p.sim, connectors: Object.keys(this.getConnectors(p.name)) })),
      joints: this.joints.map(({ along, ...j }) => j),
      poses: this.poses, animations: this.animations, springs: this.springs.map((s) => s.name), cables: this.cables.map((c) => c.name),
    };
  }
  toGroup(state?: any) { return this.solve(state).toGroup(); }
  getPart(name: string, state?: any) { return this.solve(state).getPart(name); }
  collisionReport(o?: any) { return this.solve().collisionReport(o); }
  minClearance(a: string, b: string, s?: number) { return this.solve().minClearance(a, b, s); }
  referenceNames() { return Object.keys(this.references); }
  child(name: string) { return this.part(name).shape; }
  bom() { return this.solve().bom(); }
}

export function jointMotion(j: Joint, v: any): Mat4 {
  const num = (x: any) => (typeof x === 'number' ? x : 0);
  switch (j.type) {
    case 'revolute': return mat4.axisAngle([0, 0, 1], num(v));
    case 'prismatic': return mat4.translation(0, 0, num(v));
    case 'cylindrical': {
      const o = typeof v === 'object' && v ? v : { angle: num(v), distance: 0 };
      return mat4.mul(mat4.translation(0, 0, o.distance ?? o.d ?? 0), mat4.axisAngle([0, 0, 1], o.angle ?? o.a ?? 0));
    }
    case 'ball': {
      const o = typeof v === 'object' && v ? v : { z: num(v) };
      return mat4.mul(mat4.axisAngle([0, 0, 1], o.z ?? 0), mat4.mul(mat4.axisAngle([0, 1, 0], o.y ?? 0), mat4.axisAngle([1, 0, 0], o.x ?? 0)));
    }
    case 'universal': {
      const o = typeof v === 'object' && v ? v : { a: num(v), b: 0 };
      return mat4.mul(mat4.axisAngle([1, 0, 0], o.a ?? o.x ?? 0), mat4.axisAngle([0, 1, 0], o.b ?? o.y ?? 0));
    }
    case 'planar': {
      const o = typeof v === 'object' && v ? v : { x: num(v), y: 0, angle: 0 };
      return mat4.mul(mat4.translation(o.x ?? 0, o.y ?? 0, 0), mat4.axisAngle([0, 0, 1], o.angle ?? 0));
    }
    case 'path': {
      const curve = Array.isArray(j.along) ? polylineCurve(j.along.map((p) => toVec3(p))) : (j.along as Curve3D);
      const L = curve.length();
      const t = Math.max(0, Math.min(1, num(v) / (L || 1)));
      const p = curve.pointAt(t), tan = curve.tangentAt(t);
      const R = mat4.rotationBetween([0, 0, 1], tan);
      return mat4.mul(mat4.translation(p[0], p[1], p[2]), R);
    }
    default: return mat4.identity();
  }
}

export class SolvedAssembly {
  readonly kind = 'solvedAssembly';
  constructor(public assembly: Assembly, public transforms: Map<string, Mat4>, public jointValues: Record<string, any>, private _warnings: string[]) {}
  get name() { return this.assembly.name; }
  get parts() { return this.assembly.parts; }
  get joints() { return this.assembly.joints; }
  getTransform(part: string): Mat4 {
    const t = this.transforms.get(part);
    if (!t) throw new ForgeError('ASSEMBLY.NO_PART', `no part "${part}"`);
    return t;
  }
  getPart(part: string): Shape | ShapeGroup {
    const p = this.assembly.part(part);
    return (p.shape as any).transform(this.getTransform(part));
  }
  getJointState() { return { ...this.jointValues }; }
  connectorWorld(ref: string): Connector {
    const [p, c] = this.assembly.splitRef(ref);
    return xfConnector(this.assembly.getConnectorLocal(p, c), this.getTransform(p));
  }
  getFrame(ref: string) { return connectorFrame(this.connectorWorld(ref)); }
  get frames() { return Object.fromEntries([...this.transforms.entries()]); }
  getLinkPosition(link: string) { return this.assembly.links[link]?.at ?? [0, 0, 0]; }
  get kinematics() { return { joints: this.assembly.joints.map((j) => ({ name: j.name, type: j.type, value: this.jointValues[j.name] })) }; }
  warnings() { return [...this._warnings]; }

  massOf(part: Part): number {
    const md = part.metadata ?? {}, sim = part.sim ?? {};
    if (md.massKg != null) return md.massKg;
    if (sim.massKg != null) return sim.massKg;
    const density = md.densityKgM3 ?? sim.densityKgM3 ?? sim.material?.densityKgM3 ?? (part.shape as any).meta?.densityKgM3 ?? 1240;
    const vol = part.shape instanceof Shape ? part.shape.volume() : part.shape.toShape().volume();
    return vol * 1e-9 * density;
  }

  /** Static gravity load on a joint: torque (N·m) for rotary joints, force (N) for prismatic. */
  jointLoad(jointName: string): number {
    const j = this.assembly.joints.find((x) => x.name === jointName);
    if (!j) throw new ForgeError('ASSEMBLY.NO_JOINT', `no joint "${jointName}"`);
    const sub = this.subtree(j.child);
    const frame = this.connectorWorld(`${j.child}.${j.childConn}`);
    let total = 0;
    for (const name of sub) {
      const p = this.assembly.part(name);
      const m = this.massOf(p);
      const shape = this.getPart(name);
      const com = shape instanceof Shape ? shape.centroid() : shape.toShape().centroid();
      const F: Vec3 = [0, 0, -m * G];
      if (j.type === 'prismatic') total += v3.dot(F, frame.axis);
      else {
        const r = v3.scale(v3.sub(com, frame.origin), 1e-3);
        total += v3.dot(v3.cross(r, F), frame.axis);
      }
    }
    return total;
  }
  jointLoads() { return Object.fromEntries(this.assembly.joints.filter((j) => j.type !== 'fixed').map((j) => [j.name, this.jointLoad(j.name)])); }
  subtree(part: string): string[] {
    const out = [part];
    for (const j of this.assembly.joints) if (j.parent === part) out.push(...this.subtree(j.child));
    return [...new Set(out)];
  }

  spring(name: string) {
    const s = this.assembly.springs.find((x) => x.name === name);
    if (!s) throw new ForgeError('ASSEMBLY.NO_SPRING', `no spring "${name}"`);
    const a = this.connectorWorld(s.from).origin, b = this.connectorWorld(s.to).origin;
    const length = v3.dist(a, b);
    const sp = s.spring;
    const ext = length - sp.freeLength;
    const force = sp.kind === 'compression' ? Math.max(0, -ext) * sp.rateNPerMm : Math.max(0, ext) * sp.rateNPerMm + (sp.initialTensionN ?? 0);
    return { name, length, extension: ext, force, rateNPerMm: sp.rateNPerMm, from: a, to: b, spec: sp };
  }
  cable(name: string) {
    const c = this.assembly.cables.find((x) => x.name === name);
    if (!c) throw new ForgeError('ASSEMBLY.NO_CABLE', `no cable "${name}"`);
    const pts = c.through.map((r: string) => this.connectorWorld(r).origin);
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += v3.dist(pts[i - 1], pts[i]);
    return { name, points: pts, length: L, slack: c.length != null ? c.length - L : undefined };
  }
  probe(name: string) {
    const p = this.assembly.probes[name];
    if (!p) throw new ForgeError('ASSEMBLY.NO_PROBE', `no probe "${name}"`);
    return mat4.apply(this.getTransform(p.part), p.point);
  }

  toGroup(): ShapeGroup {
    const items: any[] = this.assembly.parts.map((p) => ({ name: p.name, shape: (p.shape as any).transform(this.getTransform(p.name)) }));
    for (const s of this.assembly.springs) items.push({ name: `spring:${s.name}`, shape: springShape(this.spring(s.name)) });
    for (const c of this.assembly.cables) {
      const info = this.cable(c.name);
      if (info.points.length >= 2) items.push({ name: `cable:${c.name}`, shape: sweepCircle(Curve.Fit(info.points), c.diameter / 2, 12).color(c.color ?? '#222222') });
    }
    return group(...items);
  }
  toSceneObjects() { return this.toGroup().children; }

  bom() {
    const rows = new Map<string, any>();
    for (const p of this.assembly.parts) {
      const key = p.metadata?.bomKey ?? p.name.replace(/\s*\d+$/, '');
      const qty = p.metadata?.qty ?? 1;
      const r = rows.get(key) ?? { description: key, quantity: 0, unit: 'pieces', parts: [] as string[], massKg: this.massOf(p) };
      r.quantity += qty;
      r.parts.push(p.name);
      rows.set(key, r);
    }
    return [...rows.values()];
  }

  collisionReport(o: { ignore?: [string, string][]; minVolume?: number } = {}) {
    const shapes = this.assembly.parts.map((p) => ({ name: p.name, shape: (() => { const s = this.getPart(p.name); return s instanceof Shape ? s : s.toShape(); })() }));
    const pairs: { a: string; b: string; volume: number }[] = [];
    const conn = new Set(this.assembly.joints.map((j) => [j.parent, j.child].sort().join('|')));
    for (let i = 0; i < shapes.length; i++)
      for (let k = i + 1; k < shapes.length; k++) {
        const A = shapes[i], B = shapes[k];
        if (o.ignore?.some(([x, y]) => (x === A.name && y === B.name) || (x === B.name && y === A.name))) continue;
        const ba = A.shape.boundingBox(), bb = B.shape.boundingBox();
        if (ba.max.some((v, d) => v < bb.min[d]) || bb.max.some((v, d) => v < ba.min[d])) continue;
        const vol = A.shape.intersect(B.shape).volume();
        if (vol > (o.minVolume ?? 1e-3)) pairs.push({ a: A.name, b: B.name, volume: vol, jointed: conn.has([A.name, B.name].sort().join('|')) } as any);
      }
    return { collisions: pairs, clean: pairs.length === 0 };
  }
  minClearance(a: string, b: string, searchLength = 50) {
    const A = this.getPart(a), B = this.getPart(b);
    const sa = A instanceof Shape ? A : A.toShape(), sb = B instanceof Shape ? B : B.toShape();
    return sa.minGap(sb, searchLength);
  }
}

function springShape(info: { from: Vec3; to: Vec3; spec: any }): Shape {
  const L = Math.max(1e-3, v3.dist(info.from, info.to));
  const sp = info.spec;
  const turns = sp.activeTurns + (sp.endTurns ?? 0) * 2;
  const coil = Curve.Helix.coil({ radius: sp.meanDiameter / 2, pitch: L / Math.max(1, turns), turns, wireRadius: sp.wireDiameter / 2 });
  const R = mat4.rotationBetween([0, 0, 1], v3.sub(info.to, info.from));
  return coil.transform(mat4.mul(mat4.translation(...info.from), R)).color(sp.color ?? '#9aa4ad');
}

export function assembly(name?: string) { return new Assembly(name); }

// ---------------------------------------------------------------- springs
function springRate(o: any) {
  const G = (o.shearModulusGPa ?? 79) * 1000; // N/mm²
  return o.rateNPerMm ?? (G * Math.pow(o.wireDiameter, 4)) / (8 * Math.pow(o.meanDiameter, 3) * o.activeTurns);
}
export const Spring = {
  extension: (o: any) => ({ kind: 'extension', ...o, rateNPerMm: springRate(o), initialTensionN: o.initialTensionN === 'zeroLength' ? springRate(o) * o.freeLength : o.initialTensionN ?? 0 }),
  compression: (o: any) => ({ kind: 'compression', endTurns: 1, ...o, rateNPerMm: springRate(o) }),
  torsion: (o: any) => ({ kind: 'torsion', ...o }),
};

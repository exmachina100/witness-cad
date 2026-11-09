// Robot description exports from an assembly: URDF, MJCF (MuJoCo) and SDF, each zipped with STL meshes.
import { zipSync, strToU8 } from 'fflate';
import type { Assembly } from '../kernel/assembly';
import { connectorFrame, Shape } from '../kernel/shape';
import { mat4, Mat4, v3 } from '../kernel/math';
import { PhysicalProperties } from '../kernel/sim';
import { toStlBinary, escapeXml } from './formats';
import { hexToRgba, safeName } from './mesh';

interface Link { name: string; frame: Mat4; visual: Mat4; shape: Shape; massKg: number; com: number[]; inertia: any; color: [number, number, number, number]; sim?: any }
interface RJoint { name: string; type: string; parent: string; child: string; origin: Mat4; min?: number; max?: number; effort?: number; velocity?: number; damping?: number; friction?: number; drive?: any }

function rpy(m: Mat4): [number, number, number] {
  // R = Rz(yaw) Ry(pitch) Rx(roll)
  const r20 = m[2], r21 = m[6], r22 = m[10], r10 = m[1], r00 = m[0];
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r20)));
  const roll = Math.atan2(r21, r22);
  const yaw = Math.atan2(r10, r00);
  return [roll, pitch, yaw];
}
function quatWXYZ(m: Mat4): [number, number, number, number] {
  const [m00, m10, m20, , m01, m11, m21, , m02, m12, m22] = m;
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4; }
  return [w, x, y, z];
}
const mm = (v: number) => +(v / 1000).toFixed(7);
const xyz = (m: Mat4) => `${mm(m[12])} ${mm(m[13])} ${mm(m[14])}`;
const fmt = (a: number[]) => a.map((v) => +v.toFixed(7)).join(' ');

export function buildRobot(asm: Assembly) {
  const zero: Record<string, any> = {};
  for (const j of asm.joints) zero[j.name] = j.type === 'fixed' ? undefined : 0;
  const solved = asm.solve(zero);
  const childJoint = new Map(asm.joints.map((j) => [j.child, j]));
  const links: Link[] = [];
  const frameOf = new Map<string, Mat4>();
  for (const p of asm.parts) {
    const T = solved.getTransform(p.name);
    const j = childJoint.get(p.name);
    const frame = j ? mat4.mul(solved.getTransform(j.parent), connectorFrame(asm.getConnectorLocal(j.parent, j.parentConn))) : T;
    frameOf.set(p.name, frame);
    const shape0 = p.shape instanceof Shape ? p.shape : p.shape.toShape();
    const visual = mat4.mul(mat4.invert(frame), T);
    const local = shape0.transform(visual);
    const density = p.metadata?.densityKgM3 ?? p.sim?.densityKgM3 ?? p.sim?.material?.densityKgM3 ?? 1240;
    const props = PhysicalProperties.approximate(local, { densityKgM3: density });
    const massKg = p.metadata?.massKg ?? p.sim?.massKg ?? props.massKg;
    const scale = massKg / (props.massKg || 1);
    const inertia = Object.fromEntries(Object.entries(props.inertia).map(([k, v]) => [k, (v as number) * scale]));
    links.push({ name: safeName(p.name), frame, visual, shape: local, massKg, com: props.centerOfMass, inertia, color: hexToRgba(shape0.colorValue), sim: p.sim });
  }
  const joints: RJoint[] = asm.joints.filter((j, i, all) => all.findIndex((k) => k.child === j.child) === i).map((j) => ({
    name: safeName(j.name), type: j.type, parent: safeName(j.parent), child: safeName(j.child),
    origin: mat4.mul(mat4.invert(frameOf.get(j.parent)!), frameOf.get(j.child)!),
    min: j.min, max: j.max, effort: j.effort ?? j.drive?.maxTorqueNm, velocity: j.velocity ?? (j.drive?.maxSpeedRpm ? (j.drive.maxSpeedRpm * 2 * Math.PI) / 60 : undefined),
    damping: j.damping ?? j.drive?.damping, friction: j.friction ?? j.drive?.friction, drive: j.drive,
  }));
  const meshes: Record<string, Uint8Array> = {};
  for (const l of links) meshes[`meshes/${l.name}.stl`] = toStlBinary([{ name: l.name, positions: l.shape.mesh.positions, indices: l.shape.mesh.indices, color: l.color }]);
  return { name: safeName(asm.name), links, joints, meshes };
}

const urdfType = (t: string) => (t === 'revolute' ? 'revolute' : t === 'prismatic' ? 'prismatic' : t === 'cylindrical' ? 'continuous' : t === 'planar' ? 'planar' : t === 'ball' ? 'floating' : 'fixed');
const lim = (j: RJoint) => {
  const rot = j.type !== 'prismatic';
  const k = rot ? Math.PI / 180 : 1 / 1000;
  return { lo: (j.min ?? (rot ? -180 : 0)) * k, hi: (j.max ?? (rot ? 180 : 100)) * k };
};

export function toUrdf(asm: Assembly): Uint8Array {
  const r = buildRobot(asm);
  const x: string[] = [`<?xml version="1.0"?>`, `<robot name="${r.name}">`];
  for (const l of r.links) {
    const vo = `<origin xyz="${xyz(l.visual)}" rpy="${fmt(rpy(l.visual))}"/>`;
    // the mesh file is already expressed in the link frame, so visual origin is identity
    void vo;
    x.push(`  <link name="${l.name}">`,
      `    <inertial><origin xyz="${fmt(l.com.map((c) => c / 1000))}" rpy="0 0 0"/><mass value="${+l.massKg.toFixed(6)}"/><inertia ixx="${l.inertia.ixx}" ixy="${l.inertia.ixy}" ixz="${l.inertia.izx}" iyy="${l.inertia.iyy}" iyz="${l.inertia.iyz}" izz="${l.inertia.izz}"/></inertial>`,
      `    <visual><geometry><mesh filename="package://${r.name}/meshes/${l.name}.stl" scale="0.001 0.001 0.001"/></geometry><material name="${l.name}_mat"><color rgba="${fmt(l.color)}"/></material></visual>`,
      `    <collision><geometry><mesh filename="package://${r.name}/meshes/${l.name}.stl" scale="0.001 0.001 0.001"/></geometry></collision>`,
      `  </link>`);
  }
  for (const j of r.joints) {
    const t = urdfType(j.type);
    const { lo, hi } = lim(j);
    x.push(`  <joint name="${j.name}" type="${t}">`, `    <parent link="${j.parent}"/>`, `    <child link="${j.child}"/>`, `    <origin xyz="${xyz(j.origin)}" rpy="${fmt(rpy(j.origin))}"/>`);
    if (t !== 'fixed') x.push(`    <axis xyz="0 0 1"/>`);
    if (t === 'revolute' || t === 'prismatic') x.push(`    <limit lower="${+lo.toFixed(6)}" upper="${+hi.toFixed(6)}" effort="${j.effort ?? 10}" velocity="${j.velocity ?? 3}"/>`);
    if (j.damping != null || j.friction != null) x.push(`    <dynamics damping="${j.damping ?? 0}" friction="${j.friction ?? 0}"/>`);
    x.push(`  </joint>`);
  }
  x.push(`</robot>`);
  return zipSync({ [`${r.name}/${r.name}.urdf`]: strToU8(x.join('\n')), ...Object.fromEntries(Object.entries(r.meshes).map(([k, v]) => [`${r.name}/${k}`, v])) });
}

export function toMjcf(asm: Assembly): Uint8Array {
  const r = buildRobot(asm);
  const children = new Map<string, RJoint[]>();
  for (const j of r.joints) children.set(j.parent, [...(children.get(j.parent) ?? []), j]);
  const roots = r.links.filter((l) => !r.joints.some((j) => j.child === l.name));
  const assets = r.links.map((l) => `    <mesh name="${l.name}" file="meshes/${l.name}.stl" scale="0.001 0.001 0.001"/>`);
  const mats = r.links.map((l) => `    <material name="${l.name}_mat" rgba="${fmt(l.color)}"/>`);
  const actuators: string[] = [];
  const body = (l: Link, origin: Mat4 | null, j: RJoint | null, indent: string): string[] => {
    const pose = origin ?? l.frame;
    const out = [`${indent}<body name="${l.name}" pos="${xyz(pose)}" quat="${fmt(quatWXYZ(pose))}">`];
    if (!j && (l.sim?.motion?.kind ?? 'dynamic') === 'dynamic' && roots.length && !origin && asm.simulation?.floating) out.push(`${indent}  <freejoint/>`);
    if (j && j.type !== 'fixed') {
      const t = j.type === 'prismatic' ? 'slide' : j.type === 'ball' ? 'ball' : 'hinge';
      const { lo, hi } = lim(j);
      const range = j.type === 'revolute' || j.type === 'prismatic' ? ` range="${+lo.toFixed(6)} ${+hi.toFixed(6)}" limited="true"` : '';
      const stiff = j.drive?.kind === 'torsionSpring' ? ` stiffness="${j.drive.stiffnessNmPerDeg * (180 / Math.PI)}" springref="${((j.drive.restDeg ?? 0) * Math.PI) / 180}"` : j.drive?.kind === 'linearSpring' ? ` stiffness="${j.drive.stiffnessNPerMm * 1000}"` : '';
      out.push(`${indent}  <joint name="${j.name}" type="${t}" axis="0 0 1"${range}${stiff} damping="${j.damping ?? 0.01}" frictionloss="${j.friction ?? 0}"/>`);
      if (j.drive?.kind === 'servo') actuators.push(`    <position name="${j.name}_servo" joint="${j.name}" kp="${(j.drive.stiffnessNmPerDeg ?? 1) * (180 / Math.PI)}" forcerange="-${j.drive.maxTorqueNm ?? 1} ${j.drive.maxTorqueNm ?? 1}" forcelimited="true"/>`);
      if (j.drive?.kind === 'velocity') actuators.push(`    <velocity name="${j.name}_vel" joint="${j.name}" kv="1" forcerange="-${j.drive.maxTorqueNm ?? 1} ${j.drive.maxTorqueNm ?? 1}" forcelimited="true"/>`);
    }
    out.push(`${indent}  <inertial pos="${fmt(l.com.map((c) => c / 1000))}" mass="${Math.max(1e-6, l.massKg)}" fullinertia="${l.inertia.ixx} ${l.inertia.iyy} ${l.inertia.izz} ${l.inertia.ixy} ${l.inertia.izx} ${l.inertia.iyz}"/>`);
    out.push(`${indent}  <geom type="mesh" mesh="${l.name}" material="${l.name}_mat"/>`);
    for (const cj of children.get(l.name) ?? []) out.push(...body(r.links.find((x) => x.name === cj.child)!, cj.origin, cj, indent + '  '));
    out.push(`${indent}</body>`);
    return out;
  };
  const world: string[] = [];
  for (const root of roots) world.push(...body(root, null, null, '    '));
  const contacts = asm.contacts.map(([a, b]) => `    <pair geom1="${safeName(a)}" geom2="${safeName(b)}"/>`);
  const xml = [`<mujoco model="${r.name}">`, `  <compiler angle="radian" meshdir="."/>`, `  <option gravity="0 0 -9.81" timestep="0.002"/>`,
    `  <asset>`, ...assets, ...mats, `  </asset>`, `  <worldbody>`, `    <light pos="0 0 3" dir="0 0 -1"/>`, `    <geom name="floor" type="plane" size="5 5 0.1" rgba="0.9 0.9 0.9 1"/>`, ...world, `  </worldbody>`,
    ...(actuators.length ? [`  <actuator>`, ...actuators, `  </actuator>`] : []), ...(contacts.length ? ['  <contact>', ...contacts, '  </contact>'] : []), `</mujoco>`].join('\n');
  return zipSync({ [`${r.name}/${r.name}.xml`]: strToU8(xml), ...Object.fromEntries(Object.entries(r.meshes).map(([k, v]) => [`${r.name}/${k}`, v])) });
}

export function toSdf(asm: Assembly): Uint8Array {
  const r = buildRobot(asm);
  const x = [`<?xml version="1.0"?>`, `<sdf version="1.9">`, `  <model name="${r.name}">`];
  for (const l of r.links) {
    const [ro, pi, ya] = rpy(l.frame);
    x.push(`    <link name="${l.name}">`, `      <pose>${xyz(l.frame)} ${fmt([ro, pi, ya])}</pose>`,
      `      <inertial><pose>${fmt(l.com.map((c) => c / 1000))} 0 0 0</pose><mass>${l.massKg}</mass><inertia><ixx>${l.inertia.ixx}</ixx><ixy>${l.inertia.ixy}</ixy><ixz>${l.inertia.izx}</ixz><iyy>${l.inertia.iyy}</iyy><iyz>${l.inertia.iyz}</iyz><izz>${l.inertia.izz}</izz></inertia></inertial>`,
      `      <visual name="visual"><geometry><mesh><uri>meshes/${l.name}.stl</uri><scale>0.001 0.001 0.001</scale></mesh></geometry><material><diffuse>${fmt(l.color)}</diffuse></material></visual>`,
      `      <collision name="collision"><geometry><mesh><uri>meshes/${l.name}.stl</uri><scale>0.001 0.001 0.001</scale></mesh></geometry></collision>`, `    </link>`);
  }
  for (const j of r.joints) {
    const t = j.type === 'prismatic' ? 'prismatic' : j.type === 'revolute' ? 'revolute' : j.type === 'ball' ? 'ball' : j.type === 'cylindrical' ? 'continuous' : 'fixed';
    const { lo, hi } = lim(j);
    x.push(`    <joint name="${j.name}" type="${t}">`, `      <parent>${j.parent}</parent>`, `      <child>${j.child}</child>`);
    if (t === 'revolute' || t === 'prismatic' || t === 'continuous') x.push(`      <axis><xyz expressed_in="${j.child}">0 0 1</xyz>${t !== 'continuous' ? `<limit><lower>${lo}</lower><upper>${hi}</upper></limit>` : ''}<dynamics><damping>${j.damping ?? 0}</damping><friction>${j.friction ?? 0}</friction></dynamics></axis>`);
    x.push(`    </joint>`);
  }
  x.push(`  </model>`, `</sdf>`);
  return zipSync({ [`${r.name}/model.sdf`]: strToU8(x.join('\n')), [`${r.name}/model.config`]: strToU8(`<?xml version="1.0"?><model><name>${escapeXml(r.name)}</name><version>1.0</version><sdf version="1.9">model.sdf</sdf><description>Exported from Witness CAD</description></model>`), ...Object.fromEntries(Object.entries(r.meshes).map(([k, v]) => [`${r.name}/${k}`, v])) });
}

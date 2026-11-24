// Mechanism report (`witness sim mechanism`): degrees of freedom, static hold load on each
// driven joint at the requested pose and across its range, and the drive's effort margin.
import type { Assembly } from './assembly';

const DOF: Record<string, number> = { fixed: 0, revolute: 1, prismatic: 1, path: 1, cylindrical: 2, universal: 2, planar: 3, ball: 3 };

export interface DriveReport { joint: string; type: string; unit: 'N·m' | 'N'; holdLoad: number; worstLoad: number; worstAt?: number; limit?: number; marginPct?: number; pass?: boolean }
export interface MechanismReport { assembly: string; dof: number; joints: { name: string; type: string; dof: number; coupled: boolean }[]; drives: DriveReport[]; pass: boolean; notes: string[] }

/** values: joint values (names may be "joint" or "assembly.joint"). minMarginPct: required (limit - load) / limit. */
export function mechanismReport(name: string, asm: Assembly, values: Record<string, any> = {}, o: { minMarginPct?: number; samples?: number } = {}): MechanismReport {
  const notes: string[] = [];
  const state: Record<string, any> = {};
  for (const [k, v] of Object.entries(values)) {
    const key = asm.joints.some((j) => j.name === k) ? k : k.startsWith(`${name}.`) ? k.slice(name.length + 1) : k;
    if (!asm.joints.some((j) => j.name === key)) { notes.push(`unknown joint "${k}" ignored`); continue; }
    state[key] = v;
  }
  const solved = asm.solve(state);
  const joints = asm.joints.map((j) => ({ name: j.name, type: j.type, coupled: !!j.follows, dof: j.follows ? 0 : DOF[j.type] ?? 1 }));
  const dof = joints.reduce((s, j) => s + j.dof, 0);
  const minMargin = o.minMarginPct ?? 0, n = o.samples ?? 13;
  const drives: DriveReport[] = [];
  for (const j of asm.joints) {
    if (j.type === 'fixed' || j.follows) continue;
    const d: any = j.drive ?? {};
    const prism = j.type === 'prismatic';
    const limit: number | undefined = prism ? d.maxForceN ?? j.effort : d.maxTorqueNm ?? j.effort;
    if (!j.drive && limit == null) continue; // only driven joints
    const hold = solved.jointLoad(j.name);
    let worst = Math.abs(hold), worstAt: number | undefined = solved.getJointState()[j.name];
    if (j.min != null && j.max != null && typeof worstAt === 'number') {
      for (let i = 0; i < n; i++) {
        const v = j.min + ((j.max - j.min) * i) / (n - 1);
        const t = Math.abs(asm.solve({ ...state, [j.name]: v }).jointLoad(j.name));
        if (t > worst) { worst = t; worstAt = v; }
      }
    }
    const marginPct = limit ? ((limit - worst) / limit) * 100 : undefined;
    drives.push({ joint: j.name, type: j.type, unit: prism ? 'N' : 'N·m', holdLoad: +hold.toFixed(4), worstLoad: +worst.toFixed(4), worstAt, limit, marginPct: marginPct == null ? undefined : +marginPct.toFixed(1), pass: marginPct == null ? undefined : marginPct >= minMargin });
  }
  if (!drives.length) notes.push('no driven joints: declare Sim.drive.servo({ maxTorqueNm }) or a joint effort to get hold margins');
  return { assembly: name, dof, joints, drives, pass: drives.every((d) => d.pass !== false), notes };
}

import { beforeAll, describe, expect, it } from 'vitest';
import { initNode } from '../src/kernel/node';
import { runProject } from '../src/kernel/runtime';
import { checkAssemblySteps } from '../src/kernel/assembly-steps';

beforeAll(async () => { await initNode(); });
const run = (src: string) => { const r = runProject({ files: { 'main.forge.js': src } }, {}); if (!r.ok) throw new Error(r.error?.message); return r; };

const MODEL = (capDir: string) => `
  const base = box(40, 40, 10).subtract(cylinder(20, 5).translate(0, 0, -5)).named('base');
  const shaft = cylinder(30, 4.9).named('shaft').withAssemblyStep({ direction: 'z', title: 'Insert the shaft' });
  const cap = box(20, 20, 3).translate(0, 0, 30).named('cap').withAssemblyStep({ direction: ${capDir}, note: 'Press down' });
  return [base, shaft, cap];`;

describe('assembly steps', () => {
  it('orders steps, explodes along them and finds a clear removal', () => {
    const r = run(MODEL("'z'"));
    expect(r.assemblySteps!.steps.map((s) => s.title)).toEqual(['Insert the shaft', 'Insert cap']);
    expect(r.assemblySteps!.base).toEqual(['base']);
    const cap = r.objects.find((o) => o.name === 'cap')!, base = r.objects.find((o) => o.name === 'base')!;
    expect(cap.stepExplode![2]).toBeGreaterThan(r.objects.find((o) => o.name === 'shaft')!.stepExplode![2]);
    expect(base.stepExplode).toEqual([0, 0, 0]);
    expect(checkAssemblySteps(r).diagnostics).toEqual([]);
  });
  it('reports a step that passes through a placed part', () => {
    const d = checkAssemblySteps(run(MODEL("'-z'"))).diagnostics;
    expect(d.map((x) => x.code)).toEqual(['ASSEMBLY.STEP.PASSES_THROUGH']);
    expect(d[0].obstacles).toContain('shaft');
  });
  it('directions travel with transforms and sub-assemblies move as one unit', () => {
    const r = run(`
      const housing = box(60, 60, 4).named('housing');
      const motor = group({ name: 'body', shape: cylinder(10, 6).translate(0,0,4) }, { name: 'gear', shape: cylinder(2, 10).translate(0,0,14).withAssemblyStep({ direction: 'z' }) })
        .withAssemblyStep({ direction: 'x', title: 'Slide the motor in' });
      const pin = cylinder(10, 1).named('pin').withAssemblyStep({ direction: 'z' }).rotateY(-90);
      return [housing, motor, pin.translate(0, 20, 6)];`);
    const s = r.assemblySteps!.steps;
    expect(s.map((x) => x.kind)).toEqual(['part', 'subAssembly', 'part']);
    expect(s[1].parts.length).toBe(2);
    expect(s[2].direction.map((v) => Math.round(v) + 0)).toEqual([-1, 0, 0]);
  });
  it('NO_STEPS info when nothing has a step, and pages validate', () => {
    expect(checkAssemblySteps(run('return box(1,1,1);')).diagnostics[0].code).toBe('ASSEMBLY.NO_STEPS');
    const r = runProject({ files: { 'main.forge.js': "return box(1,1,1).withInstructionPage({ title: '', text: 'x' });" } }, {});
    expect(r.ok).toBe(false);
  });
});

describe('build guide and mechanism report', () => {
  it('writes instructions.pdf with a page per step', async () => {
    const { buildGuidePdf } = await import('../src/export/guide');
    const r = run(MODEL("'z'").replace("named('cap')", "named('cap').withInstructionPage({ title: 'Before you start', text: 'Lay out the parts.' })"));
    const pdf = buildGuidePdf(r, { title: 'Test' })!;
    const txt = new TextDecoder('latin1').decode(pdf);
    expect(txt.startsWith('%PDF-1.4')).toBe(true);
    expect((txt.match(/\/Type \/Page /g) ?? []).length).toBe(4); // cover, instruction page, two steps
    expect(buildGuidePdf(run('return box(1,1,1);'))).toBeNull();
  });
  it('reports DOF, hold loads and drive margins', async () => {
    const { mechanismReport } = await import('../src/kernel/mechanism');
    const { live } = await import('../src/kernel/runtime');
    run(`const a = assembly('Arm').addPart('Base', box(20,20,10).withConnectors({ top: connector({ origin: [0,0,10], axis: [0,1,0] }) }))
      .addPart('Link', box(100,10,10).translate(50,0,5).withConnectors({ root: connector({ origin: [0,0,5], axis: [0,1,0] }) }))
      .connect('Base.top', 'Link.root', { as: 'lift', type: 'revolute', min: -90, max: 90, default: 0, drive: Sim.drive.servo({ maxTorqueNm: 0.2 }) });
      return a;`);
    const rep = mechanismReport('Arm', live.assemblies.get('Arm')!, { lift: 0 }, { minMarginPct: 20 });
    expect(rep.dof).toBe(1);
    expect(rep.drives[0].joint).toBe('lift');
    expect(rep.drives[0].worstLoad).toBeGreaterThan(0);
    expect(typeof rep.drives[0].marginPct).toBe('number');
  });
});

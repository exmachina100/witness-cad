import { beforeAll, describe, expect, it } from 'vitest';
import { initNode } from '../src/kernel/node';
import { runProject } from '../src/kernel/runtime';
import { combinationSpace, combinationValues, combinationIndex, samplePlan, checkCombinations, checkVariants, describeSpace } from '../src/kernel/combinations';
import { viewDirection } from '../src/render/raster';

beforeAll(async () => { await initNode(); });
const build = (src: string, set: Record<string, any> = {}) => runProject({ files: { 'main.forge.js': src } }, set);

describe('scene()', () => {
  it('normalises views, journeys, environment, ground and capture', () => {
    const r = build(`scene({ views: { hero: { position: [100, -100, 80], target: [0,0,0] }, side: { camera: { position: 'right' } } },
      journeys: { tour: { title: 'Tour', behavior: 'auto', steps: [{ id: 'a', focus: 'lid', caption: 'The lid' }, { id: 'b', camera: 'hero' }, { id: 'c', focus: 'nope' }] } },
      environment: { preset: 'sunset' }, ground: { visible: true }, capture: { framesPerTurn: 24, size: '320x240' }, postProcessing: { bloom: true } });
      return [box(10,10,10).named('base'), box(10,10,2).translate(0,0,10).named('lid')];`);
    expect(r.ok).toBe(true);
    const sc = r.scene;
    expect(Object.keys(sc.views)).toEqual(['hero', 'side']);
    expect(sc.views.side.camera.position).toBe('right');
    const j = sc.journeys.tour;
    expect(j.steps[0].resolvedFocusPath).toEqual(['lid']);
    expect(j.steps[1].camera.position).toEqual([100, -100, 80]);
    expect(j.valid).toBe(false);
    expect(r.warnings.some((w: string) => w.includes('nope'))).toBe(true);
    expect(sc.environment.sky).toBeTruthy();
    expect(sc.capture).toMatchObject({ framesPerTurn: 24, size: [320, 240] });
    expect(sc.inactive).toEqual(['postProcessing']);
    expect(viewDirection(r, 'hero').map((v) => Math.sign(v))).toEqual([1, -1, 1]);
    expect(viewDirection(r, 'front-right')).toEqual([1, -1, 0]);
  });
});

const SRC = `const w = Param.number("Width", 40, { min: 20, max: 60, step: 10 });
  const h = Param.choice("Handle", "round", ["round", "square"]);
  const hollow = Param.bool("Hollow", false);
  Param.bool("Mode", true, { combination: false });
  Param.number("Auto", 5, { min: 0, max: 10 });
  Param.variant("Long reach", { Width: 60 });
  Param.variant("Broken", { Depth: 3 });
  return box(w, 20, 10).translate(0, 0, hollow ? 1 : 0).color(h === 'round' ? '#f00' : '#0f0');`;

describe('combinations', () => {
  it('indexes parameters with defaults at 0 and the first parameter fastest', () => {
    const r = build(SRC);
    const s = combinationSpace(r.params);
    expect(s.factors.map((f) => [f.name, f.count])).toEqual([['Width', 5], ['Handle', 2], ['Hollow', 2], ['Auto', 101]]);
    expect(s.factors[3].autoStep).toBe(true);
    expect(s.held).toEqual(['Mode']);
    expect(combinationValues(s, 0)).toEqual({ Width: 40, Handle: 'round', Hollow: false, Auto: 5 });
    expect(combinationValues(s, 1).Width).toBe(50);
    expect(combinationValues(s, 5).Handle).toBe('square');
    expect(combinationIndex(s, combinationValues(s, 777))).toBe(777);
    expect(describeSpace(s)).toContain('combination 0 of 2,020');
  });
  it('samples large spaces and reports identical geometry and variant problems', () => {
    const r = build(SRC);
    const s = combinationSpace(r.params);
    const plan = samplePlan(s);
    expect(plan.exhaustive).toBe(false);
    expect(plan.indices).toContain(0);
    expect(plan.indices).toContain(s.total - 1);
    const res = checkCombinations((v) => build(SRC, v), r, { indices: [0, 5] });
    expect(res.issues.map((i) => i.code)).toEqual(['COMBINATION.IDENTICAL']); // Handle only changes colour
    const v = checkVariants((vals) => build(SRC, vals), r);
    expect(v.variants.map((x) => x.ok)).toEqual([true, false]);
  });
});
